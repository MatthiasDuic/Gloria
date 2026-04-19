/**
 * Gloria – Twilio voice-process handler (OpenAI-driven).
 *
 * Each call turn is handled by OpenAI (gpt-4.1-mini recommended).
 * The model detects whether Gloria is speaking to the GATEKEEPER or the
 * DECISION-MAKER and generates the next response.  No regex-based detection,
 * no hard-coded state machine.
 *
 * ENV:
 *   OPENAI_MODEL          – defaults to "gpt-4.1-mini"
 *   LIVE_AI_TIMEOUT_MS    – OpenAI call timeout in ms (default 1000, min 800, max 1500)
 */
import { NextResponse } from "next/server";
import twilio from "twilio";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { sendReportEmail } from "@/lib/mailer";
import { buildCallSystemPrompt } from "@/lib/gloria";
import { getDashboardData, storeCallReport } from "@/lib/storage";
import { getAppBaseUrl } from "@/lib/twilio";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, ScriptConfig, Topic } from "@/lib/types";

export const runtime = "nodejs";

// ─── Configuration ────────────────────────────────────────────────────────────
const AI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
const AI_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.LIVE_AI_TIMEOUT_MS || "1000", 10), 800),
  1500,
);
const MAX_TURNS = 15;

// ─── Types ────────────────────────────────────────────────────────────────────
interface GloriaDecision {
  detectedRole: "gatekeeper" | "decision-maker" | "unknown";
  reply: string;
  action: "continue" | "end_success" | "end_rejection" | "end_callback";
  appointmentNote: string;
  appointmentAtISO: string;
  directDial: string;
  consentGiven: boolean | null;
}

type StatePayload = Omit<TokenizedCallState, "issuedAt" | "expiresAt">;

// ─── OpenAI client ────────────────────────────────────────────────────────────
let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }

  return openaiClient;
}

function normalizeContactName(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  const compact = raw
    .replace(/\s+/g, " ")
    .replace(/^(herr|frau)\s+/i, "")
    .trim();

  return compact;
}

function buildNameGuidance(contactNameRaw: string | undefined) {
  const contactName = normalizeContactName(contactNameRaw);

  if (!contactName) {
    return "";
  }

  const parts = contactName.split(" ").filter(Boolean);
  const hasFullName = parts.length >= 2;
  const guidanceName = hasFullName ? contactName : `${contactName} [NACHNAME ERFRAGEN]`;

  return [
    "",
    "━━━ ZIELANSPRECHPARTNER ━━━",
    `Bekannter Name aus CRM/Testanruf: ${guidanceName}`,
    "Nutze diesen Namen konsequent und frage beim Empfang aktiv nach diesem Kontakt.",
    "WICHTIG: Nutze nie den Platzhalter 'Herr/Frau Neumann', wenn ein anderer Name vorliegt.",
    hasFullName
      ? `Formuliere bei Empfang z. B.: "Ich würde gern mit ${contactName} sprechen."`
      : `Wenn nur Vorname bekannt ist, frage nach dem vollständigen Namen von ${contactName}.`,
  ].join("\n");
}

function normalizeDirectDial(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const compact = raw.trim().replace(/\(0\)/g, "");
  const keepsPlus = compact.startsWith("+");
  const digits = compact.replace(/[^\d]/g, "");

  if (digits.length < 6) {
    return undefined;
  }

  if (keepsPlus) {
    return `+${digits}`;
  }

  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }

  return digits;
}

function extractDirectDialFromText(text: string): string | undefined {
  const match = text.match(/(\+?\d[\d\s()\/-]{5,}\d)/);
  return normalizeDirectDial(match?.[1]);
}

function signalsUnavailable(text: string): boolean {
  return /(nicht\s+da|nicht\s+verf[üu]gbar|nicht\s+erreichbar|im\s+termin|au[ßs]er\s+haus|heute\s+nicht|gerade\s+nicht|im\s+gespr[äa]ch)/i.test(
    text,
  );
}

