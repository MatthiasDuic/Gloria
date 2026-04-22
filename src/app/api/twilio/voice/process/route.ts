import { NextResponse } from "next/server";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildCallSystemPrompt } from "@/lib/gloria";
import { getAppBaseUrl } from "@/lib/twilio";
import { buildGatherTwiml, buildSayHangupTwiml } from "@/lib/twiml";
import { buildSignedAudioUrl } from "@/lib/audio-url";
import { validateTwilioRequest } from "@/lib/twilio-signature";
import { log } from "@/lib/log";
import { AI_CONFIG } from "@/lib/ai-config";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type RoleState,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, ScriptConfig, Topic } from "@/lib/types";

export const runtime = "edge";

const AI_MODEL = AI_CONFIG.chatModel;
const AI_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.LIVE_AI_TIMEOUT_MS || "1600", 10), 900),
  4500,
);
const REPLY_GATHER_TIMEOUT_SECONDS = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.TWILIO_REPLY_GATHER_TIMEOUT_SECONDS || "1", 10)),
);
const LISTEN_ONLY_TIMEOUT_SECONDS = Math.min(
  8,
  Math.max(2, Number.parseInt(process.env.TWILIO_LISTEN_ONLY_TIMEOUT_SECONDS || "3", 10)),
);
const SCRIPT_CACHE_MS = 60_000;

type StatePayload = Omit<TokenizedCallState, "issuedAt" | "expiresAt">;

interface GloriaDecision {
  detectedRole: "gatekeeper" | "decision-maker" | "unknown";
  reply: string;
  action: "continue" | "end_success" | "end_rejection" | "end_callback";
  appointmentNote: string;
  appointmentAtISO: string;
  directDial: string;
  consentGiven: boolean | null;
}

const PRIVATE_HEALTH_QUESTIONS = [
  "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?",
  "Könnten Sie mir bitte Ihre Körpergröße und Ihr aktuelles Gewicht nennen?",
  "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
  "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
  "Gibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?",
  "Nehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?",
  "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
  "Gab es in den letzten zehn Jahren psychische Behandlungen?",
  "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
  "Bestehen bei Ihnen bekannte Allergien?",
] as const;

const PKV_HEALTH_INTRO =
  "Damit wir den Termin optimal vorbereiten können, müssen wir kurz ein paar Basisinformationen abklären.";

function getConsentPrompt(script: ScriptConfig): string {
  return (
    script.consentPrompt?.trim() ||
    'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".'
  );
}

function getPkvHealthIntro(script: ScriptConfig): string {
  return script.pkvHealthIntro?.trim() || PKV_HEALTH_INTRO;
}

function getPkvHealthQuestions(script: ScriptConfig): string[] {
  const configured = (script.pkvHealthQuestions || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (configured.length > 0) {
    return configured;
  }

  return [...PRIVATE_HEALTH_QUESTIONS];
}

const scriptsCacheByUser: Record<string, Partial<Record<Topic, ScriptConfig>>> = {};
const scriptsCacheAtByUser: Record<string, number> = {};
const scriptsSyncInFlightByUser: Record<string, Promise<void> | null> = {};
const scriptOriginByUser: Record<string, Partial<Record<Topic, "user-db" | "fallback">>> = {};

function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();
  const token = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (username && password) {
    headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  if (token) {
    headers["x-gloria-internal-token"] = token;
  }

  return headers;
}

function normalizeContactName(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  return raw
    .replace(/\s+/g, " ")
    .replace(/^(herr|frau)\s+/i, "")
    .trim();
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

function hasGloriaAskedConsent(transcript: string): boolean {
  return transcript
    .split("\n")
    .some((line) => line.startsWith("Gloria:") && /aufzeichn|aufnahme|mitschnitt/i.test(line));
}

function isShortAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length > 12) {
    return false;
  }

  return /^(ja|jap|okay|ok|genau|mhm|hm|klar|gern|gerne)\.?$/.test(t);
}

function isDecisionMakerAlreadyOnLine(text: string): boolean {
  const lower = text.toLowerCase().replace(/\s+/g, " ").trim();

  return /\b(ich\s+bin\s+(schon\s+)?dran|ich\s+bin\s+am\s+apparat|ja,?\s*ich\s+bin(?:\s+es)?\b|ja,?\s*selbst\b|das\s+bin\s+ich\b|spreche\s+selbst|sprechen\s+sie\s+mit\s+mir|selbst\s+am\s+apparat|ich\s+bin\s+zustaendig|ich\s+bin\s+der\s+richtige\s+ansprechpartner|ich\s+bin\s+die\s+richtige\s+ansprechpartnerin|genau,?\s*ich\s+bin\s+zustaendig)\b/.test(
    lower,
  );
}

