import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";
import { classifyInboundSpeech, looksLikeMeaningfulHumanTurn } from "./call-classification.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Outcome = "Termin" | "Absage" | "Wiedervorlage" | "Nicht erreicht / kein Kontakt" | "Gespräch abgebrochen";

type ExtractedReport = {
  outcome: Outcome;
  appointmentAt?: string;
  contactEmail?: string;
  summary: string;
  nextCallAt?: string;
  directDial?: string;
};

type ReportDocumentation = {
  conversationOccurred: boolean;
  callDisposition: "Gespraech" | "Anrufbeantworter" | "Warteschleife ohne Gespraech" | "Kein Gespraech";
  followUpPlanned: boolean;
  followUpAt?: string;
};

const EXTRACT_PROMPT = `Du bist ein Auswerter für Akquise-Telefonate. Lies das Transkript unten und gib AUSSCHLIESSLICH ein JSON-Objekt zurück mit folgenden Feldern:
{
  "outcome": "Termin" | "Absage" | "Wiedervorlage" | "Nicht erreicht / kein Kontakt" | "Gespräch abgebrochen",
  "appointmentAt": "ISO-8601 mit Zeitzone (z. B. 2026-04-30T15:00:00+02:00) oder null",
  "contactEmail": "vom Kunden bestätigte Mailadresse oder null",
  "nextCallAt": "ISO-8601 mit Zeitzone für den vereinbarten Rückruf-Zeitpunkt (NUR bei Wiedervorlage), sonst null",
  "directDial": "vom Anrufenden für den Rückruf genannte Direkt-Durchwahl/Mobilnummer als reine E.164- oder Klar-Ziffern-Zeichenkette (NUR bei Wiedervorlage), sonst null",
  "summary": "5–10 Sätze Deutsch, fasse Verlauf, Bedarf, vereinbarten Termin und ggf. erfasste Basisdaten zusammen"
}
Regeln:
- "Termin" nur, wenn ein konkreter Termin (Datum + Uhrzeit) bestätigt wurde.
- "Absage" wenn der Anrufende ablehnt.
- "Wiedervorlage" wenn auf später verschoben wurde, ohne festen Termin – insbesondere wenn der Anrufende keinen Kalender-Zugriff hatte und einen Rückruf-Zeitpunkt + (idealerweise) Direktdurchwahl genannt hat.
- "Nicht erreicht / kein Kontakt" wenn kein Kontakt zustande kam.
- "Gespräch abgebrochen" wenn jemand kurz angerufen wurde, aber das Gespräch nach dem Einstieg abgebrochen wurde.
- appointmentAt: nutze die LETZTE im Transkript bestätigte Termin-Aussage. Wenn der Anrufende "Donnerstag, 30. April, 15 Uhr" sagt, nimm das Datum exakt so.
- nextCallAt + directDial: NUR füllen, wenn outcome="Wiedervorlage" UND der Anrufende explizit Tag/Uhrzeit für den Rückruf bzw. eine Durchwahl/Nummer genannt UND bestätigt hat.
- contactEmail nur, wenn explizit vom Anrufenden buchstabiert/genannt UND bestätigt.`;

