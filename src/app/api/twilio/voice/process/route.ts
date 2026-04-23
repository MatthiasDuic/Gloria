import { NextResponse } from "next/server";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildCallSystemPrompt } from "@/lib/gloria";
import { getAppBaseUrl } from "@/lib/twilio";
import { buildGatherTwiml, buildSayHangupTwiml } from "@/lib/twiml";
import { buildSignedAudioUrl } from "@/lib/audio-url";
import { validateTwilioRequest } from "@/lib/twilio-signature";
import { log } from "@/lib/log";
import { buildInternalHeaders } from "@/lib/internal-auth";
import {
  normalizeContactName,
  normalizeDirectDial,
  extractDirectDialFromText,
} from "@/lib/phone-utils";
import { AI_CONFIG } from "@/lib/ai-config";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type RoleState,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, ScriptConfig, Topic } from "@/lib/types";
import { z } from "zod";

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

const GloriaDecisionSchema = z.object({
  detectedRole: z.enum(["gatekeeper", "decision-maker", "unknown"]).catch("unknown"),
  reply: z
    .string()
    .trim()
    .min(1)
    .catch("Entschuldigung, ich hatte kurz eine Verbindungsstörung. Ich bin wieder da."),
  action: z
    .enum(["continue", "end_success", "end_rejection", "end_callback"])
    .catch("continue"),
  appointmentNote: z.string().catch(""),
  appointmentAtISO: z
    .string()
    .transform((v) => v.trim())
    .catch(""),
  directDial: z
    .string()
    .transform((v) => v.trim())
    .catch(""),
  consentGiven: z.boolean().nullable().catch(null),
});

type GloriaDecision = z.infer<typeof GloriaDecisionSchema>;

const GLORIA_DECISION_FALLBACK: GloriaDecision = {
  detectedRole: "unknown",
  reply: "Entschuldigung, ich hatte kurz eine Verbindungsstörung. Ich bin wieder da.",
  action: "continue",
  appointmentNote: "",
  appointmentAtISO: "",
  directDial: "",
  consentGiven: null,
};

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