function isLikelyDecisionMakerGreeting(text: string): boolean {
  const lower = text.toLowerCase();

  if (
    /\b(warteschleife|bitte\s+warten|einen\s+augenblick|einen\s+moment|ich\s+verbinde|verbinde\s+sie|musik)\b/.test(
      lower,
    )
  ) {
    return false;
  }

  return /\b(hallo|guten\s+tag|ja\s+bitte|sprech[e]?\s+ich\s+mit|am\s+apparat|ich\s+bin\s+es|worum\s+geht\s+es)\b/i.test(
    text,
  );
}

function isLikelyTransferAcknowledgement(text: string): boolean {
  return /\b(einen\s+moment|einen\s+augenblick|ich\s+verbinde|ich\s+stell\s+durch|bleiben\s+sie\s+dran|bitte\s+warten|warteschleife)\b/i.test(
    text,
  );
}

function detectRoleState(params: {
  currentRole: ContactRole;
  modelDetectedRole: GloriaDecision["detectedRole"];
  heardText: string;
}): { contactRole: ContactRole; roleState: RoleState } {
  const lower = params.heardText.toLowerCase();

  if (
    params.currentRole === "decision-maker" ||
    params.modelDetectedRole === "decision-maker"
  ) {
    return { contactRole: "decision-maker", roleState: "decision_maker" };
  }

  if (/\b(verbinde|einen\s+moment|ich\s+stell\s+durch|ich\s+verbinde)\b/.test(lower)) {
    return { contactRole: "gatekeeper", roleState: "transfer" };
  }

  return { contactRole: "gatekeeper", roleState: "reception" };
}

function buildGatekeeperTransferLine(contactNameRaw: string | undefined): string {
  const name = normalizeContactName(contactNameRaw);
  if (!name) {
    return "Danke. Könnten Sie mich bitte kurz mit der zuständigen Person verbinden?";
  }
  return `Danke. Könnten Sie mich bitte kurz mit ${name} verbinden?`;
}

function splitByAnswerWaitMarker(text: string): string[] {
  return text
    .split(/\[\s*antwort\s+abwarten\s*\]/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
}

function trimTranscript(text: string, maxLen = 3500): string {
  if (text.length <= maxLen) {
    return text;
  }

  const lines = text.split("\n");
  const keepTail = lines.slice(-18);
  let compact = keepTail.join("\n");
  if (compact.length > maxLen) {
    compact = compact.slice(compact.length - maxLen);
  }
  return compact;
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

function detectAppointmentPreference(text: string): "morning" | "afternoon" | "any" {
  const lower = text.toLowerCase();

  if (/\b(vormittag|morgens|frueh|früh)\b/.test(lower)) {
    return "morning";
  }

  if (/\b(nachmittag|abends|spaet|spät)\b/.test(lower)) {
    return "afternoon";
  }

  return "any";
}

function detectAppointmentPreferenceFromTranscript(transcript: string):
  | "morning"
  | "afternoon"
  | "any" {
  const lines = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Interessent:"));

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = lines[i].replace(/^Interessent:\s*/i, "");
    const preference = detectAppointmentPreference(text);
    if (preference !== "any") {
      return preference;
    }
  }

  return "any";
}

function toSlotIso(base: Date, hour: number, minute: number): string {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function getNextMonday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const daysUntilNextMonday = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + daysUntilNextMonday);
  return d;
}

function buildNextWeekAppointmentOptions(
  preference: "morning" | "afternoon" | "any",
  now = new Date(),
): { optionAAt: string; optionBAt: string } {
  const monday = getNextMonday(now);
  const tuesday = new Date(monday);
  tuesday.setDate(monday.getDate() + 1);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);

  if (preference === "morning") {
    return {
      optionAAt: toSlotIso(tuesday, 10, 0),
      optionBAt: toSlotIso(thursday, 11, 0),
    };
  }

  if (preference === "afternoon") {
    return {
      optionAAt: toSlotIso(tuesday, 14, 30),
      optionBAt: toSlotIso(thursday, 16, 0),
    };
  }

  return {
    optionAAt: toSlotIso(tuesday, 10, 30),
    optionBAt: toSlotIso(thursday, 15, 30),
  };
}