export async function extractReport(ctx: CallContext): Promise<ExtractedReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("finalize.no_openai_key");
    return null;
  }
  if (ctx.transcript.length < 2) {
    return null;
  }

  const transcriptText = ctx.transcript
    .map((t) => `${t.role === "user" ? "Kunde" : "Gloria"}: ${t.text}`)
    .join("\n");

  const today = new Date();
  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${EXTRACT_PROMPT}\n\nHeute ist ${todayStr}.` },
          { role: "user", content: `Firma: ${ctx.company || "?"}\nThema: ${ctx.topic || "?"}\n\nTranskript:\n${transcriptText}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      log.error("finalize.openai_error", { status: res.status, body: body.slice(0, 200) });
      return null;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<ExtractedReport> & {
      appointmentAt?: string | null;
      contactEmail?: string | null;
      nextCallAt?: string | null;
      directDial?: string | null;
    };

    const outcome: Outcome =
      parsed.outcome === "Termin" || parsed.outcome === "Absage" || parsed.outcome === "Wiedervorlage"
        ? parsed.outcome
        : parsed.outcome === "Gespräch abgebrochen"
          ? "Gespräch abgebrochen"
          : "Nicht erreicht / kein Kontakt";

    const appointmentAt =
      typeof parsed.appointmentAt === "string"
        ? parsePossiblyZonelessDateTime(parsed.appointmentAt)
        : undefined;

    const contactEmail =
      typeof parsed.contactEmail === "string" && /.+@.+\..+/.test(parsed.contactEmail)
        ? parsed.contactEmail.trim()
        : undefined;

    const nextCallAt =
      outcome === "Wiedervorlage" && typeof parsed.nextCallAt === "string"
        ? parsePossiblyZonelessDateTime(parsed.nextCallAt)
        : undefined;

    const directDial =
      outcome === "Wiedervorlage" && typeof parsed.directDial === "string"
        ? parsed.directDial.replace(/[^\d+]/g, "").trim() || undefined
        : undefined;

    const summary = (parsed.summary || "").trim() || "Kein Gesprächsinhalt erfasst.";

    return { outcome, appointmentAt, contactEmail, summary, nextCallAt, directDial };
  } catch (error) {
    log.error("finalize.extract_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postReport(ctx: CallContext): Promise<void> {
  if (!ctx.company || !ctx.topic) {
    if (!ctx.leadId && !ctx.callSid) {
      log.info("finalize.skip_no_company_or_topic", { callSid: ctx.callSid });
      return;
    }
    log.info("finalize.missing_company_or_topic_recoverable", {
      callSid: ctx.callSid,
      hasLeadId: Boolean(ctx.leadId),
    });
  }

  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    log.error("finalize.no_base_url");
    return;
  }

  const token = process.env.APP_INTERNAL_TOKEN || "";
  const url = `${baseUrl}/api/calls/webhook`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(token ? { "x-gloria-internal-token": token } : {}),
  };

  const recordingConsent = detectRecordingConsent(ctx.transcript);
  const documentation = deriveReportDocumentation(ctx, null);

  // Preliminary summary text used as summaryChunk in Phase 1 (transcript-only post).
  const prelimSummaryText = ctx.confirmedSlotPhrase
    ? `Termin vereinbart: ${ctx.confirmedSlotPhrase}. Vollständige Auswertung folgt.`
    : `Anruf bei ${ctx.company || "?"} zum Thema ${ctx.topic || "?"}. Auswertung folgt.`;

  const transcriptEntries = ctx.transcript.map((entry) => ({
    role: entry.role,
    speaker: entry.role === "assistant" ? "Gloria" : "Interessent",
    text: entry.text,
    at: entry.at,
    latencyMs: entry.latencyMs,
  }));

  // Phase 1: Sofort-Post sichert Transkript und Basisdaten — kein E-Mail-Versand.
  // summaryChunk statt summary/outcome, damit der Webhook keine E-Mail auslöst.
  log.info("finalize.posting_preliminary", {
    callSid: ctx.callSid,
    url,
    hasSlot: Boolean(ctx.confirmedSlotPhrase),
    transcriptTurns: transcriptEntries.length,
    hasUserId: Boolean(ctx.userId),
    hasLeadId: Boolean(ctx.leadId),
  });

  const phase1Ok = await postWithRetry(url, headers, {
    userId: ctx.userId,
    leadId: ctx.leadId,
    callSid: ctx.callSid,
    company: ctx.company,
    contactName: ctx.contactName,
    topic: ctx.topic,
    // summaryChunk triggers transcript-only storage path (no email sent).
    summaryChunk: prelimSummaryText,
    recordingConsent,
    transcript: transcriptEntries,
  });

  if (!phase1Ok) {
    log.error("finalize.preliminary_post_failed", { callSid: ctx.callSid });
    return;
  }
  log.info("finalize.preliminary_posted", { callSid: ctx.callSid });

  // Phase 2: LLM-Auswertung; updated existierenden Report per callSid.
  const extracted = await extractReport(ctx);
  if (!extracted) {
    log.info("finalize.no_llm_extraction", { callSid: ctx.callSid });
    return;
  }

  let outcome: Outcome = extracted.outcome;
  let appointmentAt: string | undefined = extracted.appointmentAt;
  let summary = extracted.summary;

  if (ctx.confirmedSlotPhrase) {
    outcome = "Termin";
    const parsed = parseSlotPhraseToIso(ctx.confirmedSlotPhrase);
    if (parsed) appointmentAt = parsed;
  }

  const fullDocumentation = deriveReportDocumentation(ctx, extracted);
  summary = withDocumentationHeader(summary, outcome, fullDocumentation);

  log.info("finalize.posting_final", {
    callSid: ctx.callSid,
    outcome,
    appointmentAt,
    email: extracted.contactEmail,
  });

  await postWithRetry(url, headers, {
    userId: ctx.userId,
    leadId: ctx.leadId,
    callSid: ctx.callSid,
    company: ctx.company,
    contactName: ctx.contactName,
    topic: ctx.topic,
    summary,
    outcome,
    conversationOccurred: fullDocumentation.conversationOccurred,
    callDisposition: fullDocumentation.callDisposition,
    followUpPlanned: fullDocumentation.followUpPlanned,
    followUpAt: fullDocumentation.followUpAt,
    appointmentAt,
    nextCallAt: extracted.nextCallAt,
    directDial: extracted.directDial,
    recordingConsent,
    transcript: transcriptEntries,
  });
  log.info("finalize.final_posted", { callSid: ctx.callSid, outcome });
}

