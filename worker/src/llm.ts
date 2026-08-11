import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";

// buildBasePrompt and generateReply removed — dead code.
// Live path is exclusively streamReply (sentence-level LLM→TTS pipeline).

export type TurnOutput = {
  reply: string;
  hangup: boolean;
  transfer: boolean;
};

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

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
  const trustReply = buildDeterministicTrustReply(ctx, userText);
  if (trustReply) {
    onSentence(trustReply.reply);
    return trustReply;
  }

  const deterministicReply = buildDeterministicPostBookingReply(ctx);
  if (deterministicReply) {
    onSentence(deterministicReply.reply);
    return deterministicReply;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  // Qualitäts-Default: gpt-4.1 klingt in Akquise-Telefonaten konsistenter
  // und weniger "template-haft" als mini-Varianten. Override via OPENAI_MODEL.
  const model = process.env.OPENAI_MODEL || "gpt-4.1";
  // Premium-Sweetspot: genug Kontext + knappe Antworten fuer natuerliche
  // Dynamik bei niedriger Reaktionszeit.
  const transcriptTurns = parseEnvInt("LLM_TRANSCRIPT_TURNS", 10, 6, 24);
  const maxTokens = parseEnvInt("LLM_MAX_TOKENS", 115, 60, 220);
  const timeoutMs = parseEnvInt("LLM_TIMEOUT_MS", 7600, 4000, 20000);
  const earlyFlushChars = parseEnvInt("LLM_EARLY_FLUSH_CHARS", 34, 24, 400);

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildSystemPrompt(ctx) },
  ];
  // handleUserUtterance hat den aktuellen Nutzerturn bereits ins Transkript
  // geschrieben. Nicht ein zweites Mal an das Modell senden.
  const history = ctx.transcript.at(-1)?.role === "user" && ctx.transcript.at(-1)?.text === userText
    ? ctx.transcript.slice(0, -1)
    : ctx.transcript;
  for (const turn of history.slice(-transcriptTurns)) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userText });

  const requestBody = {
    model,
    messages,
    temperature: 0.58,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
          // Satzgrenze: nur echte Satzenden flushen (kein Komma-Split).
          // Komma-Splits erzeugen Satzfragmente mit falscher Intonation im TTS.
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
          // Sicherheitspuffer: sehr lange Segmente an Leerzeichen trennen.
          if (pendingFlush.length >= 250 && /\s/.test(ch)) {
            flushSentence();
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
    let transfer = false;
    try {
      const parsed = JSON.parse(assembled) as { hangup?: boolean; transfer?: boolean; reply?: string };
      hangup = Boolean(parsed.hangup);
      transfer = Boolean(parsed.transfer);
      if (parsed.reply && !replyText) replyText = parsed.reply;
    } catch {
      /* fallback: replyText was scanner-extracted, hangup defaults to false */
    }

    let reply = replyText.trim() || "Entschuldigung, könnten Sie das bitte wiederholen?";
    if (consentAlreadyGranted(ctx) && /aufzeichn|mitschneid/i.test(reply)) {
      reply = stripConsentQuestion(reply);
    }
    return { reply, hangup, transfer };
  } catch (error) {
    log.error("llm.stream_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      reply: replyText.trim() || "Einen Moment bitte, ich habe Sie kurz nicht verstanden.",
      hangup: false,
      transfer: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function consentAlreadyGranted(ctx: CallContext): boolean {
  // Suche im Transkript: Gloria hat "aufzeichnen" gefragt UND danach hat der
  // Anrufende eine klare Zustimmung gegeben. Das muss auch bei Rueckfragen wie
  // "Duerfen Sie?" robust funktionieren.
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant" || !/aufzeichn|mitschneid/i.test(t.text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      const turn = turns[j];
      if (turn.role !== "user") continue;
      const decision = parseRecordingConsentDecision(turn.text);
      if (decision === "granted") {
        return true;
      }
      if (decision === "declined") {
        return false;
      }
    }
  }
  return false;
}

function parseRecordingConsentDecision(text: string): "granted" | "declined" | null {
  const ans = text.toLowerCase().trim();

  // Eindeutige Zustimmung.
  if (
    /^(ja\b|jawohl|gerne|in ordnung|einverstanden|okay|ok\b|geht klar|kein problem|nat[üu]rlich|klar\b)/i.test(ans) ||
    /\b(sie\s+k[öo]nnen\s+gerne\s+aufzeichn|k[öo]nnen\s+sie\s+gern\s+aufzeichn|d[üu]rfen\s+sie\b|ja,?\s+d[üu]rfen\s+sie)\b/i.test(ans)
  ) {
    return "granted";
  }

  // Eindeutige Ablehnung.
  if (/^(nein\b|n[öo]\b|lieber nicht|bitte nicht|keine aufzeichnung|nicht aufzeichnen)/i.test(ans)) {
    return "declined";
  }

  return null;
}

function stripConsentQuestion(text: string): string {
  // Entferne ganze Sätze, die nach Aufzeichnungs-Einwilligung fragen.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => !/aufzeichn|mitschneid/i.test(s) && !/\bja\s+oder\s+nein\b/i.test(s));
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
  const parts = [buildConversationPrimer(ctx, company, owner, ownerDative)];
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
  if (ctx.leadNote?.trim()) parts.push(`Leitkontext aus der Firmenliste: ${ctx.leadNote.trim()}`);
  if (ctx.topic) parts.push(`Thema: ${ctx.topic}.`);
  if (ctx.confirmedSlotPhrase) {
    parts.push(
      `\n\nBESTÄTIGTER TERMIN (eingefroren – keine Änderung erlaubt): "${ctx.confirmedSlotPhrase}". ` +
      `In Phase 10 (Schluss-Zusammenfassung) MUSST du in dem Satz "Ihr persönlicher Termin mit Herrn Duic ist am …" GENAU diese Phrase einsetzen, Wort für Wort. ` +
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
  if (ctx.playbookPrompt) {
    parts.push(
      "\n\nPLAYBOOK-NUTZUNG: Verwende das Playbook als Leitplanke für Richtung, Nutzen und Compliance - NICHT als Vorlesetext. " +
      "Formuliere jede Antwort frisch aus dem Moment, passend zum letzten Kundensatz.",
    );
    parts.push("\n\n" + ctx.playbookPrompt);
  }
  if (ctx.busySlotsPrompt) parts.push("\n\n" + ctx.busySlotsPrompt);
  if (ctx.freeSlotsPrompt) parts.push("\n\n" + ctx.freeSlotsPrompt);
  const memoryBlock = buildMemoryBlock(ctx);
  if (memoryBlock) parts.push("\n\n" + memoryBlock);
  const styleBlock = buildStyleGuard(ctx);
  if (styleBlock) parts.push("\n\n" + styleBlock);
  parts.push(
    `\n\nANTWORTFORMAT: Antworte ausschließlich als JSON: {"reply": "deutscher Antworttext", "hangup": false, "transfer": false}. ` +
    `Gib die Schlüssel zwingend in dieser Reihenfolge aus: reply, hangup, transfer. Beginne den reply sofort und ohne interne Vorbemerkung. ` +
    `Setze hangup=true nur wenn der Anrufende ein klares Nein signalisiert oder das Gespräch sauber beendet wurde. ` +
    `Setze transfer=true (und hangup=false) wenn du den Anrufenden an Frau Brost weiterleitest — NUR wenn er das ausdrücklich wünscht.`,
  );
  return parts.join("\n");
}

function buildConversationPrimer(ctx: CallContext, company: string, owner: string, ownerDative: string): string {
  const topic = (ctx.topic || "").toLowerCase();
  const isPKV = /pkv|kranken/.test(topic);
  const isCommercialInsurance = /gewerb|haftpflicht|cyber|inhalt|sachversicher|risikoschutz/.test(topic);
  const phase = inferConversationPhase(ctx);
  const lines: string[] = [];

  // IDENTITY + GOAL
  lines.push(
    `Du bist Gloria, die digitale Vertriebsassistentin von ${company}. Du rufst im Auftrag von ${owner} an.`,
    `AKQUISE-KONTEXT: Die angerufene Person hatte noch nie Kontakt zu euch. Behaupte oder suggeriere niemals eine bestehende Beziehung, Empfehlung oder vorherige Anfrage. Rechne zu Beginn mit gesunder Skepsis.`,
    `Dein erstes Ziel ist nicht der Termin, sondern dass die Person nach zehn Sekunden versteht: Wer ruft an, warum gerade dieses Thema und dass sie jederzeit Nein sagen darf. Erst wenn Relevanz und ein Mindestmaß an Vertrauen da sind, führst du zum Termin.`,
    `Deine Art: warm, ruhig, direkt und transparent. Du arbeitest als digitale Assistentin - professionell, klar und ohne Skriptklang.`,
    `PREMIUM-MODUS (VERBINDLICH): Klinge wie ein erfahrener Senior-Call-Agent mit Beratungsanspruch - praezise, respektvoll, fuehrungsstark, nie aufdringlich. Kein Callcenter-Slang, keine Floskeln, keine kuenstliche Euphorie.`,
    `PREMIUM-OPENER (VERBINDLICH IM ERSTKONTAKT): (1) klare Vorstellung in einem Satz, (2) konkreter Anlass in einem Satz, (3) kurze Erlaubnisfrage in einem Satz. Maximal drei kurze Saetze, dann Pause.`,
    `PREMIUM-RHYTHMUS: Jede Antwort beginnt mit einem konkreten Bezug auf den letzten Kundengedanken und fuehrt dann mit genau einer klaren Frage weiter.`,
    `Pro Antwort: meist 1-2 kurze Sätze, höchstens eine Hauptfrage. Dann Pause. Wirklich zuhören.`,
  );

  // TOPIC KNOWLEDGE — verinnerlichen, nicht ablesen
  if (isPKV) {
    lines.push(
      ``,
      `WAS DU ÜBER DAS THEMA WEISST (verinnerlichen — nicht ablesen, nicht zitieren):`,
      `Krankenversicherungsbeiträge steigen seit Jahrzehnten — im Schnitt 3–5% jährlich. Wer heute 800 Euro zahlt, landet in zehn Jahren oft bei 1.100 oder mehr. Das ist kein Ausnahmefall, das ist der Regelfall.`,
      `Jede Gesundheitsreform kostet Geld. Dieses Geld landet am Ende fast immer beim Beitragszahler — nicht beim Staat, nicht bei der Kasse.`,
      `Die meisten Menschen ahnen das irgendwie — aber sie haben es noch nie jemand mit ihren eigenen Zahlen ehrlich vorgerechnet. Genau das ist die Lücke, in die du gehst.`,
      `${owner} macht genau das: persönliche Vertragsanalyse, realistische Beitragsprognose bis zum Ruhestand, konkrete Stellschrauben — Altersrückstellungen, Entlastungsbausteine, Tarifoptimierung. Schwarz auf weiß, keine Schönfärberei.`,
      `Deine Aufgabe im Gespräch: nicht erklären, nicht pitchen. Bewusstsein wecken, echte Neugier erzeugen, Vertrauen aufbauen. Der Anrufende soll nach dem Gespräch denken: "Das hätte ich früher wissen sollen."`,
    );
  }

  if (isCommercialInsurance) {
    lines.push(
      ``,
      `WAS DU UEBER GEWERBLICHE VERSICHERUNGEN WEISST (verinnerlichen - nicht ablesen):`,
      `Das Thema ist ein strukturierter Vergleich bestehender Policen und ein Check-up, ob die Absicherung heute noch marktkonform ist.`,
      `Der Ersttermin ist ein Analyse-Termin: ${owner} stellt sich und seine Arbeitsweise vor, nimmt die noetigen Daten fuer den Vergleich auf und vereinbart direkt einen zweiten Termin zur Ergebnisvorstellung.`,
      `Der Zweittermin ist der Ergebnis-Termin: Dort werden Einsparpotenziale, Leistungsverbesserungen und moegliche Deckungsluecken transparent praesentiert.`,
      `Realistischer Nutzenanker: In vielen Faellen lassen sich bis zu dreißig Prozent Beitrag einsparen - oft bei gleichzeitig besseren Leistungen.`,
      `Zusatznutzen: Hauefig werden Risiken sichtbar, die bisher gar nicht oder nicht ausreichend abgesichert sind.`,
      `Typisches Kundenmuster: Viele Betriebe schliessen Policen einmal ab und pruefen sie jahrelang nicht mehr. Probleme fallen oft erst im Schadenfall auf.`,
      `Weiteres Muster: Manche verlassen sich voll auf den Makler und haben keinen klaren Ueberblick, was konkret versichert ist und was nicht.`,
      `Deine Aufgabe im Gespraech: Nicht druecken, sondern Struktur und Klarheit geben. Der Kunde soll verstehen, dass der erste Termin eine saubere Bestandsaufnahme ist - kein Produktverkaufstermin.`,
    );
  }

  const pkvData = isPKV ? collectPkvData(ctx) : null;
  if (pkvData) {
    const captured = Object.entries(pkvData.values)
      .map(([field, value]) => `${field}: ${value}`)
      .join(" | ");
    lines.push(
      ``,
      `BEREITS ERFASSTE BASISANGABEN: ${captured || "noch keine"}.`,
      `Vom Kunden ausdrücklich übersprungen: ${pkvData.skipped.join(", ") || "keine"}. Diese Punkte nicht erneut fragen.`,
      `Noch offen: ${pkvData.missing.join(", ") || "keine"}.`,
      `Verbindlich: Bereits erfasste Angaben NICHT erneut fragen. Wenn eine Antwort mehrere Angaben enthält, gelten alle erkannten Angaben als erfasst. VOR dem bestätigten Termin sind diese Angaben nur Gesprächskontext und dürfen nicht als Datenliste abgefragt werden. Erst in Phase 8 fragst du das erste noch offene Feld.`,
    );
    if (pkvData.email) {
      lines.push(`Erkannte E-Mail-Adresse: ${pkvData.email}. Wiederhole sie bei der Bestätigung vollständig inklusive Domain-Endung.`);
    }
  }

  // CONVERSATION STATE — observational, not commanding
  lines.push(``, `WO IHR GERADE SEID:`);

  if (phase <= 1) {
    lines.push(
      `Echter Erstkontakt. Stell dich transparent als digitale Vertriebsassistentin vor, nenne ${owner} und sage offen, dass ihr bisher noch keinen Kontakt hattet. Diese Ehrlichkeit baut mehr Vertrauen auf als künstliche Vertrautheit.`,
      `Formuliere den Erstkontakt aktiv und klar, z. B.: "Wir hatten bisher noch keinen direkten Kontakt, deshalb kurz transparent der Anlass meines Anrufs."`,
      `Wenn Gatekeeper: freundlich um Weiterleitung bitten. Beim Entscheider: Anlass in einem konkreten Satz, dann eine kleine Erlaubnisfrage wie "Darf ich Ihnen in zwei Sätzen sagen, weshalb ich anrufe?" Keine persönliche Versicherungsfrage im Opener.`,
    );
  } else if (phase === 2) {
    lines.push(
      `Du hast dich vorgestellt. Wenn der Kunde "Worum geht es?", "Warum rufen Sie an?" oder sinngleich fragt, beantworte ZUERST konkret den Anlass und Nutzen in einem kurzen Satz. Erst danach darfst du um Aufzeichnung bitten. Weiche der Frage niemals mit der Aufzeichnungsfrage aus.`,
      `Falls "Erstkontakt" noch nicht explizit gefallen ist: sage vor der Aufzeichnungsfrage einmal transparent, dass dies euer erster Kontakt ist und du deshalb kurz und klar durch den Anlass führst.`,
      `Bevor du nach Aufzeichnung fragst, gib der Person einen nachvollziehbaren Grund: ${owner} soll das Gespräch später korrekt nachvollziehen können. Sage ausdrücklich, dass ihr bei einem Nein selbstverständlich ohne Aufzeichnung weitersprecht. Das Nein darf keinerlei Druck oder Nachteil auslösen.`,
      `Natürliche Form: "Damit Herr Duic später nichts falsch zugeordnet bekommt: Darf ich unser Gespräch kurz aufzeichnen? Wenn nicht, sprechen wir natürlich ohne Aufnahme weiter." Dann warten.`,
      `Ein Gruß oder eine Namensmeldung ist noch keine Einwilligung — warte auf eine echte Antwort.`,
    );
  } else if (phase === 4) {
    if (isPKV) {
      lines.push(
        `Aufzeichnung ist geklärt. Ziel jetzt: ein echtes Gespräch und Relevanz aufbauen, noch KEINE Terminfrage.`,
        `Beginne mit einer leicht beantwortbaren Wahrnehmungsfrage, nicht mit persönlichen Daten: "Wie erleben Sie die Beitragsentwicklung bei sich – eher auffällig oder läuft das bisher nebenher?"`,
        `Kläre die Versicherungsart erst, wenn die Antwort einen natürlichen Anschluss bietet. Frage nie mehrere Fakten hintereinander ab.`,
        `Nenne NIEMALS "private Krankenversicherung" als Tatsache, bevor der Kunde das selbst bestätigt hat. Nutze bis dahin neutrale Formulierungen wie "Krankenversicherung" oder "Gesundheitsversorgung".`,
        `REAKTION VOR FRAGE: Greife den Sinn der Antwort in eigenen Worten auf und gib einen kurzen hilfreichen Gedanken. Stelle erst danach die nächste Frage. Keine Abfolge aus Bestätigung plus sofortiger Formularfrage.`,
        `Gib in jedem zweiten Zug zunächst Substanz: eine kurze Einordnung, eine transparente Erklärung oder eine vorsichtige Beispielrechnung. Der Kunde soll auch etwas bekommen, nicht nur Auskunft geben.`,
        `Frage nach dem aktuellen Beitrag nur permission-based und begründe den Nutzen: "Wenn Sie die Größenordnung nennen möchten, kann ich den Zehn-Jahres-Effekt grob einordnen." Ein "möchte ich nicht sagen" sofort akzeptieren.`,
        `Wenn er seinen Beitrag nennt (z.B. 900 €): mit genau dieser Zahl rechnen und danach eine Denkfrage stellen, z.B. "Hat sich das schon einmal jemand mit Ihnen bis zum Rentenalter sauber durchgerechnet?"`,
        `Wenn er sagt "hab ich mir keine Gedanken gemacht": Das ist dein Moment. Nicht weiterpitchen — kurz innehalten: "Genau das ist das Tückische daran. Das merkt man erst, wenn der nächste Bescheid kommt." Dann Pause.`,
        `NIEMALS "laut PKV-Verband", "Studien zeigen" oder ähnliche Quellen-Claims sagen — das klingt wie eine Broschüre. Rechne mit seinen Zahlen, nicht mit Durchschnittswerten.`,
        `Erst wenn er selbst sagt "das ist viel" oder ähnliches — dann die Brücke: "Genau dafür ist das Gespräch mit Herrn Duic da."`,
        `GKV-Versicherte: Beitragsentwicklung ist genauso ihr Thema. Nie nach Mitarbeitern oder Unternehmenskosten fragen.`,
        `WICHTIG: Frag pro Turn GENAU EINE Frage. Kein Doppeln.`,
      );
    } else {
      lines.push(
        `Aufzeichnung ist geklärt. Jetzt zuerst Vertrauen vor Terminierung: kurz auf die letzte Aussage eingehen, Nutzen greifbar machen und dann eine einzige offene Frage stellen.`,
        `Nicht-PKV Leitlinie: Kein Termin-Push in den ersten Zügen nach Einwilligung. Erst Relevanz und Verständnis aufbauen, dann behutsam zur Terminfrage überleiten.`,
        isCommercialInsurance
          ? `Setze frueh den Rahmen fuer die 2-Termin-Logik: Der erste Termin dient der Bestandsaufnahme und Datenerhebung fuer den Vergleich, der zweite Termin praesentiert die Analyseergebnisse.`
          : ``,
        isCommercialInsurance
          ? `GEWERBE-LEITFRAGEN (eine pro Turn, nie als Dreierblock): (1) "Wann wurde Ihre Absicherung zuletzt als Gesamtbild geprüft?" (2) "Hat sich bei Ihnen in den letzten Jahren etwas verändert – z. B. Wachstum, neue Tätigkeiten oder mehr Mitarbeitende?" (3) "Wo hätten Sie heute den größten Klärungsbedarf: Deckungslücken oder Beitrag-Leistung?"`
          : ``,
        `Wenn die Person skeptisch ist: validieren, konkretisieren, rückfragen (Dreischritt) statt pitchen.`,
        `Halte den Ton wie im Erstkontakt: transparent, respektvoll, ohne Vertrautheits-Behauptung.`,
      );
    }
  } else if (phase === 5) {
    if (isPKV) {
      lines.push(
        `SENSIBILISIERUNGSPHASE: Kein Fragenkatalog. Vertiefe nur den Punkt, den der Kunde selbst geöffnet hat.`,
        `Nutze mindestens einen konkreten Zahlenanker und benenne den Reformdruck in einem klaren Satz, aber halte die Einordnung kurz und lade danach zu einer Reaktion ein.`,
        `DER Reformdruck und die Kostenentwicklung gehören genau hier hin - nicht in den Abschluss.`,
        `Keine Angstkommunikation und kein künstliches Dramatisieren. Sprich über Planbarkeit und Entscheidungsfreiheit.`,
        `Wenn der Kunde einen konkreten Beitrag nennt, arbeite mit GENAU dieser Zahl. Keine Runterrechnung und keine frei erfundenen Korrekturen.`,
        `Beende diese Phase mit einer aktivierenden Denkfrage, die Bedarf sichtbar macht (z. B. "Hat sich das schon jemand mit Ihnen bis zur Rente sauber durchgerechnet?").`,
      );
    } else {
      lines.push(
        `SENSIBILISIERUNGSPHASE: Kein Fragenkatalog. Vertiefe nur den Punkt, den der Kunde selbst geöffnet hat.`,
        `Nutze mindestens einen konkreten Zahlenanker aus dem Thema (z. B. Beitrag/Leistung, Deckungslücken, Überschneidungen) und halte die Einordnung kurz.`,
        isCommercialInsurance
          ? `Bei gewerblichen Versicherungen bleib in der Sache bei Betriebskontext: gewachsenes Unternehmen, neue Tätigkeiten, verändertes Risikoprofil, Aktualität der Policen.`
          : ``,
        isCommercialInsurance
          ? `Wirkungsanker fuer Gewerbe: Viele Unternehmen zahlen seit Jahren zu viel oder haben gleichzeitig Leistungsluecken. Formuliere das als pruefbare Arbeitshypothese, nicht als Behauptung.`
          : ``,
        isCommercialInsurance
          ? `Nutze Einspar- und Leistungsnutzen vorsichtig konkret: "In vielen Faellen lassen sich deutliche Beitragsvorteile erzielen, teils bis zu dreißig Prozent - haeufig mit besserem Schutz."`
          : ``,
        `Keine Angstkommunikation und kein künstliches Dramatisieren. Sprich über Planbarkeit, Schutzniveau und Entscheidungsfreiheit.`,
        `Beende diese Phase mit einer aktivierenden Denkfrage ohne Themenwechsel, z. B. "Wurde das bei Ihnen schon einmal strukturiert gegengeprüft?"`,
      );
    }
  } else if (phase === 6) {
    lines.push(
      `KONZEPT-BRIDGE: Knüpfe ausdrücklich an die letzte Aussage des Kunden an und erkläre in 1-2 Sätzen, was ${ownerDative} konkret liefert: persönliche Analyse, realistische Prognose, konkrete Stellschrauben, kein Verkaufsdruck.`,
      isCommercialInsurance
        ? `Bei gewerblichen Versicherungen muss klar sein: Termin 1 = Datenaufnahme und Vergleichsgrundlage, Termin 2 = Ergebnisvorstellung mit konkreten Optionen und Empfehlung.`
        : ``,
      `Mache einen Verständnisschritt vor dem Termin: "Wäre so eine nüchterne Einordnung grundsätzlich hilfreich für Sie?" Erst bei Offenheit terminieren.`,
    );
  } else if (phase === 7) {
    lines.push(
      `Das Interesse ist da. Wiederhole keinen Pitch und keinen Reformdruck. Bestätige knapp, was dem Kunden wichtig war, und gehe ruhig zur Terminabstimmung.`,
      isCommercialInsurance
        ? `Rahme den Ersttermin fuer Gewerbe als strukturierten Analyse-Termin: Vorstellung, Sichtung der aktuellen Absicherung, Aufnahme der Vergleichsdaten, danach Termin 2 zur Ergebnisbesprechung.`
        : ``,
      `Dann Termin schließen: erst fragen ob eher Vormittag oder Nachmittag passt, dann genau zwei konkrete Slots aus der NÄCHSTEN WOCHE anbieten (nicht am nächsten Tag). Wenn beide nicht passen: zwei weitere Slots aus der darauffolgenden freien Woche anbieten, keinen bereits abgelehnten Slot wiederholen.`,
      `Rahme den Termin als persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic, nicht als Telefontermin.`,
      `Wenn der Kunde einen Slot auswählt: bestätige NUR den Termin in einem kurzen Satz und stelle höchstens die Frage, ob noch zwei Minuten für die Vorbereitung passen. KEINE Verabschiedung, KEIN hangup, KEINE Abschluss-Zusammenfassung und nicht behaupten, es sei nichts vorzubereiten.`,
    );
  } else if (phase === 8) {
    const basisDataConsent = getBasisDataConsentState(ctx);
    lines.push(
      `Termin bestätigt. Jetzt Vertrauen schützen: Die Terminbestätigung ist wichtiger als ein vollständiger Datensatz.`,
      basisDataConsent === "not-asked"
        ? `ERSTER SCHRITT: Frage genau einmal: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?" NOCH KEINE Datenfrage stellen.`
        : basisDataConsent === "pending"
          ? `Du hast um Erlaubnis für die Fragerunde gebeten. Werte ausschließlich die aktuelle Antwort aus. Bei Zustimmung beginne mit der ersten noch offenen Frage. Bei Ablehnung gehe zur E-Mail-Adresse. Stelle die Erlaubnisfrage nicht erneut.`
          : `Die Erlaubnis für die Fragerunde liegt vor. Bleibe ab jetzt strikt im Fragenkatalog und stelle genau eine noch offene Frage pro Turn.`,
      `Die Freiwilligkeit wurde vor der Fragerunde bereits geklärt. Sage bei den einzelnen Fragen NICHT mehr "wenn Sie möchten", "falls Sie das sagen wollen", "freiwillig", "oder lieber später" und biete nicht von dir aus an, einzelne Punkte zu überspringen. Stelle die Frage freundlich und direkt.`,
      `Nur wenn der Kunde VON SICH AUS eine konkrete Frage nicht beantworten möchte: Sage knapp "Kein Problem, dann überspringen wir diesen Punkt." und stelle direkt die nächste noch offene Frage. Nicht nach dem Grund fragen.`,
      `Reihenfolge der noch offenen Fragen: ${pkvData?.missing.join(" → ") || "keine"}.`,
      `KATALOG-SPERRE: Ausschließlich die erste noch offene Frage aus dieser Reihenfolge stellen. Keine Beitragsprognose, keine Sensibilisierung, keine Konzept-Erklärung, keine Terminfrage und keine Wiederholung bereits erfasster oder übersprungener Felder.`,
      `Gesundheitsdaten ruhig und neutral abfragen. Die einmalige Zustimmung gilt für den gesamten Katalog; keine erneute Erlaubnis vor jeder Gesundheitsfrage einholen.`,
      `ABSOLUT VERBOTEN in Phase 8: Gespräch zusammenfassen, sich verabschieden, hangup=true setzen oder sagen, Herr Duic kläre alles erst im Termin. Solange Angaben offen sind und der Kunde sie nicht auf Mail verschoben hat, bleibst du in diesem Fragenblock.`,
      `WICHTIG: Bei den Gesundheitsfragen (Diagnosen/Behandlungen, Medikamente, stationäre Aufenthalte, psychische Behandlungen, Zähne/Zahnersatz, Allergien) gilt ein "Nein" als VOLLSTÄNDIGE und gültige Antwort. Kein Nachhaken, keine Umformulierung derselben Frage - sofort zur nächsten Frage übergehen.`,
      `Körpergröße und Gewicht als getrennte Fragen stellen. Nennt der Kunde freiwillig beides in einer Antwort, beide übernehmen und Gewicht NICHT erneut fragen.`,
    );
  } else if (phase === 10) {
    lines.push(
      `Der Fragenkatalog ist abgeschlossen oder wurde vom Kunden abgelehnt. Frag JETZT als einzige Aktion nach der E-Mail-Adresse für die Terminbestätigung.`,
      `Beispiel: "Darf ich noch kurz Ihre E-Mail-Adresse für die Terminbestätigung notieren?"`,
      `Kein hangup. Kein Zusammenfassen. Nur diese eine Frage.`,
    );
  } else if (phase >= 11) {
    lines.push(
      `E-Mail ist abgehakt. Jetzt SOFORT die Abschluss-Zusammenfassung und Verabschiedung.`,
      `ABSOLUT VERBOTEN: Keine weiteren Fragen. Nicht nach Ansprechpartner, nicht nach Basisangaben, nicht nach irgendetwas.`,
      `ABSOLUT VERBOTEN: Keine neue Sensibilisierung mehr, keine Reform- oder Kostendiskussion mehr, kein Nachschub an Argumenten.`,
      `Schreibe 3–4 Sätze:`,
      `(1) Termin: VERWENDE WORT FÜR WORT die eingefrorene Slot-Phrase aus dem System-Prompt. Kein anderes Datum, kein anderer Wochentag. Formuliere ihn als persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic - niemals als Telefontermin.`,
      `(2) Was passiert beim Termin: kurze persönliche Vertragsanalyse, Beitragsprognose, konkrete Stellschrauben.`,
      `(3) Hinweis auf Terminbestätigung per E-Mail.`,
      `(4) Freundliche Vor-Verabschiedung im Namen des Owners OHNE Abschlussformel, z. B. "Herr Duic freut sich auf das Gespräch. Vielen Dank für Ihre Zeit." — NICHT "Ich freue mich".`,
      `(5) hangup=false in DIESER Antwort. Wenn der Kunde sich danach verabschiedet, antworte im nächsten Turn ausschließlich mit "Auf Wiederhören!" und setze dann hangup=true.`,
    );
  }

  // HARD RULES — nur das wirklich Nicht-Verhandelbare
  lines.push(
    ``,
    `WAS IMMER GILT:`,
    `- Meist 1-2 kurze Sätze pro Antwort, höchstens 1 Hauptfrage. Kein Monolog. (Ausnahme: Phase 11 Abschluss-Zusammenfassung — dort bis zu 4 Sätze erlaubt.)`,
    `- ERSTKONTAKT: Nie so sprechen, als kenne der Kunde euch bereits. Keine erfundene Nähe, keine erfundene Empfehlung, keine manipulative Verknappung.`,
    `- PERMISSION-BASED: Bevor du persönliche oder finanzielle Angaben erfragst, erkläre knapp, welchen konkreten Nutzen die Antwort für den Kunden hat, und mache die Freiwilligkeit sprachlich klar.`,
    `- AUSNAHME FRAGENKATALOG: Nach der einmaligen Zustimmung zu Phase 8 keine Freiwilligkeits- oder Überspringen-Hinweise mehr an jede Einzelfrage hängen. Nur auf eine vom Kunden selbst geäußerte Ablehnung reagieren.`,
    `- DIALOG STATT INTERVIEW: Stelle nie mehr als zwei Informationsfragen hintereinander. Dazwischen muss eine echte Reaktion mit Bezug auf das Gesagte oder ein hilfreicher Substanzsatz stehen.`,
    `- AUSSPRECHEN-LASSEN: Unterbrich den Anrufenden nie. Reagiere erst, wenn ein Gedanke erkennbar abgeschlossen ist. Bei Fragmenten oder stockendem Satz lieber kurz warten als zu früh antworten.`,
    `- Keine leeren Bestätigungen wie "prima", "perfekt", "super" oder "alles klar" in Serie. Besonders bei sensiblen Angaben neutral und respektvoll reagieren.`,
    `- Natürlicher Sprachfluss vor Skriptklang: keine starren Wiederholungen wie "Vielen Dank" in jedem Turn, keine identischen Satzanfange in Folge.`,
    `- Wenn der Kunde knapp oder in Fragmenten antwortet, erst kurz den Sinn sichern und dann weiterführen - nicht vorschnell in den nächsten Pitch springen.`,
    `- EINWAND-QUALITÄT: Bei Einwänden in genau dieser Reihenfolge antworten: (1) kurz validieren, (2) ein konkreter Substanzsatz, (3) eine klare Rückfrage.`,
    `- KONKRET STATT GENERISCH: Greife mindestens ein konkretes Wort aus der letzten Kundenantwort auf (z. B. "Beitrag", "Zeit", "gesetzlich"), bevor du weiterführst.`,
    `- RHYTHMUS: Vermeide Füllsätze wie "Ich verstehe" in Serie. Variiere Bestätigungen natürlich (z. B. "guter Punkt", "verständlich", "das höre ich oft").`,
    `- AUFZEICHNUNGSFRAGE: Natürlich formulieren, z.B. "Darf ich kurz mitschneiden?" oder "Darf ich das Gespräch aufzeichnen?" — NIEMALS "Bitte antworten Sie mit JA oder NEIN" sagen.`,
    `- Aufzeichnungsfrage nur einmal. Bei Nein: normal weiterführen. Frage NIEMALS erneut nach Aufzeichnung oder Mitschnitt — auch nicht mit anderen Formulierungen wie "damit Herr X sich vorbereiten kann".`,
    `- WICHTIGER GESPRÄCHSFLUSS: Nach Aufzeichnung erst Relevanz/Sensibilisierung (allgemein -> persönlich -> Denkfrage), dann Konzept-Bridge, dann Terminfrage.`,
    `- TERMINART: Es geht um einen persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic. Nenne niemals einen Telefontermin für den eigentlichen Fachtermin. Die Telefonie ist nur der Erstkontakt zur Terminvereinbarung.`,
    `- Kein Geschlecht aus Nachnamen ableiten.`,
    `- Termine nur Mo–Fr, 09:00–19:00 Uhr. Schlage NIEMALS einen Slot an oder vor dem heutigen Datum vor.`,
    `- Vor Phase 7 MUSS Phase 5 (Sensibilisierung) und Phase 6 (Konzept-Bridge) erfolgt sein. Keine direkte Terminierung aus dem Opener heraus.`,
    `- Biete in der Terminphase immer genau zwei Optionen aus der NÄCHSTEN WOCHE an. Kein Folgetag-Termin als Erstvorschlag.`,
    `- UHRZEIT-FORMAT (KRITISCH für Sprachausgabe): Schreibe Uhrzeiten IMMER in Worten — "zehn Uhr dreißig", "vierzehn Uhr" — NIEMALS als Ziffern ("10:30", "14:00").`,
    `- ZAHLEN-SPRACHE: Vermeide Dezimalschreibweisen wie "2,5" im gesprochenen Satz. Nutze natürliche Formen wie "zweieinhalb Prozent" oder "zwei Komma fünf Prozent".`,
    `- DATUM-FORMAT (KRITISCH): Schreibe Datum immer ausgeschrieben — "Dienstag, den elften Mai" — NIEMALS "11. Mai" oder "11.05.".`,
    `- SLOT EINGEFROREN: Sobald du einen Termin bestätigt hast, ist dieser Slot gesperrt. Nenne NUR diesen Slot. Berechne NIE neu. Erfinde KEINEN anderen Wochentag oder Datum.`,
    `- Den gewünschten Gesprächspartner nie als deinen Auftraggeber bezeichnen.`,
    `- VERBOTEN: Formulierungen wie "laut PKV-Verband" oder pauschale Quellen-Claims.`,
    `- THEMENTRENNUNG: Begriffe wie "Rente" oder "Ruhestand" nur im PKV-/Krankenversicherungs-Kontext verwenden. Bei gewerblichen Versicherungen NIEMALS erwähnen.`,
    `- Bei Skepsis zuerst transparent beantworten, nicht kontern. Bei "kein Interesse" höchstens eine kurze Relevanzfrage ohne Druck; jedes weitere Nein beendet das Gespräch würdevoll.`,
    `- hangup=true NUR wenn du in DIESER Antwort eine Verabschiedung ("Auf Wiederhören", "Schönen Tag", "Tschüss" o.ä.) sagst — NICHT beim Zusammenfassen, NICHT beim E-Mail-Fragen.`,
    `- WEITERLEITUNG ZU FRAU BROST: Wenn der Anrufende ausdrücklich mit einem Menschen sprechen möchte, sagst du: "Gerne, ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin. Falls die Verbindung nicht sofort klappt, meldet sie sich kurzfristig bei Ihnen." Dann transfer=true setzen. Biete die Weiterleitung NICHT ungefragt an — nur wenn der Kunde danach fragt oder explizit ablehnt, mit einer KI zu sprechen.`,
    `- TRANSPARENZ OHNE SELBSTSABOTAGE: Erwaehne nicht ungefragt "KI", "Bot" oder "Roboter". Wenn direkt gefragt wird, antworte offen und professionell: du arbeitest als digitale Assistentin im Auftrag von ${owner} und kannst auf Wunsch sofort an einen Menschen weiterleiten.`,
  );
  if (ctx.confirmedSlotPhrase) {
    lines.push(`- EINGEFROREN: "${ctx.confirmedSlotPhrase}" — nur diese Terminphrase verwenden.`);
  }

  return lines.join("\n");
}
function inferConversationPhase(ctx: CallContext): number {
  const turns = ctx.transcript;
  if (!turns.length) return 1;

  const all = turns.map((t) => t.text.toLowerCase()).join(" \n ");
  const assistantText = turns
    .filter((t) => t.role === "assistant")
    .map((t) => t.text.toLowerCase())
    .join(" \n ");
  const hasConsentQuestion = /aufzeichn|mitschneid/.test(all);
  const hasConsentAnswer = recordingConsentResolved(ctx);

  // Termin-Hinweis: Mehrere Signale nötig, damit ein einzelnes Schlüsselwort
  // (z. B. "Montag" in einem anderen Kontext) keinen Phase-Sprung auslöst.
  // Mindestens ZWEI der folgenden Signale müssen zusammen auftreten:
  //   (a) Tageszeit-Präferenz: "Vormittag" / "Nachmittag"
  //   (b) konkrete Uhrzeit mit "Uhr"
  //   (c) Wochentag + "Uhr" in unmittelbarer Nähe (Kontextfenster 5 Wörter)
  //   (d) direkte Terminanfrage von Gloria ("wann passt", "welcher Tag", "wie wäre")
  const hasTimePreference = /\b(vormittag|nachmittag)\b/.test(all);
  const hasClockTime = /\b\d{1,2}\s*uhr|\buhr\s+\w+\b/.test(all);
  const hasWeekdayWithTime = /\b(montag|dienstag|mittwoch|donnerstag|freitag)\b.{0,40}\buhr\b/.test(all);
  const hasAppointmentRequest = /\b(wann passt|welcher tag|wie w[äa]re|haben sie [a-z]+ zeit|schreiben sie|kann ich ihnen|soll ich ihnen)\b/.test(all);
  const termSignals = [hasTimePreference, hasClockTime, hasWeekdayWithTime, hasAppointmentRequest].filter(Boolean).length;
  const hasTermHint = termSignals >= 2;

  // Sensibilisierung + Konzept-Bridge vor der Terminphase erzwingen.
  const hasSensitization =
    /beitragssteiger|anpassung|wie hoch.*beitrag|monatsbeitrag|bemerkt.*beitrag/.test(all);
  const hasNumericProof =
    /vier prozent|hochrechnen|zehn jahre|f[üu]nfzigtausend|1300|1\.300/.test(all);
  const hasConceptBridge =
    /vertragsanalyse|prognose|stellschrauben|ohne verkaufsdruck|gespr[aä]ch mit herrn duic|herr duic schaut/.test(all);

  const hasConfirmedSlot = Boolean(ctx.confirmedSlotPhrase);
  const pkvData = collectPkvData(ctx);
  const hasDataCollection = pkvData.missing.length === 0;
  const basisDataConsent = getBasisDataConsentState(ctx);
  // Kunde hat Basisangaben abgelehnt: Gloria hat "Terminbestätigungsmail" oder "in Ruhe beantworten" gesagt
  const hasBasisdatenRefused = /terminbest[äa]tigungsmail|in ruhe (?:beantworten|erg[äa]nzen)|per mail beantworten|bleibt es (?:jetzt )?bei der terminbest[äa]tigung|angaben.*sp[äa]ter/i.test(assistantText);
  const hasEmailAsked = /(?:ihre|welche|an welche)\s+e-?mail(?:-adresse)?|e-?mail(?:-adresse)?[^.?!]{0,50}(?:nennen|notieren|best[äa]tigung|schicken)/i.test(assistantText);
  const hasSummary = /ich fasse kurz zusammen|auf wiederhören|auf wiedersehen|schönen tag noch/.test(assistantText);

  if (!hasConsentQuestion) return 2;
  if (!hasConsentAnswer) return 2;

  // Vor Terminbestätigung: erst Sensibilisierung, dann Konzept-Bridge, dann Terminierung.
  if (!hasSensitization) return 4;
  if (!hasNumericProof) return 5;
  if (!hasConceptBridge) return 6;
  if (!hasTermHint) return 6;
  if (!hasConfirmedSlot) return 7;

  // Termin ist bestätigt: dann Basisdaten -> E-Mail -> Abschluss.
  const skipBasisData = basisDataConsent === "declined" || hasBasisdatenRefused;
  if (!skipBasisData && !hasDataCollection) return 8;
  if (!hasEmailAsked) return 10;  // E-Mail fragen
  if (!hasSummary) return 11;     // Zusammenfassung + Verabschiedung
  return 11;
}

type PkvField =
  | "Geburtsdatum"
  | "Körpergröße"
  | "Gewicht"
  | "Versicherer"
  | "Monatsbeitrag"
  | "Diagnosen/Behandlungen"
  | "Medikamente"
  | "stationäre Aufenthalte"
  | "psychische Behandlungen"
  | "Zähne/Zahnersatz"
  | "Allergien";

const PKV_FIELDS: PkvField[] = [
  "Geburtsdatum", "Körpergröße", "Gewicht", "Versicherer", "Monatsbeitrag",
  "Diagnosen/Behandlungen", "Medikamente", "stationäre Aufenthalte",
  "psychische Behandlungen", "Zähne/Zahnersatz", "Allergien",
];

const PKV_QUESTIONS: Record<PkvField, string> = {
  Geburtsdatum: "Wie lautet Ihr Geburtsdatum?",
  Körpergröße: "Wie groß sind Sie?",
  Gewicht: "Wie hoch ist Ihr aktuelles Gewicht?",
  Versicherer: "Bei welchem Krankenversicherer sind Sie aktuell versichert?",
  Monatsbeitrag: "Wie hoch ist Ihr aktueller Monatsbeitrag?",
  "Diagnosen/Behandlungen": "Gibt es aktuell bekannte Diagnosen oder laufende Behandlungen?",
  Medikamente: "Nehmen Sie aktuell regelmäßig Medikamente ein?",
  "stationäre Aufenthalte": "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
  "psychische Behandlungen": "Gab es in den letzten zehn Jahren psychische Behandlungen oder entsprechende Diagnosen?",
  "Zähne/Zahnersatz": "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
  Allergien: "Sind bei Ihnen Allergien bekannt?",
};

export function buildDeterministicPostBookingReply(ctx: CallContext): TurnOutput | null {
  if (!ctx.confirmedSlotPhrase) return null;

  const summarySentWithoutFinalFarewell = ctx.transcript.some(
    (turn) =>
      turn.role === "assistant" &&
      /ihr pers[öo]nlicher termin mit herrn duic ist am/i.test(turn.text) &&
      !/auf wiederh[öo]ren/i.test(turn.text),
  );
  if (summarySentWithoutFinalFarewell) {
    const latestUserTurn = [...ctx.transcript].reverse().find((turn) => turn.role === "user");
    if (latestUserTurn && /\b(auf wiederh[öo]ren|auf wiedersehen|tsch[üu]ss|tsch[üu]s|ciao|bis dann|bis bald|einen sch[öo]nen tag)\b/i.test(latestUserTurn.text)) {
      return {
        reply: "Auf Wiederhören!",
        hangup: true,
        transfer: false,
      };
    }
    return null;
  }

  const pkvData = collectPkvData(ctx);
  const isPkvCall = /pkv|kranken/.test((ctx.topic || "").toLowerCase());
  if (isPkvCall) {
    const basisDataConsent = getBasisDataConsentState(ctx);
    if (basisDataConsent === "not-asked") {
      return {
        reply: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?",
        hangup: false,
        transfer: false,
      };
    }

    if (basisDataConsent === "granted" && pkvData.missing.length > 0) {
      return {
        reply: PKV_QUESTIONS[pkvData.missing[0]],
        hangup: false,
        transfer: false,
      };
    }
  }

  let emailQuestionIndex = -1;
  for (let index = ctx.transcript.length - 1; index >= 0; index -= 1) {
    const turn = ctx.transcript[index];
    if (turn.role === "assistant" && /e-?mail(?:-adresse)?.*(?:terminbest[äa]tigung|best[äa]tigung)|terminbest[äa]tigung.*e-?mail/i.test(turn.text)) {
      emailQuestionIndex = index;
      break;
    }
  }
  if (emailQuestionIndex < 0) {
    return {
      reply: "Welche E-Mail-Adresse darf ich für die Terminbestätigung notieren?",
      hangup: false,
      transfer: false,
    };
  }

  const emailAnswer = ctx.transcript
    .slice(emailQuestionIndex + 1)
    .find((turn) => turn.role === "user")?.text.trim() || "";
  const emailTurnsSinceQuestion = ctx.transcript
    .slice(emailQuestionIndex + 1)
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ");
  const resolvedEmail = extractSpokenEmail(emailTurnsSinceQuestion) || pkvData.email;
  const emailDeclined = /^(?:nein\b|keine e-?mail|ohne e-?mail|m[öo]chte ich nicht|lieber nicht)/i.test(emailAnswer);
  if (!resolvedEmail && !emailDeclined) {
    return {
      reply: "Ich habe die E-Mail-Adresse noch nicht vollständig verstanden. Bitte nennen Sie sie noch einmal, gern mit At und Punkt.",
      hangup: false,
      transfer: false,
    };
  }

  const confirmationSentence = resolvedEmail
    ? `Die Terminbestätigung sende ich an ${resolvedEmail}.`
    : "Die Terminbestätigung erfolgt wie besprochen ohne E-Mail.";
  return {
    reply: `Ihr persönlicher Termin mit Herrn Duic ist am ${ctx.confirmedSlotPhrase}. Herr Duic bereitet die Vertragsanalyse und Beitragsprognose für Sie vor. ${confirmationSentence} Herr Duic freut sich auf das Gespräch. Vielen Dank für Ihre Zeit.`,
    hangup: false,
    transfer: false,
  };
}

function recordingConsentResolved(ctx: CallContext): boolean {
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== "assistant" || !/aufzeichn|mitschneid/i.test(turns[i].text)) continue;
    for (let j = i + 1; j < turns.length; j += 1) {
      const turn = turns[j];
      if (turn.role !== "user") continue;
      const decision = parseRecordingConsentDecision(turn.text);
      if (decision) return true;
    }
    return false;
  }
  return false;
}

function getBasisDataConsentState(ctx: CallContext): "not-asked" | "pending" | "granted" | "declined" {
  const turns = ctx.transcript;
  const askIndex = turns.findIndex(
    (turn) =>
      turn.role === "assistant" &&
      /(?:einige|ein paar|kurze)\s+(?:fragen|basisangaben|eckdaten)|fragen.*(?:vorbereitung|in ordnung)|angaben.*(?:vorbereitung|kl[äa]ren)/i.test(turn.text),
  );
  if (askIndex < 0) return "not-asked";

  const answer = turns.slice(askIndex + 1).find((turn) => turn.role === "user")?.text.trim().toLowerCase();
  if (!answer) return "pending";
  if (/^(?:ja\b|jawohl|gerne\b|klar\b|okay\b|ok\b|(?:das\s+)?ist(?:\s+f[üu]r mich)?\s+in ordnung|passt\b|k[öo]nnen wir|machen wir|von mir aus)/i.test(answer)) {
    return "granted";
  }
  if (/^(?:nein\b|nö\b|lieber nicht|nicht jetzt|per mail|sp[äa]ter|ungern|(?:das\s+)?m[öo]chte ich nicht)/i.test(answer)) {
    return "declined";
  }
  return "pending";
}

function collectPkvData(ctx: CallContext): {
  values: Partial<Record<PkvField, string>>;
  missing: PkvField[];
  skipped: PkvField[];
  email?: string;
} {
  const values: Partial<Record<PkvField, string>> = {};
  const skipped = new Set<PkvField>();
  const turns = ctx.transcript;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const question = turn.text.toLowerCase();
    const answers: string[] = [];
    for (let j = i + 1; j < turns.length && turns[j].role === "user"; j += 1) answers.push(turns[j].text);
    const answer = answers.join(" ").replace(/\s+/g, " ").trim();
    if (!answer) continue;

    const refusedField = detectAskedPkvField(question);
    if (refusedField && isExplicitFieldRefusal(answer)) {
      skipped.add(refusedField);
      continue;
    }

    if (/geburtsdatum|wann.*geboren/.test(question)) values.Geburtsdatum = answer;
    if (/k[öo]rpergr[öo][ßs]e|wie gro[ßs]/.test(question)) values.Körpergröße = answer;
    if (/gewicht|wie viel wiegen/.test(question)) values.Gewicht = answer;
    if (/krankenversicherer|welcher.*(?:kasse|versicherung)/.test(question)) values.Versicherer = answer;
    if (/monatsbeitrag|wie hoch.*beitrag/.test(question)) values.Monatsbeitrag = answer;
    if (/diagnos|laufende behandlung/.test(question)) values["Diagnosen/Behandlungen"] = answer;
    if (/medikament/.test(question)) {
      const medicationOnly = /^(?:eine?|einen?)\s+medikamente?[.!?]?$/i.test(answer);
      if (!medicationOnly) values.Medikamente = answer;
    }
    if (/station[äa]re|krankenhaus/.test(question)) values["stationäre Aufenthalte"] = answer;
    if (/psychisch/.test(question)) values["psychische Behandlungen"] = answer;
    if (/z[äa]hne|zahnersatz/.test(question)) values["Zähne/Zahnersatz"] = answer;
    if (/allerg/.test(question)) values.Allergien = answer;

    // Freiwillige Kombi-Antworten übernehmen, auch wenn nur nach einem Feld gefragt wurde.
    if (
      /\b(?:1|ein(?:s|en)?)\s*(?:meter|m)\b/i.test(answer) ||
      /\b(?:meter|komma)\s+[a-zäöüß\d-]+(?:\s+gro[ßs])?/i.test(answer) ||
      /\b\d[,.]\d{2}\s*(?:meter|m)?\b/i.test(answer)
    ) {
      values.Körpergröße = answer;
    }
    if (
      /\b(?:kilo\s*gramm|kilogramm|kilo|kg)\b/i.test(answer) ||
      /\b(?:1[,.]\d{2}|ein(?:s|en)?\s+meter(?:\s+\w+)?)\b[^.?!]{0,35}\b(?:[3-9]\d|1\d{2}|2[0-4]\d)\b/i.test(answer)
    ) {
      values.Gewicht = answer;
    }
    if (/\b(?:euro|€)\b/i.test(answer) && /beitrag|zahl|kost/i.test(`${question} ${answer}`)) values.Monatsbeitrag = answer;
  }

  const email = extractSpokenEmail(turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" "));
  return {
    values,
    missing: PKV_FIELDS.filter((field) => !values[field] && !skipped.has(field)),
    skipped: [...skipped],
    email,
  };
}