function formatAppointmentLabel(iso: string): string {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function pickSuggestedAppointmentAt(
  heardText: string,
  optionAAt?: string,
  optionBAt?: string,
): string | undefined {
  const lower = heardText.toLowerCase();

  if (!optionAAt && !optionBAt) {
    return undefined;
  }

  if (/\b(erste|erster|option\s*1|eins|dienstag)\b/.test(lower)) {
    return optionAAt;
  }

  if (/\b(zweite|zweiter|option\s*2|zwei|donnerstag)\b/.test(lower)) {
    return optionBAt;
  }

  if (isShortAffirmative(heardText)) {
    return optionAAt;
  }

  return undefined;
}

function parseSpokenAppointmentAt(text: string, now = new Date()): string | undefined {
  const lower = text.toLowerCase();

  const weekdayMap: Record<string, number> = {
    montag: 1,
    dienstag: 2,
    mittwoch: 3,
    donnerstag: 4,
    freitag: 5,
    samstag: 6,
    sonntag: 0,
  };

  const weekdayMatch = lower.match(
    /\b(uebernaechsten|übernächsten|naechsten|nächsten)?\s*(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i,
  );
  const timeMatch = lower.match(/\bum\s*(\d{1,2})(?::|\.|\s*uhr\s*)(\d{2})?\s*(uhr)?\b/i)
    || lower.match(/\bum\s*(\d{1,2})\s*uhr\b/i);

  if (!weekdayMatch || !timeMatch) {
    return undefined;
  }

  const modifier = (weekdayMatch[1] || "").toLowerCase();
  const weekdayWord = weekdayMatch[2].toLowerCase();
  const targetWeekday = weekdayMap[weekdayWord];

  if (targetWeekday === undefined) {
    return undefined;
  }

  const nextMonday = getNextMonday(now);
  const monday = new Date(nextMonday);
  if (/uebernaechsten|übernächsten/.test(modifier)) {
    monday.setDate(monday.getDate() + 7);
  }

  const target = new Date(monday);
  const offset = ((targetWeekday + 7) - monday.getDay()) % 7;
  target.setDate(monday.getDate() + offset);

  let hour = Number.parseInt(timeMatch[1], 10);
  const minute = Number.parseInt(timeMatch[2] || "0", 10);

  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) {
    return undefined;
  }

  if (/nachmittag|abends|spaet|spät/.test(lower) && hour < 12) {
    hour += 12;
  }

  target.setHours(hour, minute, 0, 0);
  return target.toISOString();
}

function wantsToRejectBothSuggestions(text: string): boolean {
  return /\b(beide\s+nicht|beides\s+nicht|passt\s+beides\s+nicht|keiner\s+der\s+beiden|keine\s+der\s+beiden|nichts\s+davon)\b/i.test(
    text,
  );
}

function toStatePayload(state: TokenizedCallState): StatePayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { issuedAt: _a, expiresAt: _b, ...rest } = state;
  return rest;
}

function getOwnerIdentity(state: TokenizedCallState): { ownerCompany: string; ownerName: string } {
  return {
    ownerCompany: state.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel",
    ownerName: state.ownerRealName?.trim() || "Herrn Matthias Duic",
  };
}

function buildOwnerIntroLine(state: TokenizedCallState): string {
  const identity = getOwnerIdentity(state);
  return `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin von ${identity.ownerCompany}. Ich rufe im Auftrag von ${identity.ownerName} an.`;
}

function buildInitialState(params: {
  callSid: string;
  company: string;
  contactName: string;
  topic: Topic;
  leadId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  userId?: string;
  phoneNumberId?: string;
}): TokenizedCallState {
  const now = Math.floor(Date.now() / 1000);
  return {
    callSid: params.callSid,
    userId: params.userId,
    phoneNumberId: params.phoneNumberId,
    ownerRealName: params.ownerRealName,
    ownerCompanyName: params.ownerCompanyName,
    company: params.company,
    contactName: params.contactName,
    topic: params.topic,
    leadId: params.leadId,
    decisionMakerIntroDone: false,
    scriptPhaseIndex: 0,
    scriptSegmentIndex: 0,
    healthQuestionIndex: 0,
    pkvHealthIntroDone: false,
    appointmentAtDraft: undefined,
    appointmentNoteDraft: undefined,
    appointmentProposalAsked: false,
    appointmentPreference: "any",
    appointmentOptionAAt: undefined,
    appointmentOptionBAt: undefined,
    step: "intro",
    consent: "no",
    consentAsked: false,
    turn: 0,
    transcript: "",
    contactRole: "gatekeeper",
    roleState: "reception",
    issuedAt: now,
    expiresAt: now + 7200,
  };
}

// Audio-URL wird zentral und signiert in @/lib/audio-url gebaut.

function buildNameGuidance(contactNameRaw?: string): string {
  const contactName = normalizeContactName(contactNameRaw);
  if (!contactName) {
    return "";
  }

  return [
    "",
    "━━━ ZIELANSPRECHPARTNER ━━━",
    `Bekannter Name aus CRM/Testanruf: ${contactName}`,
    "Nutze diesen Namen konsequent und frage beim Empfang aktiv nach diesem Kontakt.",
  ].join("\n");
}

