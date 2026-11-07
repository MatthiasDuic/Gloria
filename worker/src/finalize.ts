import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";
import { classifyInboundSpeech, looksLikeMeaningfulHumanTurn } from "./call-classification.js";
import { classifyCallbackDirection } from "./callback-controller.js";
import { isConversationEndingText } from "./conversation-event-controller.js";
import { enqueueReport, flushOutbox } from "./report-outbox.js";

const transcriptProgress = new WeakMap<CallContext, { saved: number; pending: Promise<void> }>();

export function persistTranscriptDelta(ctx: CallContext): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token || !ctx.userId) return Promise.resolve();
  const progress = transcriptProgress.get(ctx) || { saved: 0, pending: Promise.resolve() };
  transcriptProgress.set(ctx, progress);
  progress.pending = progress.pending.then(async () => {
    const turns = ctx.transcript.slice(progress.saved);
    if (!turns.length) return;
    const response = await fetch(`${baseUrl}/api/calls/transcript`, {
      method: "POST", headers: { "content-type": "application/json", "x-gloria-internal-token": token },
      body: JSON.stringify({ callSid: ctx.callSid, userId: ctx.userId, calledPhone: ctx.calledPhone, turns }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Transcript persistence failed: ${response.status}`);
    progress.saved += turns.length;
  }).catch((error) => { log.warn("transcript.incremental_failed", { callSid: ctx.callSid, error: String(error) }); });
  return progress.pending;
}

export async function persistAppointmentBooking(ctx: CallContext, appointmentAt: string, appointmentMode: string): Promise<boolean> {
  const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token || !ctx.userId || !ctx.company || !ctx.topic) {
    log.error("booking.missing_context", { callSid: ctx.callSid });
    return false;
  }
  return postWithRetry(`${baseUrl}/api/calls/webhook`, {
    "content-type": "application/json",
    "x-gloria-internal-token": token,
  }, {
    userId: ctx.userId,
    leadId: ctx.leadId,
    callSid: ctx.callSid,
    company: ctx.company,
    contactName: ctx.contactName,
    calledPhone: ctx.calledPhone,
    topic: ctx.topic,
    summaryChunk: `Termin verbindlich vereinbart: ${appointmentAt}. Durchführung: ${appointmentMode}. Vorbereitung läuft.`,
    outcome: "Termin",
    appointmentAt,
    appointmentMode,
  }, (text) => {
    const response = JSON.parse(text) as { report?: { appointmentAt?: string; outcome?: string } };
    return response.report?.outcome === "Termin"
      && Date.parse(response.report.appointmentAt || "") === Date.parse(appointmentAt);
  }, { maxAttempts: 2, timeoutMs: 10_000 });
}

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
  rejectionReason?: string;
  lostPhase?: string;
};

type TranscriptEntry = {
  role: "user" | "assistant";
  text: string;
  at?: number;
  latencyMs?: number;
  phase?: string;
};

const EXTRACT_PROMPT = `Du bist ein Auswerter für Akquise-Telefonate. Lies das Transkript unten und gib AUSSCHLIESSLICH ein JSON-Objekt zurück mit folgenden Feldern:
{
  "outcome": "Termin" | "Absage" | "Wiedervorlage" | "Nicht erreicht / kein Kontakt" | "Gespräch abgebrochen",
  "appointmentAt": "ISO-8601 mit Zeitzone (z. B. 2026-04-30T15:00:00+02:00) oder null",
  "contactEmail": "vom Kunden bestätigte Mailadresse oder null",
  "nextCallAt": "ISO-8601 mit Zeitzone für den vereinbarten Rückruf-Zeitpunkt (NUR bei Wiedervorlage), sonst null",
  "directDial": "vom Interessenten ausdrücklich genannte alternative Direkt-Durchwahl/Mobilnummer als reine E.164- oder Klar-Ziffern-Zeichenkette, sonst null; niemals die von Gloria genannte Rückrufnummer",
  "summary": "5–10 Sätze Deutsch, fasse Verlauf, Bedarf, vereinbarten Termin und ggf. erfasste Basisdaten zusammen"
}
Regeln:
- "Termin" nur, wenn ein konkreter Termin (Datum + Uhrzeit) bestätigt wurde.
- "Absage" wenn der Anrufende ablehnt.
- "Wiedervorlage" wenn vereinbart wurde, dass Gloria oder der Auftraggeber die Person später anruft, auch bei relativen Angaben wie "in zehn Minuten". Die für diesen Anruf verwendete Telefonnummer genügt; eine alternative Direktdurchwahl ist nicht erforderlich. Wenn die Zielperson selbst den Auftraggeber zurückrufen will, dokumentiere dies in der Zusammenfassung und erfinde keinen ausgehenden Rückrufzeitpunkt.
- "Nicht erreicht / kein Kontakt" wenn kein Kontakt zustande kam.
- "Gespräch abgebrochen" wenn jemand kurz angerufen wurde, aber das Gespräch nach dem Einstieg abgebrochen wurde.
- appointmentAt: nutze die LETZTE im Transkript bestätigte Termin-Aussage. Wenn der Anrufende "Donnerstag, 30. April, 15 Uhr" sagt, nimm das Datum exakt so.
- nextCallAt: bei outcome="Wiedervorlage" den konkret vereinbarten Zeitpunkt für einen ausgehenden Rückruf aus dem Transkript als ISO-8601 mit Europe/Berlin-Zeitzone angeben. Relative Angaben anhand des aktuellen Zeitpunkts berechnen; insbesondere "in zehn Minuten" bedeutet zehn Minuten nach der Äußerung. Nicht schätzen. Ausnahme: Wenn der Empfang die Zielperson erst für einen Zeitraum ankündigt (z. B. "nächste Woche", "nach dem Urlaub ab Montag") und Gloria zusagt, es dann erneut zu versuchen, ist das eine Wiedervorlage; setze nextCallAt auf den ersten Werktag dieses Zeitraums um 10:00 Uhr Europe/Berlin. directDial nur füllen, wenn der Interessent ausdrücklich eine alternative Nummer genannt hat.
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
  const todayStr = today.toLocaleString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
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

    const callbackDirection = ctx.transcript
      .filter((turn) => turn.role === "user")
      .map((turn) => classifyCallbackDirection(turn.text))
      .reverse()
      .find((direction) => direction !== undefined);
    const incomingCallback = callbackDirection === "incoming";
    let outcome: Outcome =
      parsed.outcome === "Termin" || parsed.outcome === "Absage" || parsed.outcome === "Wiedervorlage"
        ? parsed.outcome
        : parsed.outcome === "Gespräch abgebrochen"
          ? "Gespräch abgebrochen"
          : "Nicht erreicht / kein Kontakt";
    if (incomingCallback && outcome === "Nicht erreicht / kein Kontakt") {
      log.warn("finalize.incoming_callback_contact_misclassified", { callSid: ctx.callSid });
      outcome = "Gespräch abgebrochen";
    }

    const appointmentAt =
      typeof parsed.appointmentAt === "string"
        ? parsePossiblyZonelessDateTime(parsed.appointmentAt)
        : undefined;

    const contactEmail =
      typeof parsed.contactEmail === "string" && /.+@.+\..+/.test(parsed.contactEmail)
        ? parsed.contactEmail.trim()
        : undefined;

    const relativeCallbackAt =
      outcome === "Wiedervorlage" && !incomingCallback ? parseRelativeCallbackAt(ctx.transcript) : undefined;
    const nextCallAt =
      outcome === "Wiedervorlage" && !incomingCallback
        ? relativeCallbackAt ||
          (typeof parsed.nextCallAt === "string"
            ? parsePossiblyZonelessDateTime(parsed.nextCallAt)
            : undefined)
        : undefined;

    let directDial =
      outcome === "Wiedervorlage" && typeof parsed.directDial === "string"
        ? parsed.directDial.replace(/[^\d+]/g, "").trim() || undefined
        : undefined;
    if (directDial && ctx.ownerRealPhone && phoneNumbersMatch(directDial, ctx.ownerRealPhone)) {
      log.warn("finalize.owner_number_rejected_as_direct_dial", { callSid: ctx.callSid });
      directDial = undefined;
    }
    if (incomingCallback && parsed.nextCallAt) {
      log.warn("finalize.incoming_callback_not_scheduled", { callSid: ctx.callSid });
    }

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

function phoneNumbersMatch(first: string, second: string): boolean {
  const normalize = (value: string) => {
    const digits = value.replace(/\D/g, "");
    if (digits.startsWith("00")) return digits.slice(2);
    if (digits.startsWith("0")) return `49${digits.slice(1)}`;
    return digits;
  };
  const firstDigits = normalize(first);
  return Boolean(firstDigits) && firstDigits === normalize(second);
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

  const { url, headers } = reportWebhookTarget(baseUrl);

  const recordingConsent = detectRecordingConsent(ctx.transcript);
  const documentation = deriveReportDocumentation(ctx, null);

  // Preliminary summary text used as summaryChunk in Phase 1 (transcript-only post).
  const prelimSummaryText = ctx.confirmedSlotPhrase
    ? `Termin vereinbart: ${ctx.confirmedSlotPhrase}.${ctx.appointmentMode ? ` Durchführung: ${ctx.appointmentMode}.` : ""} Vollständige Auswertung folgt.`
    : `Anruf bei ${ctx.company || "?"} zum Thema ${ctx.topic || "?"}. Auswertung folgt.`;

  const transcriptEntries = ctx.transcript.map((entry) => ({
    role: entry.role,
    speaker: entry.role === "assistant" ? "Gloria" : "Interessent",
    text: entry.text,
    at: entry.at,
    latencyMs: entry.latencyMs,
    phase: entry.phase,
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
    calledPhone: ctx.calledPhone,
    appointmentMode: ctx.appointmentMode,
    contactName: ctx.contactName || ctx.originalContactName,
    topic: ctx.topic,
    doNotCall: Boolean(ctx.optOut),
    dataDeletionRequested: Boolean(ctx.optOut?.deletion),
    // Deterministic one-word result, so the report never shows a misleading default if the final post is lost.
    resultDetail: deriveResultDetail(ctx, ctx.confirmedSlotPhrase ? "Termin" : buildFallbackExtraction(ctx).outcome),
    // summaryChunk triggers transcript-only storage path (no email sent).
    summaryChunk: prelimSummaryText,
    recordingConsent,
    transcript: transcriptEntries,
  });

  if (!phase1Ok) {
    // The final post below carries the full transcript too, so a failed preliminary post must not lose the report.
    log.error("finalize.preliminary_post_failed", { callSid: ctx.callSid });
  } else {
    log.info("finalize.preliminary_posted", { callSid: ctx.callSid });
  }

  // Phase 2: LLM-Auswertung; updated existierenden Report per callSid.
  const hasVoicemail = ctx.detectedVoicemail
    || ctx.transcript.some((turn) => turn.role === "user" && classifyInboundSpeech(turn.text) === "voicemail");
  const extracted = hasVoicemail || ctx.humanContactDetected === false ? null : await extractReport(ctx);
  const resolvedExtraction = extracted || buildFallbackExtraction(ctx);

  if (!extracted) {
    log.warn("finalize.no_llm_extraction_fallback", {
      callSid: ctx.callSid,
      fallbackOutcome: resolvedExtraction.outcome,
    });
  }

  let outcome: Outcome = resolvedExtraction.outcome;
  if (outcome === "Nicht erreicht / kein Kontakt" && ctx.decisionMakerReached && !hasVoicemail) {
    // The contact person spoke with Gloria, so this was a contact that ended early, not an unreachable number.
    log.warn("finalize.reached_contact_misclassified", { callSid: ctx.callSid });
    outcome = "Gespräch abgebrochen";
  }
  let appointmentAt: string | undefined = resolvedExtraction.appointmentAt;
  let summary = resolvedExtraction.summary;

  if (ctx.confirmedSlotPhrase) {
    outcome = "Termin";
    const parsed = parseSlotPhraseToIso(ctx.confirmedSlotPhrase);
    if (parsed) appointmentAt = parsed;
  }
  if (ctx.optOut && outcome !== "Termin") {
    outcome = "Absage";
    summary = `${ctx.optOut.deletion
      ? "WIDERSPRUCH UND LÖSCHWUNSCH: Der Kontakt hat weiteren Anrufen widersprochen und die Löschung seiner Daten verlangt. Nummer wurde gesperrt; Löschung bitte prüfen und durchführen."
      : "WIDERSPRUCH: Der Kontakt wünscht keine weiteren Anrufe. Nummer wurde gesperrt."}\n\n${summary}`;
  }
  if (ctx.contactLeftCompany) {
    const original = ctx.originalContactName?.trim() || "Die gesuchte Ansprechperson";
    summary = `KONTAKT AUSGESCHIEDEN: ${original} ist laut Auskunft nicht mehr im Unternehmen.${ctx.successorContactName ? ` Neue zuständige Person: ${ctx.successorContactName}.` : ""}\n\n${summary}`;
  }

  const fullDocumentation = deriveReportDocumentation(ctx, resolvedExtraction);
  if (ctx.appointmentMode && !summary.includes(ctx.appointmentMode)) {
    summary = `Durchführung: ${ctx.appointmentMode}.\n\n${summary}`;
  }
  summary = withDocumentationHeader(summary, outcome, fullDocumentation);

  log.info("finalize.posting_final", {
    callSid: ctx.callSid,
    outcome,
    appointmentAt,
    email: resolvedExtraction.contactEmail,
  });

  const finalBody: Record<string, unknown> = {
    userId: ctx.userId,
    leadId: ctx.leadId,
    callSid: ctx.callSid,
    company: ctx.company,
    contactName: ctx.contactName || ctx.originalContactName,
    topic: ctx.topic,
    summary,
    outcome,
    doNotCall: Boolean(ctx.optOut),
    dataDeletionRequested: Boolean(ctx.optOut?.deletion),
    resultDetail: deriveResultDetail(ctx, outcome),
    conversationOccurred: fullDocumentation.conversationOccurred,
    callDisposition: fullDocumentation.callDisposition,
    followUpPlanned: fullDocumentation.followUpPlanned,
    followUpAt: fullDocumentation.followUpAt,
    appointmentAt,
    appointmentMode: ctx.appointmentMode,
    calledPhone: ctx.calledPhone,
    nextCallAt: resolvedExtraction.nextCallAt,
    directDial: resolvedExtraction.directDial,
    recordingConsent,
    transcript: transcriptEntries,
  };
  const finalPosted = await postWithRetry(url, headers, finalBody);
  if (finalPosted) log.info("finalize.final_posted", { callSid: ctx.callSid, outcome });
  else {
    log.error("finalize.final_post_failed", { callSid: ctx.callSid, outcome });
    await enqueueReport(ctx.callSid || `report-${Date.now()}`, finalBody);
  }
}

function reportWebhookTarget(baseUrl: string): { url: string; headers: Record<string, string> } {
  const token = process.env.APP_INTERNAL_TOKEN || "";
  return {
    url: `${baseUrl}/api/calls/webhook`,
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-gloria-internal-token": token } : {}),
    },
  };
}

/** Retries final reports that could not be delivered earlier (e.g. app cold start or short outage). */
export async function flushPendingReports(): Promise<void> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return;
  const { url, headers } = reportWebhookTarget(baseUrl);
  const result = await flushOutbox((body) => postWithRetry(url, headers, body, undefined, { maxAttempts: 1, timeoutMs: 20_000 }));
  if (result.sent || result.pending || result.dropped) log.info("outbox.flush", result);
}

async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  validateResponse?: (text: string) => boolean,
  options: { maxAttempts?: number; timeoutMs?: number } = {},
): Promise<boolean> {
  // Reports are posted after the call, so they may wait out a slow Vercel cold start; bookings run live and stay short.
  const maxAttempts = options.maxAttempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 25_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      const text = await res.text();
      if (res.ok && (!validateResponse || validateResponse(text))) return true;
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      log.error("finalize.post_failed", { status: res.status, body: text.slice(0, 400), attempt, retryable });
      if (!retryable || attempt >= maxAttempts) return false;
      await wait(Math.min(8000, 1000 * (2 ** (attempt - 1))));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("finalize.post_error", { error: message, attempt });
      if (attempt >= maxAttempts) return false;
      await wait(Math.min(8000, 1000 * (2 ** (attempt - 1))));
    } finally {
      clearTimeout(timeout);
    }
  }
  return false;
}

function inferContactEmailFromTranscript(transcript: TranscriptEntry[]): string | undefined {
  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const turn = transcript[i];
    if (turn.role !== "user") continue;
    const match = turn.text.match(emailRegex);
    if (match?.[0]) return match[0].toLowerCase();
  }
  return undefined;
}