function buildDeterministicTrustReply(ctx: CallContext, userText: string): TurnOutput | null {
  const text = userText.toLowerCase();
  const owner = ctx.ownerRealName?.trim() || "Herrn Duic";

  const asksIfAi = /(bist|sind)\s+(du|sie)\s+(eine\s+)?(ki|ai|bot|roboter)|mit\s+(einer\s+)?ki|sprich(e|en)\s+ich\s+mit\s+(einer\s+)?(ki|ai|bot|roboter)/i.test(text);
  const rejectsAi = /(keine?\s+ki|nicht\s+mit\s+(einer\s+)?ki|nur\s+(mit\s+)?(einem\s+)?menschen|echten?\s+menschen|kein\s+bot|nicht\s+mit\s+bot|keinen\s+roboter)/i.test(text);
  const asksHuman = /(mit\s+(einem\s+)?menschen\s+sprechen|mitarbeiter(in)?\s+sprechen|verbinden\s+sie\s+mich|stellen\s+sie\s+durch|durchstellen)/i.test(text);

  if (rejectsAi || asksHuman) {
    return {
      reply: "Verstanden, das respektiere ich. Ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin.",
      hangup: false,
      transfer: true,
    };
  }

  if (asksIfAi) {
    return {
      reply: `Ja, ich arbeite als digitale Assistentin im Auftrag von ${owner}. Wenn Ihnen lieber ist, verbinde ich Sie sofort mit Jutta Brost.`,
      hangup: false,
      transfer: false,
    };
  }

  return null;
}

