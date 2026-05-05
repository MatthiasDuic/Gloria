import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";

// buildBasePrompt and generateReply removed — dead code.
// Live path is exclusively streamReply (sentence-level LLM→TTS pipeline).

export type TurnOutput = {
  reply: string;
  hangup: boolean;
};

/**
 * Pre-warmt den TLS/HTTP-Pool zu OpenAI, damit die ALLERERSTE LLM-Antwort
 * nicht ~300–600 ms Handshake-Latenz hat. Wird beim "start"-Event eines
 * Calls aufgerufen, blockiert NICHT den Call. Fehler werden geschluckt.
 */
export function prewarmOpenAi(): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  void fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
    .then((res) => {
      // Body draining ist wichtig damit die Connection im Pool bleibt.
      void res.text().catch(() => undefined);
      log.info("llm.prewarm_ok", { status: res.status });
    })
    .catch(() => {
      /* ignore – best effort */
    });
}

export async function streamReply(
  ctx: CallContext,
  userText: string,
  onSentence: (sentence: string) => void,
): Promise<TurnOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildSystemPrompt(ctx) },
    {
      role: "system",
      content:
        'Antworte ausschließlich als JSON: {"reply": "deutscher Antworttext", "hangup": false}. ' +
        'Setze hangup=true nur, wenn der Anrufende ein klares Nein, Stornieren oder Auflegen signalisiert oder das Gespräch sauber beendet wurde.',
    },
  ];
  for (const turn of ctx.transcript.slice(-12)) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userText });

  const requestBody = {
    model,
    messages,
    temperature: 0.55,
    max_tokens: 280,
    response_format: { type: "json_object" },
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  // Streaming-State für inkrementelles Reply-Extrahieren.
  let assembled = "";
  let phase: "before" | "in" | "after" = "before";
  let escapeNext = false;
  let pendingFlush = "";
  let replyText = "";
  let scanPos = 0;

  const flushSentence = () => {
    const out = pendingFlush.trim();
    pendingFlush = "";
    if (out.length > 0) {
      try {
        onSentence(out);
      } catch (err) {
        log.error("llm.onSentence_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const consume = (delta: string): void => {
    assembled += delta;
    while (scanPos < assembled.length) {
      const ch = assembled[scanPos++];
      if (phase === "before") {
        const m = /"reply"\s*:\s*"/.exec(assembled.slice(0, scanPos));
        if (m && m.index + m[0].length === scanPos) {
          phase = "in";
        }
      } else if (phase === "in") {
        if (escapeNext) {
          if (ch === "n") {
            replyText += "\n";
            pendingFlush += "\n";
          } else if (ch === "t" || ch === "r") {
            replyText += " ";
            pendingFlush += " ";
          } else {
            replyText += ch;
            pendingFlush += ch;
          }
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (ch === '"') {
          phase = "after";
          flushSentence();
        } else {
          replyText += ch;
          pendingFlush += ch;
          // Satzgrenze: Satzzeichen + ausreichend Kontext, NICHT bei Abkürzungen.
          if (/[.!?]/.test(ch) && pendingFlush.length >= 8) {
            // Schutz gegen Abkürzungen: "z." / "B." / "Hr." / "Fr." / Ordinalia.
            const tail = replyText.slice(-3).toLowerCase();
            const isAbbrev =
              /\b(z|b|hr|fr|dr|st|ca|bzw|usw|inkl|ggf|evtl|nr|tel|app)\.$/i.test(replyText) ||
              /\b\d+\.$/.test(replyText) || // Ordinalzahlen "30.", "12."
              tail.endsWith(" z.") ||
              tail.endsWith(" b.");
            if (!isAbbrev) flushSentence();
          }
        }
      }
    }
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const body = res.body ? await res.text() : "";
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) consume(delta);
        } catch {
          /* heartbeat / non-json */
        }
      }
    }
    // Restpuffer flushen, falls der Reply ohne Satzzeichen endete.
    if ((phase as string) !== "before") flushSentence();

    let hangup = false;
    try {
      const parsed = JSON.parse(assembled) as { hangup?: boolean; reply?: string };
      hangup = Boolean(parsed.hangup);
      if (parsed.reply && !replyText) replyText = parsed.reply;
    } catch {
      /* fallback: replyText was scanner-extracted, hangup defaults to false */
    }

    let reply = replyText.trim() || "Entschuldigung, könnten Sie das bitte wiederholen?";
    if (consentAlreadyGranted(ctx) && /aufzeichn/i.test(reply)) {
      reply = stripConsentQuestion(reply);
    }
    return { reply, hangup };
  } catch (error) {
    log.error("llm.stream_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      reply: replyText.trim() || "Einen Moment bitte, ich habe Sie kurz nicht verstanden.",
      hangup: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function consentAlreadyGranted(ctx: CallContext): boolean {
  // Suche im Transkript: Gloria hat "aufzeichnen" gefragt UND danach hat der
  // Anrufende mit JA / okay / einverstanden geantwortet.
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant" || !/aufzeichn/i.test(t.text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      if (turns[j].role !== "user") continue;
      const ans = turns[j].text.toLowerCase().trim();
      if (/^(ja\b|jawohl|gerne|in ordnung|einverstanden|okay|ok\b|geht klar|kein problem)/i.test(ans)) {
        return true;
      }
      break;
    }
  }
  return false;
}

function stripConsentQuestion(text: string): string {
  // Entferne ganze Sätze, die nach Aufzeichnungs-Einwilligung fragen.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => !/aufzeichn/i.test(s) && !/\bja\s+oder\s+nein\b/i.test(s));
  const result = filtered.join(" ").trim();
  if (result) return result;
  // Wenn die LLM-Antwort komplett aus der Aufzeichnungs-Frage bestand
  // (z. B. nach Termin-Bestätigung), gib eine neutrale Brücke zurück, damit
  // der Anruf weiterläuft, ohne die Einwilligung erneut einzufordern.
  return "Vielen Dank. Lassen Sie uns gleich mit einigen kurzen Basisangaben weitermachen.";
}

function buildSystemPrompt(ctx: CallContext): string {
  const company = ctx.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel";
  const owner = ctx.ownerRealName?.trim() || "Matthias Duic";
  const ownerDative = /^Herr(n|n\b|n\s)/i.test(owner) ? owner : `Herrn ${owner}`;
  const parts = [buildLeanCorePrompt(company, owner, ownerDative)];
  parts.push(buildPhasePrompt(ctx, owner, ownerDative));
  const topicLower = (ctx.topic || "").toLowerCase();
  if (/pkv|kranken/.test(topicLower)) {
    parts.push("\n\n" + buildPKVContextBlock(owner, ownerDative));
  }
  const today = new Date();
  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });
  parts.push(`Heute ist ${todayStr}. Nutze dieses Datum, um konkrete Wochentage und Daten für Terminvorschläge zu berechnen.`);
  if (ctx.ownerRealName) parts.push(`Du sprichst im Auftrag von ${ctx.ownerRealName}. Wenn du dich vorstellst oder gefragt wirst, in wessen Auftrag du anrufst, nenne IMMER ${ctx.ownerRealName} – NIEMALS den Namen des gewünschten Ansprechpartners.`);
  if (ctx.ownerCompanyName) parts.push(`Auftraggeber: ${ctx.ownerCompanyName}.`);
  if (ctx.ownerGesellschaft) {
    parts.push(
      `\n\nGESELLSCHAFT (nur auf Nachfrage erwähnen): ${ctx.ownerRealName || "der Auftraggeber"} ist für die Gesellschaft "${ctx.ownerGesellschaft}" tätig. ` +
      `WICHTIG: Erwähne diese Information NUR, wenn der Anrufende ausdrücklich danach fragt (z. B. "Zu welcher Gesellschaft gehören Sie?", "Für wen arbeitet ${ctx.ownerRealName || "Herr Duic"}?", "Welche Versicherung?"). ` +
      `Sage in dem Fall: "${ctx.ownerRealName || "Der Auftraggeber"} ist für die Gesellschaft ${ctx.ownerGesellschaft} tätig." ` +
      `Bei der Vorstellung, im Smalltalk oder unaufgefordert: ERWÄHNE DIE GESELLSCHAFT NICHT.`,
    );
  }
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.contactName) parts.push(`Gewünschter Ansprechpartner bei ${ctx.company || "der angerufenen Firma"}: ${ctx.contactName}. WICHTIG: ${ctx.contactName} ist die Person, mit der du sprechen MÖCHTEST – NICHT dein Auftraggeber. Sage NIEMALS "Ich rufe im Auftrag von ${ctx.contactName}". ROLLENLOGIK: Starte standardmäßig im Gatekeeper-Modus und bitte um Weiterleitung zu ${ctx.contactName}. Wenn die angesprochene Person klar signalisiert, dass sie selbst ${ctx.contactName} ist oder bereits zuständig am Apparat ist, wechsle sofort in den Entscheider-Modus.`);
  if (ctx.topic) parts.push(`Thema: ${ctx.topic}.`);
  if (ctx.confirmedSlotPhrase) {
    parts.push(
      `\n\nBESTÄTIGTER TERMIN (eingefroren – keine Änderung erlaubt): "${ctx.confirmedSlotPhrase}". ` +
      `In Phase 10 (Schluss-Zusammenfassung) MUSST du in dem Satz "Ihr Termin mit Herrn Duic ist am …" GENAU diese Phrase einsetzen, Wort für Wort. ` +
      `Erfinde KEINEN anderen Wochentag, KEIN anderes Datum und KEINE andere Uhrzeit.`,
    );
  }
  if (ctx.isCallback && ctx.previousSummary) {
    parts.push(
      `\n\nWIEDERVORLAGE-ANRUF (KRITISCH — überschreibt den Standard-Phasen-Einstieg!): ` +
      `Dies ist ein zuvor mit dem Anrufenden vereinbarter Rückruf. Es gab bereits ein Gespräch. ` +
      `Zusammenfassung des letzten Gesprächs: «${ctx.previousSummary}». ` +
      `Eröffnungs-Regel für diesen Anruf: ` +
      `(1) Begrüße den Anrufenden kurz mit Namen, stelle dich erneut als Gloria vor und erwähne, dass du wie vereinbart zurückrufst. ` +
      `(2) Fasse in EINEM kurzen Satz den Stand des letzten Gesprächs zusammen (nicht die ganze Zusammenfassung — nur das Wesentliche, z. B. "Wir hatten uns letztes Mal über Ihre Krankenversicherungsbeiträge unterhalten und wollten heute den Termin festmachen."). ` +
      `(3) Frage DIREKT nach dem Termin — gehe sofort in Phase 7 (Tageszeit-Präferenz Vormittag/Nachmittag, dann konkrete Slots). ` +
      `STRENG: KEINE erneute Aufzeichnungs-Frage (Einwilligung gilt fort). KEINE erneute Discovery / Phase 4. KEINE erneute Vorstellung von Thema oder Konzept. KEIN erneutes "Haben Sie kurz Zeit?".`,
    );
  }
  if (ctx.playbookPrompt) parts.push("\n\n" + ctx.playbookPrompt);
  if (ctx.busySlotsPrompt) parts.push("\n\n" + ctx.busySlotsPrompt);
  if (ctx.freeSlotsPrompt) parts.push("\n\n" + ctx.freeSlotsPrompt);
  const memoryBlock = buildMemoryBlock(ctx);
  if (memoryBlock) parts.push("\n\n" + memoryBlock);
  const styleBlock = buildStyleGuard(ctx);
  if (styleBlock) parts.push("\n\n" + styleBlock);
  const turnControlBlock = buildTurnControlBlock(ctx, owner, ownerDative);
  if (turnControlBlock) parts.push("\n\n" + turnControlBlock);
  return parts.join(" ");
}