function buildFallbackExtraction(ctx: CallContext): ExtractedReport {
  const userTurns = ctx.transcript.filter((turn) => turn.role === "user");
  const hasVoicemailCue = Boolean(ctx.detectedVoicemail)
    || userTurns.some((turn) => classifyInboundSpeech(turn.text) === "voicemail");
  const humanTurns = userTurns.filter((turn) => classifyInboundSpeech(turn.text) === "human");
  const hadConversation = ctx.humanContactDetected !== false && !hasVoicemailCue && humanTurns.some((turn) => turn.text.trim().length > 1);
  const rejected = Boolean(ctx.optOut) || (ctx.humanContactDetected !== false && !hasVoicemailCue
    && humanTurns.some((turn) => /(kein\s+interesse|nicht\s+interessiert|rufen\s+sie\s+bitte\s+nicht|danke,?\s+nein)/i.test(turn.text)
      || (isConversationEndingText(turn.text) && !/\b(?:auf\s+wiederh[öo]ren|auf\s+wiedersehen|tsch[üu]ss)\b/i.test(turn.text))));

  const appointmentAt = ctx.confirmedSlotPhrase ? parseSlotPhraseToIso(ctx.confirmedSlotPhrase) : undefined;
  const outcome: Outcome = appointmentAt
    ? "Termin"
    : rejected
      ? "Absage"
      : hadConversation
        ? "Gespräch abgebrochen"
        : "Nicht erreicht / kein Kontakt";

  const summaryParts: string[] = [];
  if (appointmentAt && ctx.confirmedSlotPhrase) {
    summaryParts.push(`Ein Termin wurde verbindlich vereinbart: ${ctx.confirmedSlotPhrase}.`);
  } else if (outcome === "Absage") {
    summaryParts.push("Der Interessent hat das Gespräch bzw. den Termin klar abgelehnt.");
  } else if (outcome === "Gespräch abgebrochen") {
    summaryParts.push("Es fand ein Gespräch statt, wurde jedoch ohne abschließende Vereinbarung beendet.");
  } else {
    summaryParts.push("Es kam zu keinem Gespräch mit einem Ansprechpartner.");
  }

  const lastUserSignals = userTurns
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  if (lastUserSignals) {
    summaryParts.push(`${hadConversation ? "Letzte relevante Kundenaussagen" : "Erkannte Ansage"}: ${lastUserSignals}.`);
  }

  summaryParts.push("Automatisch erzeugte Fallback-Zusammenfassung, da die LLM-Auswertung nicht rechtzeitig verfügbar war.");

  return {
    outcome,
    appointmentAt,
    contactEmail: inferContactEmailFromTranscript(ctx.transcript),
    nextCallAt: undefined,
    directDial: undefined,
    summary: summaryParts.join(" "),
  };
}