async function syncScripts(baseUrl: string, userId?: string): Promise<void> {
  const cacheKey = userId || "global";
  const now = Date.now();
  const cached = scriptsCacheByUser[cacheKey] || {};
  const cachedAt = scriptsCacheAtByUser[cacheKey] || 0;

  if (now - cachedAt < SCRIPT_CACHE_MS && Object.keys(cached).length > 0) {
    return;
  }

  if (scriptsSyncInFlightByUser[cacheKey]) {
    await scriptsSyncInFlightByUser[cacheKey];
    return;
  }

  scriptsSyncInFlightByUser[cacheKey] = (async () => {
    const internalHeaders = buildInternalHeaders();

    const scriptsUrl = new URL(`${baseUrl}/api/twilio/playbooks`);
    if (userId) {
      scriptsUrl.searchParams.set("userId", userId);
    }

    let response = await fetch(scriptsUrl.toString(), {
      method: "GET",
      headers: internalHeaders,
      cache: "no-store",
    });

    if (!response.ok) {
      // Backward-compatible fallback for older deployments.
      response = await fetch(`${baseUrl}/api/reports`, {
        method: "GET",
        headers: internalHeaders,
        cache: "no-store",
      });
    }

    if (!response.ok) {
      // Continue with cached/default scripts so calls do not fail hard.
      console.warn(`[gloria/process] Script sync failed (${response.status}). Using cache/fallback.`);
      return;
    }

    const payload = (await response.json()) as { playbooks?: ScriptConfig[] };
    const next: Partial<Record<Topic, ScriptConfig>> = {};

    for (const script of payload.playbooks || []) {
      next[script.topic] = script;
    }

    scriptsCacheByUser[cacheKey] = next;
    scriptsCacheAtByUser[cacheKey] = Date.now();
  })();

  try {
    await scriptsSyncInFlightByUser[cacheKey];
  } finally {
    scriptsSyncInFlightByUser[cacheKey] = null;
  }
}

function getTopicScript(topic: Topic, userId?: string): ScriptConfig {
  const cacheKey = userId || "global";
  const scopedCache = scriptsCacheByUser[cacheKey] || {};
  const script = scopedCache[topic] || {
    id: "fallback",
    topic,
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.",
    discovery: "Darf ich kurz erklären, worum es geht?",
    objectionHandling: "Ich verstehe Ihre Bedenken.",
    close: "Wann würde ein kurzer Termin passen?",
  };

  // Track script origin for debugging campaign calls
  if (!scriptOriginByUser[cacheKey]) {
    scriptOriginByUser[cacheKey] = {};
  }
  scriptOriginByUser[cacheKey][topic] = scopedCache[topic] ? "user-db" : "fallback";

  return script;
}

function getScriptOrigin(topic: Topic, userId?: string): string {
  const cacheKey = userId || "global";
  const origin = (scriptOriginByUser[cacheKey] || {})[topic] || "fallback";
  return userId ? `user:${userId}:${origin}` : `global:${origin}`;
}

async function askOpenAI(
  systemPrompt: string,
  contactName: string | undefined,
  transcript: string,
  latestSpeech: string,
  currentRole: ContactRole,
  currentStep: TokenizedCallState["step"],
): Promise<GloriaDecision> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
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
    `Angerufener sagt jetzt: \"${latestSpeech}\"`,
    `Zuletzt erkannte Rolle: ${roleLabel}`,
    `Erwartete Gesprächsphase: ${currentStep}`,
  ].join("\n");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const started = Date.now();

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 220,
        messages: [
          { role: "system", content: `${systemPrompt}${buildNameGuidance(contactName)}` },
          { role: "user", content: userContent },
        ],
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      log.error("openai.http_error", {
        event: "openai.chat_completions",
        status: response.status,
        latencyMs: Date.now() - started,
      });
      throw new Error(`OpenAI error (${response.status}): ${details}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    log.info("openai.reply", {
      event: "openai.chat_completions",
      latencyMs: Date.now() - started,
      step: currentStep,
      role: currentRole,
    });

    let parsed: Partial<GloriaDecision> = {};
    try {
      parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}") as Partial<GloriaDecision>;
    } catch {
      parsed = {};
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
      appointmentNote: typeof parsed.appointmentNote === "string" ? parsed.appointmentNote : "",
      appointmentAtISO: typeof parsed.appointmentAtISO === "string" ? parsed.appointmentAtISO.trim() : "",
      directDial: typeof parsed.directDial === "string" ? parsed.directDial.trim() : "",
      consentGiven: typeof parsed.consentGiven === "boolean" ? parsed.consentGiven : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function finalizeCall(params: {
  state: TokenizedCallState;
  outcome: ReportOutcome;
  note: string;
  appointmentAt?: string;
  nextCallAt?: string;
  directDial?: string;
  baseUrl: string;
}): Promise<void> {
  const directDialLine = params.directDial ? `\nDirekte Durchwahl: ${params.directDial}` : "";
  const callbackLine =
    params.outcome === "Wiedervorlage" && params.nextCallAt
      ? `\n\n--- Wiedervorlage ---\nGeplanter Rückruf: ${params.nextCallAt}`
      : "";
  const summary = params.note
    ? `${params.state.transcript}\n\n--- Terminnotiz ---\n${params.note}${directDialLine}${callbackLine}`
    : `${params.state.transcript}${directDialLine}${callbackLine}`;

  try {
    await fetch(`${params.baseUrl}/api/calls/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: params.state.userId,
        phoneNumberId: params.state.phoneNumberId,
        callSid: params.state.callSid,
        leadId: params.state.leadId,
        company: params.state.company,
        contactName: params.state.contactName,
        topic: params.state.topic,
        summary,
        outcome: params.outcome,
        appointmentAt: params.appointmentAt,
        nextCallAt: params.nextCallAt,
        directDial: params.directDial,
        recordingConsent: params.state.consent === "yes",
        attempts: 1,
      }),
      cache: "no-store",
    });
  } catch {
    // Report storage must not break call completion.
  }
}