function hasGloriaAskedConsent(transcript: string): boolean {
  return transcript
    .split("\n")
    .some((line) => line.startsWith("Gloria:") && /aufzeichn|aufnahme|mitschnitt/i.test(line));
}

function parseConsentAnswer(text: string): "yes" | "no" | null {
  const s = text.toLowerCase();
  if (/\bja\b|\bgerne\b|\bokay\b|\beinverstanden\b|\bnatürlich\b/.test(s)) {
    return "yes";
  }
  if (/\bnein\b|\blieber nicht\b|\bkein\b|\bohne\b/.test(s)) {
    return "no";
  }
  return null;
}

function buildConsentPrompt(script: ScriptConfig): string {
  return (
    script.recordingConsentLine?.trim() ||
    'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".'
  );
}

function buildGatekeeperTransferLine(contactNameRaw: string | undefined): string {
  const name = normalizeContactName(contactNameRaw);
  if (!name) {
    return "Danke. Könnten Sie mich bitte kurz mit der zuständigen Person verbinden?";
  }
  return `Danke. Könnten Sie mich bitte kurz mit ${name} verbinden?`;
}

function isLikelyReceptionGreeting(text: string): boolean {
  return /\b(guten\s+tag|hallo|firma|zentrale|empfang|sekretariat|buero|büro|ja\s+bitte|was\s+kann\s+ich\s+fuer\s+sie\s+tun|was\s+kann\s+ich\s+für\s+sie\s+tun)\b/i.test(
    text,
  );
}

function buildFastFirstReply(contactNameRaw: string | undefined): string {
  const target = normalizeContactName(contactNameRaw);
  if (target) {
    return `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an. Könnten Sie mich bitte kurz mit ${target} verbinden?`;
  }

  return "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an. Könnten Sie mich bitte kurz mit der zuständigen Person verbinden?";
}

function hasHealthQuestionsCovered(transcript: string): boolean {
  const text = transcript.toLowerCase();
  const checks = [
    /gesetzlich|privat|versichert/,
    /medikament|behandlung|diagnose|erkrank/,
  ];

  return checks.every((pattern) => pattern.test(text));
}

function pickHealthQuestion(script: ScriptConfig): string {
  const custom = script.healthCheckQuestions
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);

  return (
    custom ||
    "Damit ich den Termin sauber vorbereiten kann: Sind Sie aktuell gesetzlich oder privat versichert, und gibt es laufende Behandlungen oder regelmäßige Medikamente?"
  );
}

function detectPhase(params: {
  role: ContactRole;
  topic: Topic;
  consent: "yes" | "no";
  appointmentAt?: string;
  action: GloriaDecision["action"];
  transcript: string;
  reply: string;
}): string {
  if (params.action !== "continue") {
    return "Abschluss";
  }

  if (params.role !== "decision-maker") {
    return "Empfang";
  }

  const reply = params.reply.toLowerCase();
  if (params.consent !== "yes" || /aufzeichn|aufnahme|mitschnitt/.test(reply)) {
    return "Aufzeichnung";
  }

  if (
    params.topic === "private Krankenversicherung" &&
    !hasHealthQuestionsCovered(params.transcript)
  ) {
    return "Gesundheitsfragen";
  }

  if (
    params.appointmentAt ||
    /termin|uhr|dienstag|mittwoch|donnerstag|freitag|vormittag|nachmittag/.test(reply)
  ) {
    return "Terminierung";
  }

  return "Bedarf";
}