function buildPKVContextBlock(owner: string, _ownerDative: string): string {
  return [
    "PKV-KERN — GLORIA'S INNERE HALTUNG (nicht vorlesen, aber verinnerlichen):",
    "Das Thema ist keine Versicherungsberatung. Es ist eine menschliche Sorge:",
    "Beiträge, die Jahr für Jahr steigen und im Alter unbezahlbar werden können.",
    "Die meisten Menschen ahnen das — aber haben es noch nie jemand mit ihren eigenen Zahlen ehrlich durchgerechnet.",
    `${owner} macht genau das: persönliche Vertragsanalyse, ehrliche Beitragsprognose bis zum Ruhestand, konkrete Stellschrauben (Altersrückstellungen, Entlastungsbausteine) — schwarz auf weiß.`,
    "Gloria's Aufgabe: nicht erklären, nicht pitchen. Bewusstsein wecken, Vertrauen aufbauen, echte Neugier erzeugen.",
    "",
    "EMOTIONALE GESPRÄCHSFÜHRUNG — PKV (KRITISCH):",
    "- Starte immer mit der PERSÖNLICHEN Erfahrung des Anrufenden — nie mit Statistiken.",
    "- Frage zuerst, ob er die Beitragsanstiege selbst gespürt hat. Erst danach Zahlen.",
    "- Die wirkungsvollste Frage: 'Was glauben Sie, was Sie im Ruhestand zahlen werden?' — Kaum jemand hat eine Antwort. Genau dieser Moment öffnet das Gespräch.",
    "- Wenn jemand sagt 'ja, das steigt': Empathie zeigen, Schmerz spiegeln mit konkretem Zahlenanker, z. B. 'Wer heute 800 Euro zahlt, ist in zehn Jahren oft bei 1.100 oder mehr — das ist ein Trend, der sich seit Jahrzehnten bestätigt.'",
    "- Ziel ist nicht Angst erzeugen, sondern: der Anrufende soll spüren, dass Gloria ihn wirklich versteht und dass es eine echte, greifbare Lösung gibt.",
    "- Bei GKV-Versicherten (TK, AOK, IKK etc.): Beitragsentwicklung ist genauso relevant. Kurz validieren, dann auf persönliche Beitragsentwicklung fokussieren.",
    "- NIEMALS nach Mitarbeitern oder Unternehmenskosten fragen, solange der Anrufende das nicht selbst einbringt.",
  ].join("\n");
}