async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<boolean> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();
      if (res.ok) return true;
      const retryable = res.status >= 500 || res.status === 429;
      log.error("finalize.post_failed", { status: res.status, body: text.slice(0, 400), attempt, retryable });
      if (!retryable || attempt >= maxAttempts) return false;
      await wait(250 * attempt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("finalize.post_error", { error: message, attempt });
      if (attempt >= maxAttempts) return false;
      await wait(250 * attempt);
    }
  }
  return false;
}

function deriveReportDocumentation(
  ctx: CallContext,
  extracted: ExtractedReport | null,
): ReportDocumentation {
  const userTurns = ctx.transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text.trim())
    .filter(Boolean);

  const hasMeaningfulHumanTurn = userTurns.some((text) => looksLikeMeaningfulHumanTurn(text));
  const hasVoicemailCue = Boolean(ctx.detectedVoicemail) || userTurns.some((text) => classifyInboundSpeech(text) === "voicemail");
  const hasQueueCue = Boolean(ctx.queueDetected) || userTurns.some((text) => classifyInboundSpeech(text) === "queue");

  const callDisposition: ReportDocumentation["callDisposition"] = hasVoicemailCue
    ? "Anrufbeantworter"
    : hasQueueCue && !hasMeaningfulHumanTurn
      ? "Warteschleife ohne Gespraech"
      : hasMeaningfulHumanTurn
        ? "Gespraech"
        : "Kein Gespraech";

  const conversationOccurred = hasMeaningfulHumanTurn && !hasVoicemailCue;
  const followUpAt = extracted?.nextCallAt;
  const followUpPlanned = extracted?.outcome === "Wiedervorlage" || Boolean(followUpAt);

  return {
    conversationOccurred,
    callDisposition,
    followUpPlanned,
    followUpAt,
  };
}