const AI_ASSISTANT_PATTERN = /\b(?:digitale[rn]?|virtuelle[rn]?|automatische[rn]?|ki-?)\s*(?:telefon|sprach)?assistent(?:in)?\b|\b(?:telefon|sprach)assistent(?:in)?\b|\bk[üu]nstliche[rn]?\s+intelligenz\b|\bvoice\s*bot\b/i;
const PHONE_MENU_PATTERN = /(?:dr[üu]cken|w[äa]hlen)\s+sie\s+(?:bitte\s+)?(?:die\s+)?(?:\d|eins|zwei|drei|vier|f[üu]nf|sechs|sieben|acht|neun|null|stern|raute)\b|\btaste\s+(?:\d|eins|zwei|drei|stern|raute)\b|\bpress\s+\d/i;

function isAiAssistantSelfIntroduction(text: string): boolean {
  // "Sind Sie eine KI?" from a human must not mark the callee as a bot.
  return AI_ASSISTANT_PATTERN.test(text) && !/\b(?:sind\s+sie|bist\s+du)\b/i.test(text);
}

/** One word describing what actually happened on the call, shown in the report's "Ergebnis" column. */
export function deriveResultDetail(ctx: CallContext, outcome: Outcome): string {
  if (ctx.optOut) return "Gesperrt";
  if (outcome === "Termin" || outcome === "Absage" || outcome === "Wiedervorlage") return outcome;
  if (ctx.contactLeftCompany) return "Ausgeschieden";
  if (ctx.endReason === "transferred") return "Weitergeleitet";
  if (ctx.endReason === "error") return "Fehler";

  const userTurns = ctx.transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text.trim())
    .filter(Boolean);
  if (userTurns.some(isAiAssistantSelfIntroduction)) return "KI-Assistent";
  if (ctx.detectedVoicemail || ctx.endReason === "voicemail_detected"
    || userTurns.some((text) => classifyInboundSpeech(text) === "voicemail")) return "Anrufbeantworter";
  if (ctx.callbackNumberDelivered) return "Rückrufnummer";

  const humanReached = ctx.humanContactDetected === true
    || (ctx.humanContactDetected !== false && userTurns.some((text) => looksLikeMeaningfulHumanTurn(text)));
  if (!humanReached && userTurns.some((text) => PHONE_MENU_PATTERN.test(text))) return "Telefonmenü";
  if (!humanReached && (ctx.queueDetected || userTurns.some((text) => classifyInboundSpeech(text) === "queue"))) {
    return "Warteschleife";
  }
  if (ctx.endReason === "time_limit") return "Zeitlimit";
  if (ctx.endReason === "transfer_timeout") {
    return ctx.queueDetected || ctx.waitingForDecisionMaker ? "Warteschleife" : "Stille";
  }
  if (userTurns.length === 0) return ctx.endedByGloria ? "Stille" : "Aufgelegt";
  if (ctx.endedByGloria) return ctx.waitingForDecisionMaker ? "Abwesend" : "Beendet";
  return "Aufgelegt";
}