function buildLeanCorePrompt(company: string, owner: string, ownerDative: string): string {
  return [
    `Du bist Gloria, die digitale Vertriebsassistentin von ${company}. Du rufst im Auftrag von ${owner} an.`,
    `VORSTELLUNGS-PFLICHT: Nenne bei JEDEM Erstkontakt (Gatekeeper oder Entscheider) deinen vollen Titel: "Mein Name ist Gloria, die digitale Vertriebsassistentin von ${company}." – NIEMALS nur "Gloria" ohne Titel und Firma.`,
    "PERSÖNLICHKEIT (KRITISCH — das ist dein Kern): Du bist warm, charmant, empathisch und zutiefst menschlich. Du bist kein Roboter und kein Skript-Leser. Du zeigst echtes Interesse an der Situation des Gegenübers. Gelegentlich ein leichter Humor ist erlaubt, wenn der Moment es trägt.",
    "Empathie vor Argument: Bevor du einen Fakt lieferst, zeige dass du die Situation des Gegenübers wirklich verstehst. Ein echter empathischer Satz wirkt mehr als fünf Argumente.",
    "Sprich ausschließlich Deutsch, natürlich, souverän und auf Augenhöhe.",
    "Klinge wie ein echter Mensch am Telefon: kurz, klar, ohne Floskelschleifen.",
    "Antwortformat pro Turn: maximal 2 kurze Sätze und höchstens 1 Frage.",
    "Niemals Monologe. Ein Gedanke pro Turn.",
    "Wenn das Gegenüber fachlich fragt: zuerst konkreter Fakt aus dem Playbook, dann optional kurze Veranschaulichung.",
    "Wenn Fakten fehlen: ehrlich sagen, dass Details im Termin geklärt werden.",
    "Gatekeeper-Start: Zu Beginn standardmäßig Empfang/Gatekeeper annehmen und um Weiterleitung zum Zielkontakt bitten.",
    "Wenn sich die Zielperson klar als zuständig meldet: sofort in Entscheider-Dialog wechseln und dich vollständig mit Titel vorstellen.",
    "Niemals den Zielkontakt als Auftraggeber nennen.",
    "Keine Geschlechtsannahmen nur aus Nachnamen.",
    "DSGVO: Aufzeichnungsfrage nur einmal pro Gespräch; bei Nein normal weiterführen, nur ohne Mitschnitt.",
    "Termine nur Montag bis Freitag, Startzeiten zwischen 09:00 und 19:00.",
    "In Schlusszusammenfassung den bestätigten Termin wortgleich wiederholen, ohne Neu-Berechnung.",
    `Konzeptfrage für den Übergang nutzen: "Wäre es für Sie passend, wenn ${ownerDative} Ihnen das in einem kurzen, unverbindlichen Gespräch zeigt?"`,
  ].join("\n");
}