function isExplicitFieldRefusal(answer: string): boolean {
  return /\b(?:m[öo]chte|will|werde)\s+(?:ich\s+)?(?:nicht|nichts)\s+(?:beantworten|sagen|angeben)|\b(?:keine angabe|sage ich nicht|beantworte ich nicht|geht sie nichts an|[üu]berspringen wir|lassen wir (?:das|die frage))\b/i.test(answer);
}

function detectAskedPkvField(question: string): PkvField | undefined {
  const patterns: Array<[PkvField, RegExp]> = [
    ["Geburtsdatum", /geburtsdatum|wann.*geboren/i],
    ["Körpergröße", /k[öo]rpergr[öo][ßs]e|wie gro[ßs]/i],
    ["Gewicht", /gewicht|wie viel wiegen/i],
    ["Versicherer", /krankenversicherer|welcher.*(?:kasse|versicherung)/i],
    ["Monatsbeitrag", /monatsbeitrag|wie hoch.*beitrag/i],
    ["Diagnosen\/Behandlungen", /diagnos|laufende behandlung/i],
    ["Medikamente", /medikament/i],
    ["stationäre Aufenthalte", /station[äa]re|krankenhaus/i],
    ["psychische Behandlungen", /psychisch/i],
    ["Zähne\/Zahnersatz", /z[äa]hne|zahnersatz/i],
    ["Allergien", /allerg/i],
  ];
  let detected: { field: PkvField; index: number } | undefined;
  for (const [field, pattern] of patterns) {
    const match = pattern.exec(question);
    if (match && (!detected || match.index > detected.index)) detected = { field, index: match.index };
  }
  return detected?.field;
}