function withDocumentationHeader(summary: string, outcome: Outcome, documentation: ReportDocumentation): string {
  const header = [
    `Dokumentation:`,
    `- Gespraech stattgefunden: ${documentation.conversationOccurred ? "Ja" : "Nein"}`,
    `- Einordnung: ${documentation.callDisposition}`,
    `- Ergebnis: ${outcome}`,
    `- Weiterer Anruf geplant: ${documentation.followUpPlanned ? "Ja" : "Nein"}`,
    `- Rueckrufzeitpunkt: ${documentation.followUpAt || "-"}`,
  ].join("\n");

  const trimmed = summary.trim();
  if (trimmed.startsWith("Dokumentation:")) return trimmed;
  return `${header}\n\nZusammenfassung:\n${trimmed}`;
}

/**
 * DSGVO-strikte Erkennung der Aufzeichnungs-Einwilligung.
 *
 * Regeln (in dieser Reihenfolge):
 *  1. Wenn Gloria nie nach Aufzeichnung gefragt hat → false.
 *  2. Erste klare Nutzerantwort NACH der Aufzeichnungs-Frage entscheidet.
 *     - "nein", "lieber nicht", "ich möchte nicht" → false (gewinnt definitiv,
 *        spätere "Ja" auf andere Fragen zählen nicht).
 *     - "ja", "klar", "in ordnung", "einverstanden" → true.
 *  3. Wenn vor Glorias nächster Themen-Aussage keine eindeutige Antwort
 *     kam → false (im Zweifel KEINE Aufzeichnung).
 */
function detectRecordingConsent(
  transcript: Array<{ role: "user" | "assistant"; text: string }>,
): boolean {
  const askIdx = transcript.findIndex(
    (t) => t.role === "assistant" && /(aufzeichn|aufnahme|mitschneid)/i.test(t.text),
  );
  if (askIdx === -1) return false;

  for (let i = askIdx + 1; i < transcript.length; i++) {
    const entry = transcript[i];
    if (entry.role === "assistant") {
      if (/(aufzeichn|aufnahme|mitschneid)/i.test(entry.text)) continue;
      return false;
    }
    const text = entry.text.toLowerCase().trim();
    if (!text) continue;
    if (
      /^(nein|nö|n[oe]\b|nicht|lieber nicht|kein\b|keine aufzeichnung|möchte nicht|will nicht|bitte nicht|no\b)/.test(
        text,
      )
    ) {
      return false;
    }
    if (
      /\b(ja|jawohl|in ordnung|einverstanden|von mir aus|ok|okay|klar)\b/.test(text) &&
      !/\bnein\b/.test(text)
    ) {
      return true;
    }
  }
  return false;
}

const ORDINAL_DAY: Record<string, number> = {
  "ersten": 1, "zweiten": 2, "dritten": 3, "vierten": 4, "fünften": 5,
  "sechsten": 6, "siebten": 7, "achten": 8, "neunten": 9, "zehnten": 10,
  "elften": 11, "zwölften": 12, "dreizehnten": 13, "vierzehnten": 14,
  "fünfzehnten": 15, "sechzehnten": 16, "siebzehnten": 17, "achtzehnten": 18,
  "neunzehnten": 19, "zwanzigsten": 20, "einundzwanzigsten": 21,
  "zweiundzwanzigsten": 22, "dreiundzwanzigsten": 23, "vierundzwanzigsten": 24,
  "fünfundzwanzigsten": 25, "sechsundzwanzigsten": 26, "siebenundzwanzigsten": 27,
  "achtundzwanzigsten": 28, "neunundzwanzigsten": 29, "dreißigsten": 30,
  "einunddreißigsten": 31,
};

const MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

const NUMBER_WORD: Record<string, number> = {
  "null": 0, "eins": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "sechs": 6,
  "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "elf": 11, "zwölf": 12,
  "dreizehn": 13, "vierzehn": 14, "fünfzehn": 15, "sechzehn": 16, "siebzehn": 17,
  "achtzehn": 18, "neunzehn": 19, "zwanzig": 20, "einundzwanzig": 21,
  "zweiundzwanzig": 22, "dreiundzwanzig": 23, "dreißig": 30, "fünfundvierzig": 45,
};