function deriveReportDocumentation(
  ctx: CallContext,
  extracted: ExtractedReport | null,
): ReportDocumentation {
  const userTurns = ctx.transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text.trim())
    .filter(Boolean);

  const hasMeaningfulHumanTurn = ctx.humanContactDetected !== false && userTurns.some((text) => looksLikeMeaningfulHumanTurn(text));
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
  const lastUserText = userTurns.at(-1) || "";
  const rejectionReason = extractRejectionReason(lastUserText);
  const lostPhase = ctx.confirmedSlotPhrase
    ? undefined
    : ctx.dialogState.phase;

  return {
    conversationOccurred,
    callDisposition,
    followUpPlanned,
    followUpAt,
    rejectionReason,
    lostPhase,
  };
}

function extractRejectionReason(text: string): string | undefined {
  if (/l[öo]schen|gel[öo]scht|widersprech|widerspruch/i.test(text)) return "Widerspruch / Löschwunsch";
  if (/nicht\s+(?:mehr\s+)?an(?:zu)?rufen|keine\s+(?:weiteren\s+)?(?:werbe)?anrufe|streichen\s+(?:sie\s+)?(?:mich|uns)|aus\s+(?:ihrer|der|eurer)\s+\w*(?:liste|datenbank|kartei)|keine\s+werbung/i.test(text)) return "Keine Werbeanrufe";
  if (/(?:kaufen|machen|schlie(?:ß|ss)en)\s+(?:wir|ich)?\s*(?:grunds[äa]tzlich\s+)?nichts\s+(?:\w+\s+)?(?:am|per|übers?)\s+telefon|keine\s+(?:gesch[äa]fte|vertr[äa]ge|termine)\s+(?:am|per|übers?)\s+telefon/i.test(text)) return "Keine Telefongeschäfte";
  if (/keine?\s+zeit|gerade\s+schlecht|unpassend|muss\s+gleich\s+weg/i.test(text)) return "Keine Zeit";
  if (/berater|makler|steuerb|bereits\s+(?:versorgt|beraten)/i.test(text)) return "Bereits versorgt";
  if (/zu\s+teuer|kein\s+budget|kosten/i.test(text)) return "Budget / Kosten";
  if (/falsch|nicht\s+zuständig|nicht\s+der\s+richtige/i.test(text)) return "Falscher Ansprechpartner";
  if (/kein(?:en)?\s+(?:interesse|bedarf)|nicht\s+interessiert|kommt\s+nicht\s+infrage|brauchen\s+wir\s+nicht/i.test(text)) return "Kein Interesse";
  return undefined;
}