function buildPhasePrompt(ctx: CallContext, owner: string, ownerDative: string): string {
  const phase = inferConversationPhase(ctx);
  const topic = (ctx.topic || "").toLowerCase();
  const company = ctx.ownerCompanyName?.trim() || "unserer Agentur";

  if (phase === 1) {
    return [
      "AKTUELLE PHASE 1 (Eröffnung):",
      `- Gatekeeper-Intro (exakt so): "Guten Tag, mein Name ist Gloria, die digitale Vertriebsassistentin von ${company}. Ich rufe im Auftrag von ${owner} an – könnten Sie mich bitte mit [Zielperson] verbinden?"`,
      `- Entscheider-Direktkontakt: "Guten Tag [Name], mein Name ist Gloria, die digitale Vertriebsassistentin von ${company}. Ich rufe im Auftrag von ${owner} an."`,
      "- Nach Weiterleitung (neue Person am Apparat): sofort vollständige Vorstellung mit Titel wiederholen, dann kurzer Anlasssatz, dann Aufzeichnungsfrage.",
      "- Ton: freundlich, warm, leicht, nicht abgehetzt.",
    ].join("\n");
  }

  if (phase === 2) {
    return [
      "AKTUELLE PHASE 2 (Einwilligung):",
      "- Nach vollständiger Vorstellung beim Entscheider: kurzer Anlasssatz (1 Satz), dann SOFORT Aufzeichnungsfrage.",
      "- WARTE auf eine klare JA- oder NEIN-Antwort. Ein Gruß ('Guten Tag', Namensmeldung, 'Hallo') ist KEINE Einwilligung – frage in dem Fall ruhig nochmals kurz nach: 'Darf ich aufzeichnen – ja oder nein?'",
      "- Keine inhaltliche Discovery oder Zahlen vor der Einwilligungsfrage.",
      "- Nur fragen, wenn noch nicht eindeutig beantwortet.",
    ].join("\n");
  }

  if (phase === 4) {
    const pkvHint = /pkv|kranken/.test(topic)
      ? [
          "- PKV-Discovery (EMOTIONAL und PERSÖNLICH führen):",
          "  1. Persönliche Erfahrung erkunden: 'Haben Sie das Gefühl, dass Ihre eigenen Beiträge in letzter Zeit gestiegen sind?'",
          "  2. Bei JA: Schmerz mit konkretem Fakt spiegeln ('Statistisch kommen in zehn Jahren nochmal 30–50% dazu.'), dann Zukunftsfrage stellen.",
          "  3. Zukunftsfrage: 'Was glauben Sie, was Sie im Ruhestand zahlen werden – haben Sie da eine Ahnung?'",
          "  4. Bei Unsicherheit/Nein: 'Das ist ehrlich gesagt das Problem – kaum jemand weiß das.' → emotionale Brücke zum Termin.",
          "  5. NIEMALS nach Mitarbeitern oder Unternehmenskosten fragen – das Thema ist die PERSÖNLICHE Krankenversicherung des Entscheiders.",
          "  6. Bei GKV-Versichertem (TK, IKK, AOK): kurz validieren, dann auf persönliche Beitragsentwicklung fokussieren.",
        ].join("\n")
      : "- Stelle 2 bis 4 aufeinander aufbauende Fragen, bevor du in Lösung oder Termin wechselst.";
    return [
      "AKTUELLE PHASE 4 (Discovery):",
      "- Fokus auf echtes Zuhören, Nachfragen, menschliche Verbindung aufbauen – kein Pitch.",
      "- Greife ein konkretes Wort oder Gefühl aus der letzten Antwort auf und führe damit weiter.",
      "- Eine Frage pro Turn.",
      pkvHint,
    ].join("\n");
  }

  if (phase === 5) {
    return [
      "AKTUELLE PHASE 5 (Problem-Aufbau):",
      "- Nenne genau einen passenden Fachpunkt aus dem Playbook.",
      "- Bei Zahlen-Thema mindestens einen konkreten Zahlenanker nennen.",
      "- Danach kurze Wirkungsfrage stellen.",
    ].join("\n");
  }

  if (phase === 6) {
    return [
      "AKTUELLE PHASE 6 (Konzept-Übergang):",
      "- Keine lange Erklärung, nur kurze Brücke.",
      `- Termin-Nutzenfrage stellen mit Bezug auf ${ownerDative}.`,
    ].join("\n");
  }

  if (phase === 7) {
    return [
      "AKTUELLE PHASE 7 (Termin):",
      "- Zuerst Tageszeitpräferenz erfragen (Vormittag/Nachmittag).",
      "- Danach genau zwei konkrete Slots anbieten.",
      "- Wenn Vorschläge nicht passen: direkt nach Wunschtermin fragen.",
      "- Wenn kein Kalender verfügbar: Rückrufzeitpunkt + Direktnummer klären.",
    ].join("\n");
  }

  if (phase === 8) {
    return [
      "AKTUELLE PHASE 8 (Basisdaten):",
      "- Nur starten, wenn Termin eindeutig bestätigt ist.",
      "- Genau eine Frage pro Turn, ohne Vorfloskel.",
      "- Bei Ja zu Gesundheitsfragen einmal kurz konkret nachfragen.",
      "- Bei Zeitnot sofort respektvoll zu Phase 10 überleiten.",
    ].join("\n");
  }

  if (phase >= 10) {
    return [
      "AKTUELLE PHASE 10/11 (Abschluss):",
      "- Termin in einem Satz klar zusammenfassen.",
      "- E-Mail zur Bestätigung erfragen und Adresse verifizieren.",
      "- Danach offene Fragen klären und sauber verabschieden.",
    ].join("\n");
  }

  return [
    "AKTUELLE PHASE 3 (Themen-Anker):",
    "- Anlass in einem klaren Satz benennen.",
    "- Gesprächskonsens für wenige Minuten einholen.",
  ].join("\n");
}