async function respondWithGather(
  baseUrl: string,
  text: string,
  nextState: StatePayload,
): Promise<NextResponse> {
  const token = await encodeCallStateToken(nextState);
  const actionUrl = `${baseUrl}/api/twilio/voice/process?state=${encodeURIComponent(token)}`;

  const twiml = buildGatherTwiml({
    ...(isElevenLabsConfigured()
      ? { playUrl: await buildSignedAudioUrl(baseUrl, text) }
      : { sayText: text }),
    gather: {
      input: "speech",
      action: actionUrl,
      method: "POST",
      language: "de-DE",
      speechTimeout: "auto",
      timeout: REPLY_GATHER_TIMEOUT_SECONDS,
      actionOnEmptyResult: true,
      hints: "ja, nein, gerne, einen Moment, ich verbinde, kein Interesse, kein Bedarf",
    },
    redirectUrl: actionUrl,
    redirectMethod: "POST",
  });

  if (nextState.callSid && nextState.company && nextState.topic && text.trim()) {
    void fetch(`${baseUrl}/api/calls/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: nextState.userId,
        phoneNumberId: nextState.phoneNumberId,
        callSid: nextState.callSid,
        leadId: nextState.leadId,
        company: nextState.company,
        contactName: nextState.contactName,
        topic: nextState.topic,
        summaryChunk: `Gloria: ${text.trim()}`,
        attempts: 1,
      }),
      cache: "no-store",
    }).catch(() => {
      // Transcript chunk persistence is best-effort and must not delay call flow.
    });
  }

  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

async function respondWithListenOnly(
  baseUrl: string,
  nextState: StatePayload,
): Promise<NextResponse> {
  const token = await encodeCallStateToken(nextState);
  const actionUrl = `${baseUrl}/api/twilio/voice/process?state=${encodeURIComponent(token)}`;

  const twiml = buildGatherTwiml({
    gather: {
      input: "speech",
      action: actionUrl,
      method: "POST",
      language: "de-DE",
      speechTimeout: "auto",
      timeout: LISTEN_ONLY_TIMEOUT_SECONDS,
      actionOnEmptyResult: true,
      hints: "hallo, guten tag, ja bitte, worum geht es, ich bin am apparat",
    },
    redirectUrl: actionUrl,
    redirectMethod: "POST",
  });

  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

async function respondWithHangup(baseUrl: string, text: string): Promise<NextResponse> {
  const normalized = text.trim();
  const hasThanks = /danke|vielen\s+dank/i.test(normalized);
  const hasGoodbye = /auf\s+wiederh[oö]ren|tsch[uü]ss|bis\s+bald/i.test(normalized);
  const outro = `${hasThanks ? "" : " Vielen Dank für das Telefonat."}${hasGoodbye ? "" : " Auf Wiederhören."}`;
  const finalText = `${normalized}${outro}`.trim();

  const twiml = buildSayHangupTwiml(
    isElevenLabsConfigured()
      ? { playUrl: await buildSignedAudioUrl(baseUrl, finalText) }
      : { sayText: finalText },
  );

  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const baseUrl = getAppBaseUrl(request);

  const signature = await validateTwilioRequest(request);
  if (!signature.ok) {
    log.warn("twilio.signature_rejected", {
      event: "voice.process",
      reason: signature.reason,
    });
    return new NextResponse(
      buildSayHangupTwiml({
        sayText: "Diese Anfrage konnte nicht verifiziert werden.",
      }),
      { status: 403, headers: { "Content-Type": "text/xml; charset=utf-8" } },
    );
  }

  try {
    const url = new URL(request.url);
    const form = signature.form ?? (await request.formData());
    const tokenFromQuery = url.searchParams.get("state") || "";
    const tokenFromForm = String(form.get("state") || "").trim();
    const speech = String(form.get("SpeechResult") || "").trim();
    const digits = String(form.get("Digits") || "").trim();
    const callSid = String(form.get("CallSid") || "").trim();
    const isFallback = url.searchParams.get("fallback") === "1";

    const tokenState = await decodeCallStateToken(tokenFromForm || tokenFromQuery, callSid);
    const state: TokenizedCallState =
      tokenState ||
      buildInitialState({
        callSid,
        company: url.searchParams.get("company") || "Ihr Unternehmen",
        contactName: url.searchParams.get("contactName") || "",
        topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
        leadId: url.searchParams.get("leadId") || undefined,
        ownerRealName: url.searchParams.get("ownerRealName") || undefined,
        ownerCompanyName: url.searchParams.get("ownerCompanyName") || undefined,
        userId: url.searchParams.get("userId") || undefined,
        phoneNumberId: url.searchParams.get("phoneNumberId") || undefined,
      });

    await syncScripts(baseUrl, state.userId);
    const activeScript = getTopicScript(state.topic, state.userId);
    const scriptOrigin = getScriptOrigin(state.topic, state.userId);
    const systemPrompt = buildCallSystemPrompt(activeScript);

    const heardText = speech || digits;

    if (state.callSid && state.company && state.topic && heardText.trim()) {
      void fetch(`${baseUrl}/api/calls/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: state.userId,
          phoneNumberId: state.phoneNumberId,
          callSid: state.callSid,
          leadId: state.leadId,
          company: state.company,
          contactName: state.contactName,
          topic: state.topic,
          summaryChunk: `[Script: ${scriptOrigin}]\nInteressent: ${heardText.trim()}`,
          attempts: 1,
        }),
        cache: "no-store",
      }).catch(() => {
        // Transcript chunk persistence is best-effort and must not delay call flow.
      });
    }

    // Bewusst KEIN deterministischer Fast-Reply auf Empfangs-Greeting mehr:
    // Gloria soll nicht abrupt "Könnten Sie mich bitte mit X verbinden?" sagen,
    // sondern sich kurz vorstellen, den Grund aus dem Playbook einordnen und
    // dann freundlich um Weiterleitung bitten. Der komplette Playbook-
    // Systemprompt (receptionTopicReason, gatekeeperTask, gatekeeperExample,
    // opener) liefert dem Modell dafür die passenden Leitplanken.

    if (!heardText || isFallback) {
      if (state.turn > 0 || state.roleState === "transfer") {
        return await respondWithListenOnly(baseUrl, {
          ...toStatePayload(state),
          turn: state.turn + 1,
          step: state.step,
          roleState: state.roleState,
          contactRole: state.contactRole,
        });
      }

      const introLine =
        state.turn === 0
          ? buildOwnerIntroLine(state)
          : "Ich bin noch dran. Nehmen Sie sich ruhig einen Moment und sprechen Sie in Ruhe weiter.";

      return await respondWithGather(baseUrl, introLine, {
        ...toStatePayload(state),
        turn: state.turn,
        step: state.step,
        transcript: trimTranscript(`${state.transcript}\nGloria: ${introLine}`),
      });
    }

    if (state.contactRole !== "decision-maker" && isLikelyTransferAcknowledgement(heardText)) {
      return await respondWithListenOnly(baseUrl, {
        ...toStatePayload(state),
        transcript: trimTranscript(`${state.transcript}\nInteressent: ${heardText}`),
        turn: state.turn + 1,
        step: "intro",
        contactRole: "gatekeeper",
        roleState: "transfer",
      });
    }

    let updatedConsent = state.consent;
    let consentAsked = state.consentAsked || hasGloriaAskedConsent(state.transcript);
    const consentAnswer = parseConsentAnswer(heardText);

    const lastGloria = state.transcript
      .split("\n")
      .reverse()
      .find((l) => l.startsWith("Gloria:"));

    const askedForContactBefore = Boolean(
      lastGloria &&
        /\b(verbinden|zust[aä]ndigen\s+person|sprech[e]?\s+ich\s+mit|mit\s+\w+)\b/i.test(lastGloria),
    );

    if (
      state.contactRole !== "decision-maker" &&
      askedForContactBefore &&
      isDecisionMakerAlreadyOnLine(heardText)
    ) {
      const openerSegments = splitByAnswerWaitMarker(activeScript.opener || "");
      const openerReply =
        openerSegments[0] ||
        "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an.";
      const updatedTranscript = trimTranscript(
        [
          state.transcript,
          "Phase: decision_maker",
          `Interessent: ${heardText}`,
          `Gloria: ${openerReply}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return await respondWithGather(baseUrl, openerReply, {
        ...toStatePayload(state),
        decisionMakerIntroDone: true,
        contactRole: "decision-maker",
        roleState: "decision_maker",
        transcript: updatedTranscript,
        turn: state.turn + 1,
        step: "conversation",
      });
    }

    if (lastGloria && /aufzeichn|aufnahme|mitschnitt/i.test(lastGloria)) {
      consentAsked = true;
      if (consentAnswer === "yes") {
        updatedConsent = "yes";
      } else if (consentAnswer === "no") {
        updatedConsent = "no";
      }
    }

    const inPkvPostAppointmentFlow =
      state.topic === "private Krankenversicherung" &&
      state.contactRole === "decision-maker" &&
      Boolean(state.appointmentAtDraft);

    if (inPkvPostAppointmentFlow) {
      const nextHealthQuestionIndex = state.healthQuestionIndex ?? 0;
      const healthIntroDone = Boolean(state.pkvHealthIntroDone);
      const pkvQuestions = getPkvHealthQuestions(activeScript);
      const pkvIntro = getPkvHealthIntro(activeScript);

      if (nextHealthQuestionIndex < pkvQuestions.length) {
        const question = pkvQuestions[nextHealthQuestionIndex];
        const prompt = healthIntroDone ? question : `${pkvIntro} ${question}`;
        const updatedTranscript = trimTranscript(
          [
            state.transcript,
            `Phase: ${state.roleState || "decision_maker"}`,
            `Interessent: ${heardText}`,
            `Gloria: ${prompt}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );

        return await respondWithGather(baseUrl, prompt, {
          ...toStatePayload(state),
          transcript: updatedTranscript,
          pkvHealthIntroDone: true,
          healthQuestionIndex: nextHealthQuestionIndex + 1,
          turn: state.turn + 1,
          step: "conversation",
        });
      }

      void finalizeCall({
        state: {
          ...state,
          transcript: trimTranscript(`${state.transcript}\nInteressent: ${heardText}`),
          turn: state.turn + 1,
          step: "finished",
        },
        outcome: "Termin",
        note: state.appointmentNoteDraft || "",
        appointmentAt: state.appointmentAtDraft,
        baseUrl,
      }).catch((error) => {
        log.error("finalize_call.failed", {
          event: "finalize_call",
          callSid: state.callSid,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

      return await respondWithHangup(
        baseUrl,
        "Vielen Dank für die Angaben. Der Termin ist fest eingeplant. Ich freue mich auf das Gespräch. Auf Wiederhören.",
      );
    }

    let decision: GloriaDecision;
    try {
      decision = await askOpenAI(
        systemPrompt,
        state.contactName,
        state.transcript,
        heardText,
        state.contactRole,
        state.step,
      );
    } catch {
      const contextualFallbackReply =
        state.contactRole !== "decision-maker"
          ? buildGatekeeperTransferLine(state.contactName)
          : `Danke. ${activeScript.discovery}`;

      decision = {
        detectedRole: "unknown",
        reply: contextualFallbackReply,
        action: "continue",
        appointmentNote: "",
        appointmentAtISO: "",
        directDial: "",
        consentGiven: null,
      };
    }

    let appointmentAt = normalizeAppointmentAt(decision.appointmentAtISO);
    let directDial =
      normalizeDirectDial(decision.directDial) ||
      extractDirectDialFromText(heardText) ||
      normalizeDirectDial(state.directDial);

    if (decision.consentGiven === true) {
      updatedConsent = "yes";
      consentAsked = true;
    }
    if (decision.consentGiven === false) {
      updatedConsent = "no";
      consentAsked = true;
    }

    const roleResolution = detectRoleState({
      currentRole: state.contactRole,
      modelDetectedRole: decision.detectedRole,
      heardText,
    });
    const newRole = roleResolution.contactRole;
    const newRoleState = roleResolution.roleState;
    let nextDecisionMakerIntroDone = state.decisionMakerIntroDone ?? false;
    let forceReply = false;

    if (
      state.roleState === "transfer" &&
      !nextDecisionMakerIntroDone &&
      !isLikelyDecisionMakerGreeting(heardText)
    ) {
      return await respondWithListenOnly(baseUrl, {
        ...toStatePayload(state),
        contactRole: "gatekeeper",
        roleState: "transfer",
        turn: state.turn + 1,
        step: "intro",
      });
    }

    if (newRole === "decision-maker" && !nextDecisionMakerIntroDone) {
      const openerSegments = splitByAnswerWaitMarker(activeScript.opener || "");
      const openerReply =
        openerSegments[0] ||
        "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an.";
      const updatedTranscript = trimTranscript(
        [
          state.transcript,
          `Phase: ${newRoleState}`,
          `Interessent: ${heardText}`,
          `Gloria: ${openerReply}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return await respondWithGather(baseUrl, openerReply, {
        ...toStatePayload(state),
        decisionMakerIntroDone: true,
        contactRole: newRole,
        roleState: newRoleState,
        transcript: updatedTranscript,
        turn: state.turn + 1,
        step: "conversation",
      });
    }

    if (newRole === "decision-maker" && !consentAsked) {
      const consentPrompt = getConsentPrompt(activeScript);
      const updatedTranscript = trimTranscript(
        [
          state.transcript,
          `Phase: ${newRoleState}`,
          `Interessent: ${heardText}`,
          `Gloria: ${consentPrompt}`,
        ]
          .filter(Boolean)
          .join("\n"),
      );

      return await respondWithGather(baseUrl, consentPrompt, {
        ...toStatePayload(state),
        decisionMakerIntroDone: true,
        consentAsked: true,
        contactRole: newRole,
        roleState: newRoleState,
        transcript: updatedTranscript,
        turn: state.turn + 1,
        step: "consent",
      });
    }

    if (newRole !== "decision-maker" && decision.action === "end_success") {
      decision.action = "continue";
      decision.reply = buildGatekeeperTransferLine(state.contactName);
      appointmentAt = undefined;
    }

    if (decision.action === "end_success" && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Sehr gern. Damit ich den Termin fest eintrage, brauche ich bitte ein genaues Datum mit Uhrzeit. Was passt Ihnen konkret?";
      forceReply = true;
    }

    const unavailableAtReception =
      newRole !== "decision-maker" &&
      /(nicht\s+da|nicht\s+verf[üu]gbar|nicht\s+erreichbar|im\s+termin|au[ßs]er\s+haus|heute\s+nicht|gerade\s+nicht|im\s+gespr[äa]ch)/i.test(
        heardText,
      );

    if (unavailableAtReception && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Danke für die Info. Wann erreiche ich Herrn oder Frau am besten erneut, bitte mit konkretem Datum und Uhrzeit?";
      forceReply = true;
    }

    if ((unavailableAtReception || decision.action === "end_callback") && !directDial) {
      decision.action = "continue";
      decision.reply =
        "Danke. Damit ich beim Rückruf direkt durchkomme: Wie lautet bitte die direkte Durchwahl oder Mobilnummer?";
      forceReply = true;
    }

    if (decision.action === "end_callback" && !appointmentAt) {
      decision.action = "continue";
      decision.reply =
        "Gern notiere ich die Wiedervorlage. Bitte nennen Sie mir ein konkretes Datum mit Uhrzeit für den Rückruf.";
      forceReply = true;
    }

    if (newRole !== "decision-maker" && isShortAffirmative(heardText) && !forceReply) {
      decision.action = "continue";
      decision.reply = buildGatekeeperTransferLine(state.contactName);
      appointmentAt = undefined;
      forceReply = true;
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

    const updatedTranscript = trimTranscript(
      [
        state.transcript,
        `Phase: ${newRoleState}`,
        `Interessent: ${heardText}`,
        `Gloria: ${decision.reply}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );

    if (decision.action !== "continue") {
      const outcome: ReportOutcome =
        decision.action === "end_success"
          ? "Termin"
          : decision.action === "end_callback"
            ? "Wiedervorlage"
            : "Absage";

      if (
        outcome === "Termin" &&
        state.topic === "private Krankenversicherung" &&
        updatedConsent === "yes" &&
        appointmentAt
      ) {
        const pkvQuestions = getPkvHealthQuestions(activeScript);
        const firstQuestion = pkvQuestions[0];
        const firstPrompt = firstQuestion
          ? `${getPkvHealthIntro(activeScript)} ${firstQuestion}`
          : getPkvHealthIntro(activeScript);
        const updatedTranscriptForHealth = trimTranscript(
          [
            state.transcript,
            `Phase: ${newRoleState}`,
            `Interessent: ${heardText}`,
            `Gloria: ${firstPrompt}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );

        return await respondWithGather(baseUrl, firstPrompt, {
          ...toStatePayload(state),
          contactRole: newRole,
          roleState: newRoleState,
          consent: updatedConsent,
          consentAsked,
          appointmentAtDraft: appointmentAt,
          appointmentNoteDraft: decision.appointmentNote,
          pkvHealthIntroDone: true,
          healthQuestionIndex: firstQuestion ? 1 : 0,
          transcript: updatedTranscriptForHealth,
          turn: state.turn + 1,
          step: "conversation",
        });
      }

      void finalizeCall({
        state: {
          ...state,
          directDial,
          consent: updatedConsent,
          consentAsked,
          contactRole: newRole,
          roleState: newRoleState,
          transcript: updatedTranscript,
          turn: state.turn + 1,
          step: nextStep,
        },
        outcome,
        note: decision.appointmentNote,
        appointmentAt: outcome === "Termin" ? appointmentAt : undefined,
        nextCallAt: outcome === "Wiedervorlage" ? appointmentAt : undefined,
        directDial,
        baseUrl,
      }).catch((error) => {
        log.error("finalize_call.failed", {
          event: "finalize_call",
          callSid: state.callSid,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return await respondWithHangup(baseUrl, decision.reply);
    }

    return await respondWithGather(baseUrl, decision.reply, {
      ...toStatePayload(state),
      directDial,
      consent: updatedConsent,
      consentAsked,
      contactRole: newRole,
      roleState: newRoleState,
      transcript: updatedTranscript,
      turn: state.turn + 1,
      step: nextStep,
    });
  } catch (error) {
    console.error("[gloria/process] Unhandled error:", error);
    return new NextResponse(
      buildSayHangupTwiml({
        sayText: "Entschuldigung, es ist ein technischer Fehler aufgetreten. Ich melde mich nochmals.",
      }),
      {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      },
    );
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