function withDocumentationHeader(summary: string, outcome: Outcome, documentation: ReportDocumentation): string {
  const header = [
    `Dokumentation:`,
    `- Gespraech stattgefunden: ${documentation.conversationOccurred ? "Ja" : "Nein"}`,
    `- Einordnung: ${documentation.callDisposition}`,
    `- Ergebnis: ${outcome}`,
    `- Weiterer Anruf geplant: ${documentation.followUpPlanned ? "Ja" : "Nein"}`,
    `- Rueckrufzeitpunkt: ${documentation.followUpAt || "-"}`,
    `- Ablehnungsgrund: ${documentation.rejectionReason || "-"}`,
    `- Verlorene Gespraechsphase: ${documentation.lostPhase || "-"}`,
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
export function parseSlotPhraseToIso(phrase: string): string | undefined {
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
  const numericTime = /\b(?:um\s+)?(\d{1,2}):(\d{2})(?:\s*uhr)?\b/.exec(lower)
    || /\bum\s+(\d{1,2})\s*uhr\b/.exec(lower);
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
  if ((!numericTime && !hourMatch) || !day || !month || hour < 0 || hour > 23 || minute < 0 || minute > 59) return undefined;

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

export function parseRelativeCallbackAt(
  transcript: Array<{ role: "user" | "assistant"; text: string; at: number }>,
): string | undefined {
  const numberWords: Record<string, number> = {
    ein: 1,
    eine: 1,
    einer: 1,
    einem: 1,
    einen: 1,
    zwei: 2,
    drei: 3,
    vier: 4,
    fünf: 5,
    sechs: 6,
    sieben: 7,
    acht: 8,
    neun: 9,
    zehn: 10,
    elf: 11,
    zwölf: 12,
    dreizehn: 13,
    vierzehn: 14,
    fünfzehn: 15,
    sechzehn: 16,
    siebzehn: 17,
    achtzehn: 18,
    neunzehn: 19,
    zwanzig: 20,
    dreißig: 30,
    vierzig: 40,
    fünfzig: 50,
  };
  const timePattern =
    /\bin\s+(?:(?:einer?\s+halben\s+stunde)|(?:einer?\s+viertelstunde)|(?<amount>\d{1,3}|[a-zäöüß]+)\s*(?<unit>min(?:ute)?(?:n)?|stunden?|std)\b)/i;
  const callbackIntent = /\b(?:zurückrufen|wieder anrufen|noch einmal melden|nochmal melden|rückruf)\b/i;
  const turns = transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user" && Number.isFinite(turn.at));

  for (const { turn, index } of turns.reverse()) {
    const match = timePattern.exec(turn.text);
    if (!match || classifyCallbackDirection(turn.text) === "incoming") continue;

    const precedingAssistant = transcript
      .slice(0, index)
      .reverse()
      .find((entry) => entry.role === "assistant")?.text || "";
    const askedForCallbackTime =
      callbackIntent.test(turn.text) ||
      callbackIntent.test(precedingAssistant) ||
      /\b(?:wann|welche|welcher|was)\b[\s\S]{0,80}\b(?:passt|besser|zeit|uhr|wieder|rückruf|zurückruf)\b/i.test(precedingAssistant);
    if (!askedForCallbackTime) continue;

    let minutes: number;
    if (/halben\s+stunde/i.test(match[0])) {
      minutes = 30;
    } else if (/viertelstunde/i.test(match[0])) {
      minutes = 15;
    } else {
      const amountText = match.groups?.amount?.toLocaleLowerCase("de-DE") || "";
      const amount = Number.parseInt(amountText, 10) || numberWords[amountText];
      if (!amount || !match.groups?.unit) continue;
      minutes = /^min/i.test(match.groups.unit) ? amount : amount * 60;
    }

    if (minutes > 30 * 24 * 60) continue;
    return new Date(turn.at + minutes * 60_000).toISOString();
  }

  return undefined;
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