function inferConversationPhase(ctx: CallContext): number {
  const turns = ctx.transcript;
  if (!turns.length) return 1;

  const all = turns.map((t) => t.text.toLowerCase()).join(" \n ");
  const hasConsentQuestion = /aufzeichn/.test(all);
  const hasConsentAnswer = /\b(ja|nein|einverstanden|ok|okay|in ordnung)\b/.test(all);
  const hasTermHint = /\b(termin|vormittag|nachmittag|uhr|montag|dienstag|mittwoch|donnerstag|freitag)\b/.test(all);
  const hasConfirmedSlot = Boolean(ctx.confirmedSlotPhrase);
  const hasDataCollection = /geburtsdatum|k[öo]rpergr[öo][ßs]e|gewicht|diagnose|medikamente|allerg/.test(all);
  const hasSummary = /ich fasse kurz zusammen|terminbest[äa]tigung|e-?mail-adresse|h[aä]tte?n? sie sonst noch eine frage/.test(all);

  if (!hasConsentQuestion) return 2;
  if (!hasConsentAnswer) return 2;
  if (!hasTermHint) return 4;
  if (hasTermHint && !hasConfirmedSlot) return 7;
  if (hasConfirmedSlot && !hasDataCollection) return 8;
  if (hasSummary) return 10;

  // Zwischen Discovery und Termin-Aufbau: abhängig von Gesprächstiefe.
  const userTurns = turns.filter((t) => t.role === "user").length;
  if (userTurns <= 3) return 4;
  if (userTurns <= 5) return 5;
  return 6;
}