/**
 * Parsed eine Slot-Phrase wie "Donnerstag, den siebten Mai um vierzehn Uhr dreißig"
 * in ein ISO-Datum (Berlin-TZ). Best effort – gibt undefined zurück, wenn unklar.
 */
function parseSlotPhraseToIso(phrase: string): string | undefined {
  const lower = phrase.toLowerCase();
  let day: number | undefined;
  const dayNumeric = /\b(?:den\s+)?(\d{1,2})\.?\b/.exec(lower);
  if (dayNumeric) {
    const parsed = Number.parseInt(dayNumeric[1], 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 31) {
      day = parsed;
    }
  }
  // Wichtig: laengere Ordinalwoerter zuerst pruefen (z. B. "neunundzwanzigsten"
  // vor "zwanzigsten"), sonst entstehen Teiltreffer mit falschem Tag.
  const ordinalCandidates = Object.entries(ORDINAL_DAY).sort((a, b) => b[0].length - a[0].length);
  for (const [word, value] of ordinalCandidates) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(lower)) {
      day = value;
      break;
    }
  }
  let month: number | undefined;
  for (const [word, value] of Object.entries(MONTHS)) {
    if (lower.includes(word)) {
      month = value;
      break;
    }
  }
  // Uhrzeit: "um <hour> Uhr [<minute>]"
  const numericTime = /\bum\s+(\d{1,2})(?::(\d{2}))?\s*uhr\b/.exec(lower);
  let hour = 0;
  let minute = 0;
  if (numericTime) {
    hour = Number.parseInt(numericTime[1], 10);
    minute = numericTime[2] ? Number.parseInt(numericTime[2], 10) : 0;
  }
  const hourMatch = /\bum\s+([a-zäöüß]+)\s+uhr(?:\s+([a-zäöüß]+))?/.exec(lower);
  if (!numericTime && hourMatch) {
    hour = NUMBER_WORD[hourMatch[1]] ?? 0;
    if (hourMatch[2]) minute = NUMBER_WORD[hourMatch[2]] ?? 0;
  }
  if (!day || !month || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

  const now = new Date();
  let year = now.getFullYear();

  // Wenn das Datum in der Vergangenheit läge, nimm nächstes Jahr.
  const candidateIso = berlinLocalDateTimeToIso(year, month, day, hour, minute);
  if (!candidateIso) return undefined;
  const candidate = new Date(candidateIso);
  if (candidate.getTime() < now.getTime() - 86400000) {
    year += 1;
  }
  return berlinLocalDateTimeToIso(year, month, day, hour, minute);
}

function parsePossiblyZonelessDateTime(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;

  // Mit expliziter Zeitzone: normal über Date parser.
  if (/([zZ]|[+\-]\d{2}:?\d{2})$/.test(raw)) {
    const withZone = new Date(raw);
    return Number.isNaN(withZone.getTime()) ? undefined : withZone.toISOString();
  }

  // Ohne Zeitzone: als Europe/Berlin interpretieren.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  const year = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const day = Number.parseInt(m[3], 10);
  const hour = Number.parseInt(m[4] || "0", 10);
  const minute = Number.parseInt(m[5] || "0", 10);
  const second = Number.parseInt(m[6] || "0", 10);

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour < 0 || hour > 23 ||
    minute < 0 || minute > 59 ||
    second < 0 || second > 59
  ) {
    return undefined;
  }

  return berlinLocalDateTimeToIso(year, month, day, hour, minute, second);
}

function berlinLocalDateTimeToIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): string | undefined {
  const toUtcMillis = (guessUtcMillis: number) => {
    const dtf = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date(guessUtcMillis));
    const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value || "0", 10);
    const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return guessUtcMillis + (desiredAsUtc - asIfUtc);
  };

  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  utcMillis = toUtcMillis(utcMillis);
  utcMillis = toUtcMillis(utcMillis);

  const result = new Date(utcMillis);
  return Number.isNaN(result.getTime()) ? undefined : result.toISOString();
}