function normalizeForLoopCheck(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-zäöüß\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function computeJaccardSimilarity(a: string, b: string): number {
  const stopwords = new Set([
    "der","die","das","und","oder","aber","ist","sind","ein","eine","einen","einem","einer","eines",
    "zu","zum","zur","im","in","an","am","auf","mit","von","vom","bei","beim","für","über","unter",
    "sie","ich","wir","mir","sich","sein","seine","ihr","ihre","ihren","ihrem","ihres","es","den","dem",
    "ja","nein","nicht","so","auch","als","wie","was","wo","wer","welche","welcher","welches",
    "bitte","danke","gerne","ok","okay","mal","noch","schon","hier","jetzt","mal"
  ]);
  const tokensA = new Set(a.split(" ").filter((t) => t.length >= 4 && !stopwords.has(t)));
  const tokensB = new Set(b.split(" ").filter((t) => t.length >= 4 && !stopwords.has(t)));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const token of tokensA) if (tokensB.has(token)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Bestimmt anhand der allerersten Begrüßung des Gegenübers, ob wir direkt
 * mit dem Entscheider sprechen oder noch beim Empfang sind. Signal:
 * enthält die Begrüßung einen Namens-Token aus `contactName` (Nachname
 * >=3 Zeichen), ist der Entscheider wahrscheinlich dran. Sonst Empfang.
 */
function classifyInitialGreeting(params: {
  heardText: string;
  contactName?: string;
}): "decision-maker" | "gatekeeper" {
  const normalized = normalizeContactName(params.contactName) || "";
  if (!normalized) return "gatekeeper";

  const heardLower = params.heardText.toLowerCase();

  // "Sprechen Sie mit {Name}" / "{Name} am Apparat" / "Hier {Name}"
  const nameTokens = normalized
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[.,;:!?]/g, ""))
    .filter((t) => t.length >= 3 && !/^(herr|frau|dr|prof|dipl|ing)$/.test(t));

  if (nameTokens.length === 0) return "gatekeeper";

  const matchesName = nameTokens.some((token) =>
    new RegExp(`\\b${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i").test(heardLower),
  );

  if (matchesName) {
    return "decision-maker";
  }

  return "gatekeeper";
}

function getTopicReasonLine(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "es geht um eine kurze Einordnung zur betrieblichen Krankenversicherung und wie Betriebe damit Gesundheitsthemen greifbar entlasten";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "es geht um eine kurze Einordnung zur betrieblichen Altersvorsorge und wie Arbeitgeber damit langfristige Bindung aufbauen";
  }
  if (topic === "private Krankenversicherung") {
    return "es geht um eine kurze Einordnung zur privaten Krankenversicherung und typische Optimierungspotenziale";
  }
  return `es geht um eine kurze Einordnung zum Thema ${topic}`;
}

function getResponsibleRoleByTopic(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung" || topic === "betriebliche Altersvorsorge") {
    return "der zuständigen Person für Personal oder Benefits";
  }
  if (topic === "private Krankenversicherung") {
    return "der zuständigen Person";
  }
  return "der zuständigen Person";
}

function buildGatekeeperOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const transferTarget = name || getResponsibleRoleByTopic(state.topic);
  return `Guten Tag, ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich melde mich im Auftrag von Herrn Matthias Duic. Ich würde gerne mit ${transferTarget} verbunden werden.`;
}

function buildDecisionMakerOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const salutation = name ? `Guten Tag ${name}` : "Guten Tag";
  const topicReason = getTopicReasonLine(state.topic);
  return `${salutation}, ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich melde mich im Auftrag von Herrn Matthias Duic, ${topicReason}. Darf ich Ihnen dazu eine kurze Frage stellen?`;
}

function buildDecisionMakerDiscoveryQuestion(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "Danke. Wie ist das Thema betriebliche Krankenversicherung bei Ihnen aktuell aufgestellt?";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "Danke. Wie ist das Thema betriebliche Altersvorsorge bei Ihnen aktuell aufgestellt?";
  }
  if (topic === "private Krankenversicherung") {
    return "Danke. Wie ist Ihre aktuelle Situation in der privaten Krankenversicherung?";
  }
  return `Danke. Wie ist das Thema ${topic} bei Ihnen aktuell aufgestellt?`;
}

function buildDecisionMakerTransitionToAppointment(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "Danke, das ist ein guter Einblick. Genau an dem Punkt entsteht oft viel Potenzial bei Mitarbeiterbindung und weniger Fehlzeiten. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "Danke, das ist ein guter Einblick. Genau dort entsteht oft Potenzial bei Bindung und Arbeitgeberattraktivität. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "private Krankenversicherung") {
    return "Danke, das hilft sehr. Genau dort lassen sich häufig Beiträge und Leistungen sauber neu einordnen. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  return "Danke, das hilft sehr. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
}

function isGatekeeperReasonQuestion(text: string): boolean {
  return /\b(worum\s+geht\s+es|um\s+was\s+geht\s+es|worum\s+gehts|was\s+ist\s+der\s+grund|weshalb|warum\s+rufen\s+sie\s+an)\b/i.test(
    text,
  );
}

function isGatekeeperTargetPersonQuestion(text: string): boolean {
  return /\b(mit\s+wem|welche[rmn]?\s+person|welchen\s+ansprechpartner|wen\s+soll\s+ich\s+verbinden|wen\s+genau|welcher\s+kollege)\b/i.test(
    text,
  );
}

function isGatekeeperIdentityQuestion(text: string): boolean {
  return /\b(wer\s+sind\s+sie|wer\s+ist\s+da|mit\s+wem\s+spreche\s+ich|von\s+welcher\s+firma)\b/i.test(
    text,
  );
}

function buildGatekeeperObjectionReply(state: TokenizedCallState, heardText: string): string | null {
  const name = normalizeContactName(state.contactName);
  const transferTarget = name || getResponsibleRoleByTopic(state.topic);
  const topicReason = getTopicReasonLine(state.topic);

  if (isGatekeeperIdentityQuestion(heardText)) {
    return `Sehr gern: Ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic im Auftrag von Herrn Matthias Duic. Würden Sie mich bitte kurz mit ${transferTarget} verbinden?`;
  }

  if (isGatekeeperTargetPersonQuestion(heardText)) {
    return `Am besten mit ${transferTarget}. Vielen Dank, wenn Sie mich kurz durchstellen.`;
  }

  if (isGatekeeperReasonQuestion(heardText)) {
    return `Gern, in einem Satz: ${topicReason}. Ich würde das gern kurz direkt mit ${transferTarget} abstimmen. Würden Sie mich bitte verbinden?`;
  }

  return null;
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

    let parsed: unknown = {};
    try {
      parsed = JSON.parse(payload.choices?.[0]?.message?.content || "{}");
    } catch (error) {
      log.warn("openai.json_parse_failed", {
        event: "openai.chat_completions",
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const validation = GloriaDecisionSchema.safeParse(parsed);
    if (!validation.success) {
      log.warn("openai.schema_rejected", {
        event: "openai.chat_completions",
        reason: validation.error.message.slice(0, 200),
      });
      return GLORIA_DECISION_FALLBACK;
    }
    log.info("openai.decision", {
      event: "openai.chat_completions",
      step: currentStep,
      role: currentRole,
      action: validation.data.action,
      detectedRole: validation.data.detectedRole,
      reply: validation.data.reply?.slice(0, 400),
    });
    return validation.data;
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

    // --- Turn 0: Begrüßung des Gegenübers abwarten und klassifizieren ---
    // Gloria hat beim Annehmen noch nichts gesagt. Der/die Angerufene meldet
    // sich zuerst. Anhand dieser Begrüßung entscheiden wir deterministisch,
    // ob wir am Empfang sind (Weiterleitung erbitten) oder direkt den
    // Entscheider am Apparat haben (Name + Thema + Zeit-Einstieg).
    if (state.turn === 0 && heardText && !isFallback) {
      const detected = classifyInitialGreeting({
        heardText,
        contactName: state.contactName,
      });
      log.info("voice.initial_greeting_classified", {
        callSid: state.callSid,
        heardText,
        detectedRole: detected,
      });

      if (detected === "decision-maker") {
        const openerLine = buildDecisionMakerOpenerLine(state);
        return await respondWithGather(baseUrl, openerLine, {
          ...toStatePayload(state),
          turn: state.turn + 1,
          step: "intro",
          contactRole: "decision-maker",
          roleState: "decision_maker",
          decisionMakerIntroDone: true,
          transcript: trimTranscript(
            `Interessent: ${heardText}\nGloria: ${openerLine}`,
          ),
        });
      }

      const openerLine = buildGatekeeperOpenerLine(state);
      return await respondWithGather(baseUrl, openerLine, {
        ...toStatePayload(state),
        turn: state.turn + 1,
        step: "intro",
        contactRole: "gatekeeper",
        roleState: "reception",
        transcript: trimTranscript(
          `Interessent: ${heardText}\nGloria: ${openerLine}`,
        ),
      });
    }

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

      // Turn 0 ohne verständliche Begrüßung (Timeout/leeres SpeechResult):
      // Safety-Net – Gloria initiiert mit dem Gatekeeper-Opener, damit auf
      // jeden Fall etwas Sinnvolles gesprochen wird.
      const introLine = buildGatekeeperOpenerLine(state);

      return await respondWithGather(baseUrl, introLine, {
        ...toStatePayload(state),
        turn: state.turn + 1,
        step: "intro",
        contactRole: "gatekeeper",
        roleState: "reception",
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

    // Kurze Bejahung ("Ja", "Gerne", "Moment") am Empfang, nachdem Gloria
    // gerade um Weiterleitung gebeten hat → listen-only abwarten, damit
    // Gloria nicht erneut ihre Vorstellung abspult.
    {
      const prevGloria = state.transcript
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("Gloria:"));
      const justAskedTransfer = Boolean(
        prevGloria &&
          /\b(verbinden|zust[aä]ndigen\s+person|sprech[e]?\s+ich\s+mit)\b/i.test(prevGloria),
      );
      if (
        state.contactRole !== "decision-maker" &&
        justAskedTransfer &&
        isShortAffirmative(heardText) &&
        !isDecisionMakerAlreadyOnLine(heardText)
      ) {
        return await respondWithListenOnly(baseUrl, {
          ...toStatePayload(state),
          transcript: trimTranscript(`${state.transcript}\nInteressent: ${heardText}`),
          turn: state.turn + 1,
          step: "intro",
          contactRole: "gatekeeper",
          roleState: "transfer",
        });
      }
    }

    if (state.contactRole !== "decision-maker") {
      const gatekeeperReply = buildGatekeeperObjectionReply(state, heardText);
      if (gatekeeperReply) {
        return await respondWithGather(baseUrl, gatekeeperReply, {
          ...toStatePayload(state),
          transcript: trimTranscript(
            `${state.transcript}\nInteressent: ${heardText}\nGloria: ${gatekeeperReply}`,
          ),
          turn: state.turn + 1,
          step: "intro",
          contactRole: "gatekeeper",
          roleState: state.roleState === "transfer" ? "transfer" : "reception",
        });
      }
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

    // Direkter Consent-Übergang beim Entscheider: Sobald ein klares "Ja"
    // auf die Aufzeichnungsfrage kommt, starten wir deterministisch mit der
    // kurzen Discovery-Frage statt in eine lange LLM-Formulierung zu laufen.
    if (
      state.contactRole === "decision-maker" &&
      consentAnswer === "yes" &&
      updatedConsent === "yes" &&
      (state.scriptPhaseIndex ?? 0) === 0
    ) {
      const discoveryQuestion = buildDecisionMakerDiscoveryQuestion(state.topic);
      return await respondWithGather(baseUrl, discoveryQuestion, {
        ...toStatePayload(state),
        transcript: trimTranscript(
          `${state.transcript}\nInteressent: ${heardText}\nGloria: ${discoveryQuestion}`,
        ),
        turn: state.turn + 1,
        step: "conversation",
        consent: "yes",
        consentAsked: true,
        scriptPhaseIndex: 1,
      });
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

    // Strukturierter Entscheider-Flow nach Consent:
    // Phase 0 -> 1: kurze themenspezifische Discovery-Frage
    // Phase 1 -> 2: kurze Einordnung + klare Terminfrage
    if (
      state.contactRole === "decision-maker" &&
      updatedConsent === "yes" &&
      (state.scriptPhaseIndex ?? 0) === 0
    ) {
      const discoveryQuestion = buildDecisionMakerDiscoveryQuestion(state.topic);
      return await respondWithGather(baseUrl, discoveryQuestion, {
        ...toStatePayload(state),
        transcript: trimTranscript(
          `${state.transcript}\nInteressent: ${heardText}\nGloria: ${discoveryQuestion}`,
        ),
        turn: state.turn + 1,
        step: "conversation",
        scriptPhaseIndex: 1,
      });
    }

    if (
      state.contactRole === "decision-maker" &&
      updatedConsent === "yes" &&
      (state.scriptPhaseIndex ?? 0) === 1 &&
      !(state.appointmentProposalAsked ?? false)
    ) {
      const transition = buildDecisionMakerTransitionToAppointment(state.topic);
      return await respondWithGather(baseUrl, transition, {
        ...toStatePayload(state),
        transcript: trimTranscript(
          `${state.transcript}\nInteressent: ${heardText}\nGloria: ${transition}`,
        ),
        turn: state.turn + 1,
        step: "appointment",
        scriptPhaseIndex: 2,
        appointmentProposalAsked: true,
      });
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
    let nextAppointmentProposalAsked = state.appointmentProposalAsked ?? false;
    let forceReply = false;
    let forcedStep: TokenizedCallState["step"] | undefined;

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

    // Hinweis: Früher gab es hier einen deterministischen Override, der bei
    // kurzen bejahenden Antworten der Rezeption ("Ja bitte?") Glorias
    // LLM-Antwort durch eine starre "Könnten Sie mich bitte mit X verbinden"-
    // Zeile ersetzt hat. Das lief schon direkt nach der Begrüßung und hat den
    // Playbook-Flow komplett ausgehöhlt. Jetzt vertrauen wir ausschließlich
    // der LLM-Antwort.

    // Discovery-Loop-Schutz: Wenn Gloria beim Entscheider fast die gleiche
    // Frage zum zweiten Mal stellt, zwingen wir sie in den Terminvorschlag.
    if (
      newRole === "decision-maker" &&
      decision.action === "continue" &&
      !appointmentAt &&
      !nextAppointmentProposalAsked
    ) {
      const lastGloriaLines = state.transcript
        .split("\n")
        .filter((line) => line.startsWith("Gloria:"))
        .slice(-3);
      const newReplyNorm = normalizeForLoopCheck(decision.reply);
      const isRepeat = lastGloriaLines.some((line) => {
        const prev = normalizeForLoopCheck(line.replace(/^Gloria:\s*/i, ""));
        if (!prev || !newReplyNorm) return false;
        return computeJaccardSimilarity(prev, newReplyNorm) >= 0.55;
      });
      if (isRepeat) {
        log.info("voice.loop_guard_triggered", {
          callSid: state.callSid,
          originalReply: decision.reply.slice(0, 200),
        });
        decision.reply =
          "Ich merke, wir drehen uns ein bisschen im Kreis. Lassen Sie uns das lieber in Ruhe in einem kurzen Termin besprechen. Passt Ihnen kommende Woche eher vormittags oder nachmittags?";
        nextAppointmentProposalAsked = true;
        forcedStep = "appointment";
        forceReply = true;
      }
    }

    const nextStep: TokenizedCallState["step"] =
      forcedStep ||
      (decision.action !== "continue"
        ? "finished"
        : newRole !== "decision-maker"
          ? "intro"
          : !consentAsked
            ? "consent"
            : appointmentAt
              ? "appointment"
              : "conversation");

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
      appointmentProposalAsked: nextAppointmentProposalAsked,
      scriptPhaseIndex: state.scriptPhaseIndex,
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