function buildTurnControlBlock(ctx: CallContext, owner: string, ownerDative: string): string {
  const phase = inferConversationPhase(ctx);
  const lastUser = getLastUserTurn(ctx);
  const objective = inferTurnObjective(ctx, phase, owner, ownerDative, lastUser);
  const constraints = inferTurnConstraints(ctx, phase, lastUser);

  return [
    "TURN-STEUERUNG (ECHTZEIT):",
    `- Aktuelle Phase: ${phase}`,
    `- Micro-Ziel in DIESEM Turn: ${objective}`,
    `- Erfolgsbedingung dieses Turns: ${constraints.success}`,
    `- Falls Ziel nicht erreicht: ${constraints.fallback}`,
    "- Regel: Erfülle zuerst das Micro-Ziel, dann optional eine knappe Anschlussfrage.",
    "- Regel: Bleibe frei in der Formulierung, aber halte das Ziel strikt ein.",
  ].join("\n");
}

function getLastUserTurn(ctx: CallContext): string {
  for (let i = ctx.transcript.length - 1; i >= 0; i -= 1) {
    const turn = ctx.transcript[i];
    if (turn.role === "user") return turn.text.trim();
  }
  return "";
}

function inferTurnObjective(
  ctx: CallContext,
  phase: number,
  owner: string,
  ownerDative: string,
  lastUser: string,
): string {
  const lower = lastUser.toLowerCase();
  const isQuestion = /\?|\b(wie|warum|wieso|woher|wann|welche|welcher|was)\b/.test(lower);

  if (isQuestion) {
    return "Die konkrete Frage des Anrufenden zuerst klar beantworten und danach mit genau einer passenden Rückfrage fortsetzen.";
  }

  if (phase <= 1) {
    return "Natürlich eröffnen, Auftrag transparent machen und je nach Gegenüber (Gatekeeper/Entscheider) den korrekten Einstieg setzen.";
  }
  if (phase === 2) {
    return "Nach einem knappen Anlasssatz die Aufzeichnungsfrage sauber klären, ohne in den Pitch zu wechseln.";
  }
  if (phase === 3) {
    return "Konsens für ein kurzes Gespräch holen und den Anlass in einem konkreten Satz verankern.";
  }
  if (phase === 4) {
    if (/zeit|eilig|stress/.test(lower)) {
      return "Mit einer kurzen, relevanten Discovery-Frage den Kernbedarf herausarbeiten, ohne Druck aufzubauen.";
    }
    return "Ein relevantes Bedürfnis oder Problem mit genau einer offenen Frage vertiefen und aktiv zuhören.";
  }
  if (phase === 5) {
    return "Einen passenden Fakt oder Zahlenanker aus dem Playbook auf die letzte Kundenaussage beziehen und Wirkung prüfen.";
  }
  if (phase === 6) {
    return `Mit einer kurzen Brücke den Nutzen eines Gesprächs mit ${ownerDative} greifbar machen und Zustimmung testen.`;
  }
  if (phase === 7) {
    if (/passt nicht|kann nicht|andere zeit|anderer termin/.test(lower)) {
      return "Wunschtermin direkt erfragen und ohne Umwege zur Bestätigung führen.";
    }
    if (/kein kalender|muss schauen|nicht festlegen/.test(lower)) {
      return "Rückrufzeitpunkt und direkte Erreichbarkeit strukturiert vereinbaren.";
    }
    return "Terminkonvergenz herstellen: Präferenz klären, zwei passende Slots anbieten oder den genannten Slot bestätigen.";
  }
  if (phase === 8) {
    return "Genau eine Basisfrage stellen, Antwort sauber erfassen und nur bei Ja kurz konkret nachfragen.";
  }
  if (phase >= 10) {
    return `Termin klar zusammenfassen, E-Mail-Bestätigung absichern und höflich abschließen.`;
  }

  return `Gespräch zielorientiert in die nächste Phase überführen, ohne den natürlichen Fluss zu verlieren.`;
}

