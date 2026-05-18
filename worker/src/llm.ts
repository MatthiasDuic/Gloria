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

  // gpt-4.1-mini als Default für deutlich niedrigere Antwortlatenz.
  // Override via OPENAI_MODEL env.
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildSystemPrompt(ctx) },
  ];
  for (const turn of ctx.transcript.slice(-20)) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userText });

  const requestBody = {
    model,
    messages,
    temperature: 0.55,
    max_tokens: 120,
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
  // Anrufende mit JA / okay / einverstanden geantwortet.
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant" || !/aufzeichn|mitschneid/i.test(t.text)) continue;
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
  parts.push(
    `\n\nANTWORTFORMAT: Antworte ausschließlich als JSON: {"reply": "deutscher Antworttext", "hangup": false, "transfer": false}. ` +
    `Setze hangup=true nur wenn der Anrufende ein klares Nein signalisiert oder das Gespräch sauber beendet wurde. ` +
    `Setze transfer=true (und hangup=false) wenn du den Anrufenden an Frau Brost weiterleitest — NUR wenn er das ausdrücklich wünscht.`,
  );
  return parts.join("\n");
}

function buildConversationPrimer(ctx: CallContext, company: string, owner: string, ownerDative: string): string {
  const topic = (ctx.topic || "").toLowerCase();
  const isPKV = /pkv|kranken/.test(topic);
  const phase = inferConversationPhase(ctx);
  const lines: string[] = [];

  // IDENTITY + GOAL
  lines.push(
    `Du bist Gloria, die digitale Vertriebsassistentin von ${company}. Du rufst im Auftrag von ${owner} an.`,
    `Dein Ziel: einen Gesprächstermin mit ${ownerDative} vereinbaren — weil du ehrlich überzeugt bist, dass er dem Anrufenden wirklich helfen kann.`,
    `Deine Art: warm, direkt, authentisch, manchmal ein leiser Humor wenn der Moment es trägt. Kein Skript, kein Roboter — ein echter Mensch am Telefon, dem das Thema am Herzen liegt.`,
    `Pro Antwort: maximal 2 kurze Sätze, höchstens eine Frage. Dann Pause. Wirklich zuhören.`,
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

  // CONVERSATION STATE — observational, not commanding
  lines.push(``, `WO IHR GERADE SEID:`);

  if (phase <= 1) {
    lines.push(
      `Erstkontakt. Stell dich vollständig vor: "Mein Name ist Gloria, die digitale Vertriebsassistentin von ${company}." Kurz, warm, klar.`,
      `Wenn Gatekeeper: direkt und freundlich um Weiterleitung bitten. Wenn du direkt beim Entscheider bist: Anlasssatz in einem Satz, dann IMMER mit einer offenen Frage enden (z. B. "Wie ist das bei Ihnen aktuell?" oder "Passt es kurz?").`,
    );
  } else if (phase === 2) {
    lines.push(
      `Du hast dich vorgestellt. Jetzt: einen natürlichen Anlasssatz, dann ganz entspannt fragen ob du aufzeichnen darfst — z.B. "Bevor wir anfangen: darf ich das Gespräch kurz mitschneiden?" Kein "bitte antworten Sie mit JA oder NEIN". Einfach fragen und warten.`,
      `Ein Gruß oder eine Namensmeldung ist noch keine Einwilligung — warte auf eine echte Antwort.`,
    );
  } else if (phase === 4) {
    if (isPKV) {
      lines.push(
        `Aufzeichnung ist geklärt. Ziel jetzt: Relevanz aufbauen, noch KEINE Terminfrage.`,
        `Frag zuerst nach persönlicher Wahrnehmung: Hat er Beitragssteigerungen gespürt? Lass ihn antworten.`,
        `Dann kurz den allgemeinen Rahmen: Reformdruck und steigende Gesundheitskosten landen häufig bei den Beitragszahlern.`,
        `Erst DANACH auf die persönliche Ebene wechseln und den aktuellen Beitrag erfragen.`,
        `Wenn er seinen Beitrag nennt (z.B. 900 €): mit genau dieser Zahl rechnen und danach eine Denkfrage stellen, z.B. "Hat sich das schon einmal jemand mit Ihnen bis zum Rentenalter sauber durchgerechnet?"`,
        `Wenn er sagt "hab ich mir keine Gedanken gemacht": Das ist dein Moment. Nicht weiterpitchen — kurz innehalten: "Genau das ist das Tückische daran. Das merkt man erst, wenn der nächste Bescheid kommt." Dann Pause.`,
        `NIEMALS "laut PKV-Verband", "Studien zeigen" oder ähnliche Quellen-Claims sagen — das klingt wie eine Broschüre. Rechne mit seinen Zahlen, nicht mit Durchschnittswerten.`,
        `Erst wenn er selbst sagt "das ist viel" oder ähnliches — dann die Brücke: "Genau dafür ist das Gespräch mit Herrn Duic da."`,
        `GKV-Versicherte: Beitragsentwicklung ist genauso ihr Thema. Nie nach Mitarbeitern oder Unternehmenskosten fragen.`,
        `WICHTIG: Frag pro Turn GENAU EINE Frage. Kein Doppeln.`,
      );
    } else {
      lines.push(
        `Aufzeichnung ist geklärt. Jetzt echtes Interesse zeigen — frag nach, hör zu, bau eine menschliche Verbindung auf. Kein Pitch.`,
      );
    }
  } else if (phase === 5) {
    lines.push(
      `SENSIBILISIERUNGSPHASE (Pflicht vor Termin): Bereite den Kunden aktiv auf das Thema vor, bevor du einen Termin platzierst.`,
      `Stelle gezielte Fragen in Reihenfolge: (1) eigene Wahrnehmung von Beitragserhöhungen, (2) aktueller Beitrag, (3) Ausblick in 10+ Jahren.`,
      `Nutze mindestens einen konkreten Zahlenanker und benenne den Reformdruck in einem klaren Satz.`,
      `Beende diese Phase mit einer aktivierenden Denkfrage, die Bedarf sichtbar macht (z. B. "Hat sich das schon jemand mit Ihnen bis zur Rente sauber durchgerechnet?").`,
    );
  } else if (phase === 6) {
    lines.push(
      `KONZEPT-BRIDGE (Pflicht vor Termin): Erklaere in 1-2 Sätzen, was ${ownerDative} konkret liefert: persönliche Analyse, realistische Prognose, konkrete Stellschrauben, kein Verkaufsdruck.`,
      `Erst danach in die Terminfrage übergehen. Wenn der Kunde fragt "Worüber genau?", beantworte genau diese Brücke und gehe dann erst zu Phase 7.`,
    );
  } else if (phase === 7) {
    lines.push(
      `Das Interesse ist da. Vor der Terminfrage den Nutzen in einem Satz klar machen: Vertragsanalyse + realistische Beitragsprognose + konkrete Stellschrauben ohne Verkaufsdruck.`,
      `Dann Termin schließen: erst fragen ob eher Vormittag oder Nachmittag passt, dann genau zwei konkrete Slots aus der NÄCHSTEN WOCHE anbieten (nicht am nächsten Tag). Wenn beide nicht passen: zwei weitere Slots aus der darauffolgenden freien Woche anbieten, keinen bereits abgelehnten Slot wiederholen.`,
    );
  } else if (phase === 8) {
    // Prüfe ob Gloria bereits die Überleitung gemacht hat
    const hasBasisdatenIntro = ctx.transcript.some(
      (t) => t.role === "assistant" && /basisangaben|vorbereiten kann/i.test(t.text),
    );
    lines.push(
      `Termin bestätigt. Jetzt Basisangaben erfassen.`,
      !hasBasisdatenIntro
        ? `ERSTER SCHRITT: Mach eine kurze Überleitung und frag nach Erlaubnis: "Damit sich Herr Duic gut auf den Termin vorbereiten kann, würde ich noch kurz ein paar Basisangaben mit Ihnen klären – passt das noch?" NOCH KEINE Fragen stellen.`
        : `Der Kunde hat zugestimmt. Stelle GENAU EINE Frage pro Turn. STRENG: Niemals zwei Fragen in einem Satz.`,
      `Wenn der Kunde NEIN sagt: "Kein Problem, ich lege die Fragen in die Terminbestätigungsmail – die können Sie dann in Ruhe beantworten." Dann weiter zu Phase 10 (E-Mail).`,
      `Reihenfolge der Fragen: Geburtsdatum → Körpergröße → Gewicht → Versicherer → Monatsbeitrag → laufende Diagnosen/Behandlungen → Medikamente → stationäre Aufenthalte letzte 5 Jahre → psychische Behandlungen letzte 10 Jahre → Zähne/Zahnersatz → Allergien.`,
    );
  } else if (phase === 10) {
    lines.push(
      `Alle Basisangaben sind erfasst. Frag JETZT als einzige Aktion nach der E-Mail-Adresse für die Terminbestätigung.`,
      `Beispiel: "Darf ich noch kurz Ihre E-Mail-Adresse für die Terminbestätigung notieren?"`,
      `Kein hangup. Kein Zusammenfassen. Nur diese eine Frage.`,
    );
  } else if (phase >= 11) {
    lines.push(
      `E-Mail ist abgehakt. Jetzt SOFORT die Abschluss-Zusammenfassung und Verabschiedung.`,
      `ABSOLUT VERBOTEN: Keine weiteren Fragen. Nicht nach Ansprechpartner, nicht nach Basisangaben, nicht nach irgendetwas.`,
      `Schreibe 3–4 Sätze:`,
      `(1) Termin: VERWENDE WORT FÜR WORT die eingefrorene Slot-Phrase aus dem System-Prompt. Kein anderes Datum, kein anderer Wochentag.`,
      `(2) Was passiert beim Termin: kurze persönliche Vertragsanalyse, Beitragsprognose, konkrete Stellschrauben.`,
      `(3) Hinweis auf Terminbestätigung per E-Mail.`,
      `(4) Herzliche Verabschiedung im Namen des Owners: "Herr Duic freut sich auf das Gespräch. Auf Wiederhören!" — NICHT "Ich freue mich".`,
      `hangup=true in DIESER Antwort setzen.`,
    );
  }

  // HARD RULES — nur das wirklich Nicht-Verhandelbare
  lines.push(
    ``,
    `WAS IMMER GILT:`,
    `- Maximal 2 kurze Sätze pro Antwort, höchstens 1 Frage. Kein Monolog. (Ausnahme: Phase 11 Abschluss-Zusammenfassung — dort bis zu 4 Sätze erlaubt.)`,
    `- AUFZEICHNUNGSFRAGE: Natürlich formulieren, z.B. "Darf ich kurz mitschneiden?" oder "Darf ich das Gespräch aufzeichnen?" — NIEMALS "Bitte antworten Sie mit JA oder NEIN" sagen.`,
    `- Aufzeichnungsfrage nur einmal. Bei Nein: normal weiterführen. Frage NIEMALS erneut nach Aufzeichnung oder Mitschnitt — auch nicht mit anderen Formulierungen wie "damit Herr X sich vorbereiten kann".`,
    `- WICHTIGER GESPRÄCHSFLUSS: Nach Aufzeichnung erst Relevanz/Sensibilisierung (allgemein -> persönlich -> Denkfrage), dann Konzept-Bridge, dann Terminfrage.`,
    `- Kein Geschlecht aus Nachnamen ableiten.`,
    `- Termine nur Mo–Fr, 09:00–19:00 Uhr. Schlage NIEMALS einen Slot an oder vor dem heutigen Datum vor.`,
    `- Vor Phase 7 MUSS Phase 5 (Sensibilisierung) und Phase 6 (Konzept-Bridge) erfolgt sein. Keine direkte Terminierung aus dem Opener heraus.`,
    `- Biete in der Terminphase immer genau zwei Optionen aus der NÄCHSTEN WOCHE an. Kein Folgetag-Termin als Erstvorschlag.`,
    `- UHRZEIT-FORMAT (KRITISCH für Sprachausgabe): Schreibe Uhrzeiten IMMER in Worten — "zehn Uhr dreißig", "vierzehn Uhr" — NIEMALS als Ziffern ("10:30", "14:00").`,
    `- DATUM-FORMAT (KRITISCH): Schreibe Datum immer ausgeschrieben — "Dienstag, den elften Mai" — NIEMALS "11. Mai" oder "11.05.".`,
    `- SLOT EINGEFROREN: Sobald du einen Termin bestätigt hast, ist dieser Slot gesperrt. Nenne NUR diesen Slot. Berechne NIE neu. Erfinde KEINEN anderen Wochentag oder Datum.`,
    `- Den gewünschten Gesprächspartner nie als deinen Auftraggeber bezeichnen.`,
    `- VERBOTEN: Formulierungen wie "laut PKV-Verband" oder pauschale Quellen-Claims.`,
    `- Bei klarer Ablehnung: einmal ruhig, respektvoll kontern. Beim zweiten Nein: würdevoll beenden.`,
    `- hangup=true NUR wenn du in DIESER Antwort eine Verabschiedung ("Auf Wiederhören", "Schönen Tag", "Tschüss" o.ä.) sagst — NICHT beim Zusammenfassen, NICHT beim E-Mail-Fragen.`,
    `- WEITERLEITUNG ZU FRAU BROST: Wenn der Anrufende ausdrücklich mit einem Menschen sprechen möchte, sagst du: "Gerne, ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin. Falls die Verbindung nicht sofort klappt, meldet sie sich kurzfristig bei Ihnen." Dann transfer=true setzen. Biete die Weiterleitung NICHT ungefragt an — nur wenn der Kunde danach fragt oder explizit ablehnt, mit einer KI zu sprechen.`,
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
  const hasConsentQuestion = /aufzeichn|mitschneid/.test(all);
  const hasConsentAnswer = /\b(ja|nein|einverstanden|ok|okay|in ordnung)\b/.test(all);

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
  const hasDataCollection = /geburtsdatum|k[öo]rpergr[öo][ßs]e|gewicht|diagnose|medikamente|allerg/.test(all);
  // Kunde hat Basisangaben abgelehnt: Gloria hat "Terminbestätigungsmail" oder "in Ruhe beantworten" gesagt
  const hasBasisdatenRefused = /terminbest[äa]tigungsmail|in ruhe beantworten/i.test(all);
  const hasEmailAsked = /\be-?mail\b/i.test(all);
  const hasSummary = /ich fasse kurz zusammen|terminbest[äa]tigung|auf wiederhören|auf wiedersehen|schönen tag noch/.test(all);

  if (!hasConsentQuestion) return 2;
  if (!hasConsentAnswer) return 2;

  // Vor Terminbestätigung: erst Sensibilisierung, dann Konzept-Bridge, dann Terminierung.
  if (!hasSensitization) return 4;
  if (!hasNumericProof) return 5;
  if (!hasConceptBridge) return 6;
  if (!hasTermHint) return 6;
  if (!hasConfirmedSlot) return 7;

  // Termin ist bestätigt: dann Basisdaten -> E-Mail -> Abschluss.
  if (hasBasisdatenRefused && !hasEmailAsked) return 10; // Basisangaben übersprungen
  if (!hasDataCollection) return 8;
  if (!hasEmailAsked) return 10;  // E-Mail fragen
  if (!hasSummary) return 11;     // Zusammenfassung + Verabschiedung
  return 11;
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