function extractSpokenEmail(text: string): string | undefined {
  const directEmail = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)?.at(-1);
  if (directEmail) return directEmail;

  const candidates = text.toLowerCase().match(/[a-z0-9_%+-]+(?:\s*(?:punkt|dot|\.)\s*[a-z0-9_%+-]+)*\s*(?:at|ät|@)\s*[a-z0-9-]+(?:\s*(?:punkt|dot|\.)\s*[a-z0-9-]+)+/gi);
  const raw = candidates?.at(-1);
  if (raw) {
    const normalized = raw
      .toLowerCase()
      .replace(/\s+(?:at|ät)\s+/g, "@")
      .replace(/\s*@\s*/g, "@")
      .replace(/\s*(?:punkt|dot|\.)\s*/g, ".")
      .replace(/\.\s*([a-z])\s+([a-z])\b/g, ".$1$2")
      .replace(/\s+/g, "");
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return normalized;
  }

  // Fallback for spelled addresses like "info at firma punkt d e" spread across turns.
  const normalizedAcrossTurns = text
    .toLowerCase()
    .replace(/\b(?:klammeraffe|at|ät|aett?)\b/g, "@")
    .replace(/\s*@\s*/g, "@")
    .replace(/\b(?:punkt|dot)\b/g, ".")
    .replace(/[<>()[\],;:"']/g, "")
    .replace(/\s+/g, "");
  const fallbackEmail = normalizedAcrossTurns.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)?.at(-1);
  return fallbackEmail;
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
    "- Nutze sparsame Höflichkeitsmarker: ein kurzes Danke ist okay, aber nicht als Pflicht in jeder Zeile.",
    "- Priorität hat Anschlussfähigkeit: zuerst kurz auf den letzten Kundengedanken eingehen, dann sauber weiterführen.",
    "- Verwende in Einwandmomenten kurze Dreischritt-Antworten: validieren, konkretisieren, rückfragen.",
    "- Halte den Ton charmant und auf Augenhöhe: klar führen, aber niemals belehrend.",
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