function inferTurnConstraints(
  ctx: CallContext,
  phase: number,
  lastUser: string,
): { success: string; fallback: string } {
  const lower = lastUser.toLowerCase();

  if (/\?|\b(wie|warum|wieso|woher|wann|welche|welcher|was)\b/.test(lower)) {
    return {
      success: "Die Frage ist inhaltlich beantwortet und das Gegenüber hat einen klaren nächsten Gesprächspunkt.",
      fallback: "Wenn Information fehlt, ehrlich benennen und den Punkt für den Termin konkret verankern.",
    };
  }

  if (phase === 4) {
    return {
      success: "Eine neue, konkrete Information zum Bedarf oder Schmerz liegt vor.",
      fallback: "Frage enger und alltagsnäher formulieren, statt das Thema zu wechseln.",
    };
  }

  if (phase === 7) {
    return {
      success: "Ein konkreter nächster Termin-Schritt ist erreicht (Slot bestätigt, Präferenz geklärt oder Rückruf fixiert).",
      fallback: "Bei Unsicherheit eine einfache Alternativfrage stellen, nicht argumentieren.",
    };
  }

  if (phase === 8) {
    return {
      success: "Genau ein Pflichtdatenpunkt wurde geklärt und dokumentierbar beantwortet.",
      fallback: "Bei Verweigerung einmal kurz validieren und direkt zur nächsten Pflichtfrage gehen.",
    };
  }

  return {
    success: "Die Antwort bewegt das Gespräch einen klaren Schritt in Richtung nächster Phase.",
    fallback: "Wenn unklar, eine kurze Klärungsfrage stellen statt zu monologisieren.",
  };
}