async function askOpenAI(
  systemPrompt: string,
  contactName: string | undefined,
  transcript: string,
  latestSpeech: string,
  currentRole: ContactRole,
  currentStep: TokenizedCallState["step"],
): Promise<GloriaDecision> {
  const openai = getOpenAIClient();

  if (!openai) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const roleLabel =
    currentRole === "decision-maker"
      ? "Entscheider (bereits bestätigt)"
      : "Empfang/Gatekeeper (oder noch unbekannt)";

  const userContent = [
    transcript
      ? `Bisheriger Gesprächsverlauf:\n${transcript}`
      : "(Gesprächsbeginn – erste Äußerung der anderen Seite)",
    "",
    `Angerufener sagt jetzt: "${latestSpeech}"`,
    `Zuletzt erkannte Rolle: ${roleLabel}`,
    `Erwartete Gesprächsphase: ${currentStep}`,
  ].join("\n");

  const raceResult = await Promise.race([
    openai.chat.completions.create({
      stream: false as const,
      model: AI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 120,
      messages: [
        { role: "system", content: `${systemPrompt}${buildNameGuidance(contactName)}` },
        { role: "user", content: userContent },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OpenAI timeout")), AI_TIMEOUT_MS),
    ),
  ]);
  const completion = raceResult as ChatCompletion;

  let parsed: Partial<GloriaDecision> = {};
  try {
    parsed = JSON.parse(
      completion.choices[0]?.message?.content || "{}",
    ) as Partial<GloriaDecision>;
  } catch {
    /* keep defaults below */
  }

  const validActions = [
    "continue",
    "end_success",
    "end_rejection",
    "end_callback",
  ] as const;
  const validRoles = ["gatekeeper", "decision-maker", "unknown"] as const;

  return {
    detectedRole: validRoles.includes(parsed.detectedRole as (typeof validRoles)[number])
      ? (parsed.detectedRole as GloriaDecision["detectedRole"])
      : "unknown",
    reply:
      typeof parsed.reply === "string" && parsed.reply.trim().length > 0
        ? parsed.reply.trim()
        : "Entschuldigung, ich hatte kurz eine Verbindungsstörung. Ich bin wieder da.",
    action: validActions.includes(parsed.action as (typeof validActions)[number])
      ? (parsed.action as GloriaDecision["action"])
      : "continue",
    appointmentNote:
      typeof parsed.appointmentNote === "string" ? parsed.appointmentNote : "",
    appointmentAtISO:
      typeof parsed.appointmentAtISO === "string" ? parsed.appointmentAtISO.trim() : "",
    directDial:
      typeof parsed.directDial === "string" ? parsed.directDial.trim() : "",
    consentGiven:
      typeof parsed.consentGiven === "boolean" ? parsed.consentGiven : null,
  };
}

function normalizeAppointmentAt(value: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

// ─── TwiML helpers ────────────────────────────────────────────────────────────
function buildAudioUrl(baseUrl: string, text: string) {
  const u = new URL(`${baseUrl}/api/twilio/audio`);
  u.searchParams.set("text", text);
  return u.toString();
}

function respondWithGather(
  twiml: twilio.twiml.VoiceResponse,
  baseUrl: string,
  text: string,
  nextState: StatePayload,
): NextResponse {
  const token = encodeCallStateToken(nextState);
  const actionUrl = `${baseUrl}/api/twilio/voice/process?state=${encodeURIComponent(token)}`;

  if (isElevenLabsConfigured()) {
    twiml.play(buildAudioUrl(baseUrl, text));
  } else {
    twiml.say({ voice: "alice", language: "de-DE" }, text);
  }

  twiml.gather({
    input: ["speech"],
    action: actionUrl,
    method: "POST",
    language: "de-DE",
    speechTimeout: "1",
    timeout: 3,
    actionOnEmptyResult: true,
    hints: "ja, nein, gerne, einen Moment, ich verbinde, kein Interesse, kein Bedarf",
  });

  // Fallback: Twilio re-sends to same URL if no speech captured
  twiml.redirect({ method: "POST" }, actionUrl);

  return new NextResponse(twiml.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function respondWithHangup(
  twiml: twilio.twiml.VoiceResponse,
  baseUrl: string,
  text: string,
): NextResponse {
  if (isElevenLabsConfigured()) {
    twiml.play(buildAudioUrl(baseUrl, text));
  } else {
    twiml.say({ voice: "alice", language: "de-DE" }, text);
  }
  twiml.hangup();
  return new NextResponse(twiml.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─── State helpers ────────────────────────────────────────────────────────────
function buildInitialState(params: {
  callSid: string;
  company: string;
  contactName: string;
  topic: Topic;
  leadId?: string;
}): TokenizedCallState {
  const now = Math.floor(Date.now() / 1000);
  return {
    callSid: params.callSid,
    company: params.company,
    contactName: params.contactName,
    topic: params.topic,
    leadId: params.leadId,
    step: "intro",
    consent: "no",
    consentAsked: false,
    turn: 0,
    transcript: "",
    contactRole: "gatekeeper", // safe default; OpenAI will correct if decision-maker
    issuedAt: now,
    expiresAt: now + 7200,
  };
}

function trimTranscript(text: string, maxLen = 3500): string {
  if (text.length <= maxLen) return text;
  const lines = text.split("\n");
  while (text.length > maxLen && lines.length > 4) {
    lines.splice(1, 2);
    text = lines.join("\n");
  }
  return text;
}

function toStatePayload(state: TokenizedCallState): StatePayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { issuedAt: _a, expiresAt: _b, ...rest } = state;
  return rest;
}

// ─── Report storage ───────────────────────────────────────────────────────────
async function finalizeCall(
  state: TokenizedCallState,
  outcome: ReportOutcome,
  note: string,
  appointmentAt?: string,
  nextCallAt?: string,
  directDial?: string,
): Promise<void> {
  const directDialLine = directDial ? `\nDirekte Durchwahl: ${directDial}` : "";
  const callbackLine =
    outcome === "Wiedervorlage" && nextCallAt
      ? `\n\n--- Wiedervorlage ---\nGeplanter Rückruf: ${nextCallAt}`
      : "";
  const summary = note
    ? `${state.transcript}\n\n--- Terminnotiz ---\n${note}${directDialLine}${callbackLine}`
    : `${state.transcript}${directDialLine}${callbackLine}`;
  try {
    const report = await storeCallReport({
      callSid: state.callSid,
      leadId: state.leadId,
      company: state.company,
      contactName: state.contactName,
      topic: state.topic as Topic,
      summary,
      outcome,
      appointmentAt,
      nextCallAt,
      directDial,
      recordingConsent: state.consent === "yes",
      attempts: 1,
    });
    if (report) {
      await sendReportEmail(report).catch(() => {
        /* non-critical */
      });
    }
  } catch {
    /* storage failure must not crash the call */
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getAppBaseUrl(request);

  try {
    const url = new URL(request.url);
    const form = await request.formData();
    const tokenFromQuery = url.searchParams.get("state") || "";
    const tokenFromForm = String(form.get("state") || "").trim();
    const speech = String(form.get("SpeechResult") || "").trim();
    const digits = String(form.get("Digits") || "").trim();
    const callSid = String(form.get("CallSid") || "").trim();
    const isFallback = url.searchParams.get("fallback") === "1";

    // Restore persisted state or create fresh initial state for turn 0
    const tokenState = decodeCallStateToken(tokenFromForm || tokenFromQuery, callSid);
    const state: TokenizedCallState = tokenState ?? buildInitialState({
      callSid,
      company: url.searchParams.get("company") || "Ihr Unternehmen",
      contactName: url.searchParams.get("contactName") || "",
      topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
      leadId: url.searchParams.get("leadId") || undefined,
    });

    const heardText = speech || digits;

    // ── Safety: absolute turn limit ────────────────────────────────────────────
    if (state.turn >= MAX_TURNS) {
      await finalizeCall(state, "Kein Kontakt", "Maximale Gesprächsrunden erreicht.");
      return respondWithHangup(
        twiml,
        baseUrl,
        "Ich bedanke mich für Ihre Zeit und melde mich zu einem anderen Zeitpunkt. Auf Wiederhören.",
      );
    }

    // ── Load admin script for this topic ──────────────────────────────────────
    const dashboardData = await getDashboardData();
    const activeScript: ScriptConfig =
      dashboardData.scripts.find((s) => s.topic === state.topic) ?? {
        id: "fallback",
        topic: state.topic,
        opener:
          "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.",
        discovery: "Darf ich kurz erklären, worum es geht?",
        objectionHandling: "Ich verstehe Ihre Bedenken.",
        close: "Wann würde ein kurzer Termin passen?",
      };

    const systemPrompt = buildCallSystemPrompt(activeScript);

    // ── Fast path for call start ─────────────────────────────────────────────
    // On the first utterance from a typical receptionist greeting, answer
    // immediately without waiting for an OpenAI round-trip.
    if (state.turn === 0 && heardText && isLikelyReceptionGreeting(heardText)) {
      const quickReply = buildFastFirstReply(state.contactName);
      const updatedTranscript = trimTranscript(
        [
          state.transcript,
          "Phase: Empfang",
          `Interessent: ${heardText}`,
          `Gloria: ${quickReply}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return respondWithGather(twiml, baseUrl, quickReply, {
        ...toStatePayload(state),
        transcript: updatedTranscript,
        turn: state.turn + 1,
        step: "intro",
        contactRole: "gatekeeper",
      });
    }

    // ── No speech / timeout fallback ──────────────────────────────────────────
    if (!heardText || isFallback) {
      const introLine =
        state.turn === 0
          ? "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an."
          : "Entschuldigung, ich habe Sie leider nicht verstanden. Sind Sie noch da?";

      return respondWithGather(twiml, baseUrl, introLine, {
        ...toStatePayload(state),
        turn: state.turn + 1,
        step: "intro",
        transcript: trimTranscript(`${state.transcript}\nGloria: ${introLine}`),
      });
    }

    // ── Consent tracking ──────────────────────────────────────────────────────
    let updatedConsent = state.consent;
    let consentAsked = state.consentAsked || hasGloriaAskedConsent(state.transcript);
    const consentAnswer = parseConsentAnswer(heardText);

    const lastGloria = state.transcript
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("Gloria:"));

    if (lastGloria && /aufzeichn|aufnahme|mitschnitt/i.test(lastGloria)) {
      consentAsked = true;
      if (consentAnswer === "yes") {
        updatedConsent = "yes";
      } else if (consentAnswer === "no") {
        updatedConsent = "no";
      }
    }

    // ── Ask OpenAI ────────────────────────────────────────────────────────────
    const decision = await askOpenAI(
      systemPrompt,
      state.contactName,
      state.transcript,
      heardText,
      state.contactRole as ContactRole,
      state.step,
    ).catch(
      (): GloriaDecision => ({
        detectedRole: "unknown",
        reply:
          "Entschuldigung, ich hatte kurz eine technische Unterbrechung. Ich bin gleich wieder für Sie da.",
        action: "continue",
        appointmentNote: "",
        appointmentAtISO: "",
        directDial: "",
        consentGiven: null,
      }),
    );

    let appointmentAt = normalizeAppointmentAt(decision.appointmentAtISO);
    let directDial =
      normalizeDirectDial(decision.directDial) ||
      extractDirectDialFromText(heardText) ||
      normalizeDirectDial(state.directDial);

    // Override consent if OpenAI confirmed it explicitly
    if (decision.consentGiven === true) {
      updatedConsent = "yes";
      consentAsked = true;
    }
    if (decision.consentGiven === false) {
      updatedConsent = "no";
      consentAsked = true;
    }

    // Once identified as decision-maker, never downgrade back to gatekeeper
    const newRole: ContactRole =
      state.contactRole === "decision-maker"
        ? "decision-maker"
        : decision.detectedRole === "decision-maker"
          ? "decision-maker"
          : "gatekeeper";

    // Order guardrail 1: At reception, only transfer / callback handling - no final appointment.
    if (newRole !== "decision-maker" && decision.action === "end_success") {
      decision.action = "continue";
      decision.reply = buildGatekeeperTransferLine(state.contactName);
      appointmentAt = undefined;
    }

    // Order guardrail 2: As soon as the decision-maker is on the line, ask consent first.
    if (newRole === "decision-maker" && !consentAsked) {
      decision.action = "continue";
      decision.reply = buildConsentPrompt(activeScript);
      consentAsked = true;
      appointmentAt = undefined;
    }

    // For PKV, health questions are mandatory before ending successfully.
    if (
      state.topic === "private Krankenversicherung" &&
      newRole === "decision-maker" &&
      !hasHealthQuestionsCovered(state.transcript)
    ) {
      decision.action = "continue";
      decision.reply = pickHealthQuestion(activeScript);
      appointmentAt = undefined;
    }

    // Never finish as successful appointment without exact date-time.
    if (decision.action === "end_success" && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Sehr gern. Damit ich den Termin fest eintrage, brauche ich bitte ein genaues Datum mit Uhrzeit. Was passt Ihnen konkret?";
    }

    const unavailableAtReception =
      newRole !== "decision-maker" && signalsUnavailable(heardText);

    if (unavailableAtReception && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Danke für die Info. Wann erreiche ich Herrn oder Frau am besten erneut, bitte mit konkretem Datum und Uhrzeit?";
    }

    if ((unavailableAtReception || decision.action === "end_callback") && !directDial) {
      decision.action = "continue";
      decision.reply =
        "Danke. Damit ich beim Rückruf direkt durchkomme: Wie lautet bitte die direkte Durchwahl oder Mobilnummer?";
    }

    if (decision.action === "end_callback" && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Gern notiere ich die Wiedervorlage. Bitte nennen Sie mir ein konkretes Datum mit Uhrzeit für den Rückruf.";
    }

    const nextStep: TokenizedCallState["step"] =
      decision.action !== "continue"
        ? "finished"
        : newRole !== "decision-maker"
          ? "intro"
          : !consentAsked
            ? "consent"
            : appointmentAt
              ? "appointment"
              : "conversation";

    const phase = detectPhase({
      role: newRole,
      topic: state.topic,
      consent: updatedConsent,
      appointmentAt,
      action: decision.action,
      transcript: state.transcript,
      reply: decision.reply,
    });

    const updatedTranscript = trimTranscript(
      [
        state.transcript,
        `Phase: ${phase}`,
        `Interessent: ${heardText}`,
        `Gloria: ${decision.reply}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    // ── End call ──────────────────────────────────────────────────────────────
    if (decision.action !== "continue") {
      const outcome: ReportOutcome =
        decision.action === "end_success"
          ? "Termin"
          : decision.action === "end_callback"
            ? "Wiedervorlage"
            : "Absage";

      await finalizeCall(
        {
          ...state,
          directDial,
          consent: updatedConsent,
          consentAsked,
          contactRole: newRole,
          transcript: updatedTranscript,
          turn: state.turn + 1,
          step: nextStep,
        },
        outcome,
        decision.appointmentNote,
        outcome === "Termin" ? appointmentAt : undefined,
        outcome === "Wiedervorlage" ? appointmentAt : undefined,
        directDial,
      );
      return respondWithHangup(twiml, baseUrl, decision.reply);
    }

    // ── Continue conversation ─────────────────────────────────────────────────
    return respondWithGather(twiml, baseUrl, decision.reply, {
      ...toStatePayload(state),
      directDial,
      consent: updatedConsent,
      consentAsked,
      contactRole: newRole,
      transcript: updatedTranscript,
      turn: state.turn + 1,
      step: nextStep,
    });
  } catch (error) {
    console.error("[gloria/process] Unhandled error:", error);
    twiml.say(
      { voice: "alice", language: "de-DE" },
      "Entschuldigung, es ist ein technischer Fehler aufgetreten. Ich melde mich nochmals.",
    );
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }
}

// GET is used when Twilio follows a redirect within an ongoing call
export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