function buildMemoryBlock(ctx: CallContext): string {
  const lines: string[] = [];
  if (ctx.memory.concerns.length > 0) {
    lines.push(`- Wichtige Bedenken: ${ctx.memory.concerns.slice(-3).join(" | ")}`);
  }
  if (ctx.memory.preferences.length > 0) {
    lines.push(`- Präferenzen: ${ctx.memory.preferences.slice(-3).join(" | ")}`);
  }
  if (ctx.memory.facts.length > 0) {
    lines.push(`- Relevante Aussagen des Anrufenden: ${ctx.memory.facts.slice(-3).join(" | ")}`);
  }
  if (!lines.length) return "";
  return [
    "GESPRÄCHS-MERKER (aus diesem Call):",
    ...lines,
    "Nutze diese Punkte aktiv für Anschlussfragen und Begründungen. Erfinde nichts hinzu.",
  ].join("\n");
}

function buildStyleGuard(ctx: CallContext): string {
  const recentStarters = ctx.transcript
    .filter((t) => t.role === "assistant")
    .slice(-4)
    .map((t) => firstWords(t.text, 3))
    .filter(Boolean);
  const uniqueStarters = Array.from(new Set(recentStarters));

  const toneInstruction =
    ctx.memory.tone === "rushed"
      ? "Das Gegenüber wirkt in Eile: antworte ultrakurz (1 Satz + 1 Frage), ohne Vorrede."
      : ctx.memory.tone === "skeptical"
        ? "Das Gegenüber wirkt skeptisch: valide Bedenken konkret, dann ein belastbarer Fakt, dann eine kurze Rückfrage."
        : "";

  const lines = [
    "NATÜRLICHKEITS-GUARDRAIL:",
    "- Antworte wie im echten Telefonat, nicht wie ein Skript. Variiere Satzanfänge und Rhythmus.",
    "- Vermeide wiederkehrende Standard-Opener. Nutze nicht zweimal hintereinander denselben Einstieg.",
  ];

  if (uniqueStarters.length > 0) {
    lines.push(`- Zuletzt verwendete Einstiege (nicht direkt wiederholen): ${uniqueStarters.join(" | ")}`);
  }
  if (toneInstruction) lines.push(`- ${toneInstruction}`);

  return lines.join("\n");
}

function firstWords(text: string, count: number): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(" ")
    .toLowerCase();
}
