import { NextResponse } from "next/server";
import twilio from "twilio";
import {
  BAV_TERMINIERUNG_SCRIPT,
  BKV_TERMINIERUNG_SCRIPT,
  ENERGIE_TERMINIERUNG_SCRIPT,
  GEWERBE_TERMINIERUNG_SCRIPT,
  PKV_TERMINIERUNG_SCRIPT,
} from "@/lib/call-scripts";
import type { CallScript } from "@/lib/call-scripts";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { generateAdaptiveReply } from "@/lib/live-agent";
import { sendReportEmail } from "@/lib/mailer";
import { REQUIRED_GLORIA_INTRO } from "@/lib/gloria";
import { appendConversationEvent, getDashboardData, storeCallReport } from "@/lib/storage";
import {
  getAppBaseUrl,
  getTwilioConversationMode,
  getTwilioMediaStreamUrl,
} from "@/lib/twilio";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, ScriptConfig, Topic } from "@/lib/types";

export const runtime = "nodejs";

const DETAIL_SCRIPTS: Record<Topic, CallScript> = {
  "betriebliche Krankenversicherung": BKV_TERMINIERUNG_SCRIPT,
  "betriebliche Altersvorsorge": BAV_TERMINIERUNG_SCRIPT,
  "gewerbliche Versicherungen": GEWERBE_TERMINIERUNG_SCRIPT,
  "private Krankenversicherung": PKV_TERMINIERUNG_SCRIPT,
  Energie: ENERGIE_TERMINIERUNG_SCRIPT,
};

function resolveCallScript(topic: Topic, saved?: ScriptConfig): CallScript {
  const base = DETAIL_SCRIPTS[topic];
  if (!saved) return base;

  const needsQuestions = saved.needsQuestions
    ? saved.needsQuestions.split("\n").map((q) => q.trim()).filter(Boolean)
    : base.needs.questions;

  const objections = saved.objectionsText
    ? Object.fromEntries(
        saved.objectionsText
          .split("\n")
          .filter((l) => l.includes(":"))
          .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])
      )
    : base.objections;

  const dataCollectionFields = saved.dataCollectionFields
    ? saved.dataCollectionFields.split("\n").map((f) => f.trim()).filter(Boolean)
    : base.dataCollection.fields;

  return {
    ...base,
    reception: {
      ...base.reception,
      ...(saved.receptionIntro ? { intro: saved.receptionIntro } : {}),
      ...(saved.receptionIfAskedWhatTopic ? { ifAskedWhatTopic: saved.receptionIfAskedWhatTopic } : {}),
      ...(saved.receptionIfEmailSuggested ? { ifEmailSuggested: saved.receptionIfEmailSuggested } : {}),
      ...(saved.receptionIfEmailInsisted ? { ifEmailInsisted: saved.receptionIfEmailInsisted } : {}),
    },
    intro: {
      ...base.intro,
      ...(saved.decisionMakerIntro ? { text: saved.decisionMakerIntro } : {}),
    },
    needs: {
      ...base.needs,
      questions: needsQuestions,
      ...(saved.needsReinforcement ? { reinforcement: saved.needsReinforcement } : {}),
    },
    problem: {
      ...base.problem,
      ...(saved.problemText ? { text: saved.problemText } : {}),
    },
    concept: {
      ...base.concept,
      ...(saved.conceptText ? { text: saved.conceptText } : {}),
    },
    pressure: {
      ...base.pressure,
      ...(saved.pressureText ? { text: saved.pressureText } : {}),
    },
    close: {
      ...base.close,
      ...(saved.closeMain ? { main: saved.closeMain } : {}),
      ...(saved.closeIfNoTime ? { ifNoTime: saved.closeIfNoTime } : {}),
      ...(saved.closeIfAskWhatExactly ? { ifAskWhatExactly: saved.closeIfAskWhatExactly } : {}),
    },
    objections,
    dataCollection: {
      ...base.dataCollection,
      ...(saved.dataCollectionIntro ? { intro: saved.dataCollectionIntro } : {}),
      fields: dataCollectionFields,
      ...(saved.dataCollectionIfDetailsDeclined ? { ifDetailsDeclined: saved.dataCollectionIfDetailsDeclined } : {}),
      ...(saved.dataCollectionClosing ? { closing: saved.dataCollectionClosing } : {}),
    },
    final: {
      text: saved.finalText || base.final.text,
    },
  };
}

const MAX_LIVE_TURNS = 5;
const MAX_SILENT_RETRIES = 2;

function buildAgentIntroduction() {
  return REQUIRED_GLORIA_INTRO;
}

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readContext(request: Request) {
  const url = new URL(request.url);
  const contactName = url.searchParams.get("contactName") || undefined;
  const contactRoleParam = url.searchParams.get("contactRole");

  return {
    callSid: url.searchParams.get("callSid") || undefined,
    step: url.searchParams.get("step") || "intro",
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Unbekanntes Unternehmen",
    contactName,
    topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
    consent: url.searchParams.get("consent") || "no",
    turn: Number(url.searchParams.get("turn") || "0"),
    transcript: url.searchParams.get("transcript") || "",
    contactRole:
      contactRoleParam === "decision-maker"
        ? "decision-maker"
        : contactName
          ? "gatekeeper"
          : "decision-maker",
  } as const;
}

function mergeContextWithToken(
  baseContext: ReturnType<typeof readContext>,
  tokenState?: TokenizedCallState,
) {
  if (!tokenState) {
    return baseContext;
  }

  return {
    ...baseContext,
    callSid: tokenState.callSid || baseContext.callSid,
    leadId: tokenState.leadId || baseContext.leadId,
    company: tokenState.company || baseContext.company,
    contactName: tokenState.contactName || baseContext.contactName,
    topic: tokenState.topic || baseContext.topic,
    step: tokenState.step || baseContext.step,
    consent: tokenState.consent || baseContext.consent,
    turn: Number.isFinite(tokenState.turn) ? tokenState.turn : baseContext.turn,
    transcript: tokenState.transcript || baseContext.transcript,
    contactRole: tokenState.contactRole || baseContext.contactRole,
  } as const;
}

function buildTopicIntro(topic: Topic) {
  if (topic === "betriebliche Altersvorsorge") {
    return "Es geht um einen kurzen Abgleich, wie sich die betriebliche Altersvorsorge für Mitarbeitende verständlich und attraktiv aufstellen lässt.";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Es geht um einen kurzen Vergleich Ihrer gewerblichen Absicherung auf Preis, Leistung und mögliche Lücken.";
  }

  if (topic === "private Krankenversicherung") {
    return "Es geht um eine ruhige Einordnung, wie sich Krankenversicherungsbeiträge im Alter besser planen lassen.";
  }

  if (topic === "Energie") {
    return "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich mit möglichem Einsparpotenzial.";
  }

  return "Es geht um die betriebliche Krankenversicherung als attraktiven Benefit für Mitarbeitende.";
}

function cleanScriptText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeGloriaBranding(value: string) {
  return value
    .replaceAll("digitale Assistentin der Agentur Duic in Sprockhövel", "digitale Vertriebsassistentin der Agentur Duic Sprockhövel")
    .replaceAll("digitale Vertriebsassistentin der Agentur Duic in Sprockhövel", "digitale Vertriebsassistentin der Agentur Duic Sprockhövel")
    .replaceAll("digitale Vertriebsassistentin der Agentur Duic", "digitale Vertriebsassistentin der Agentur Duic Sprockhövel")
    .replaceAll("Gloria – die digitale", "Gloria, die digitale");
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fillNameTemplate(value: string, contactName?: string) {
  const fallbackName = contactName?.trim() || "der zuständigen Person";

  return normalizeGloriaBranding(cleanScriptText(value))
    .replaceAll("Frau/Herrn [NAME]", fallbackName)
    .replaceAll("Frau/Herr [NAME]", fallbackName)
    .replaceAll("Herr/Frau [NAME]", fallbackName)
    .replaceAll("[NAME]", fallbackName);
}

function looksLikePersonName(contactName?: string) {
  if (!contactName?.trim()) {
    return false;
  }

  const normalized = normalizeName(contactName);

  // Company-style names should not trigger direct decision-maker matching.
  if (/(gmbh|mbh|ag|kg|ug|gbr|ohg|ek|e k|ltd|inc|llc|holding|group|gruppe|service|solutions)/.test(normalized)) {
    return false;
  }

  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }

  // Typical person pattern: title + surname or first + last name.
  const hasTitle = /(^|\s)(herr|frau)(\s|$)/.test(normalized);
  const filtered = parts.filter((part) => !["herr", "frau"].includes(part));

  return hasTitle ? filtered.length >= 1 : filtered.length >= 2;
}

function mentionsTargetName(text: string, contactName?: string) {
  if (!contactName?.trim() || !looksLikePersonName(contactName)) {
    return false;
  }

  const normalizedText = normalizeName(text);
  const nameParts = normalizeName(contactName)
    .split(" ")
    .filter((part) => part.length > 2 && part !== "herr" && part !== "frau");

  return nameParts.some((part) => normalizedText.includes(part));
}

function mentionsDifferentNamedPerson(text: string, contactName?: string) {
  if (!contactName?.trim() || mentionsTargetName(text, contactName)) {
    return false;
  }

  const normalizedText = normalizeName(text);
  return /(^|\s)(herr|frau)\s+[a-z0-9]+|[a-z0-9]+\s+am apparat|[a-z0-9]+\s+guten tag/.test(
    normalizedText,
  );
}

function buildReceptionPrompt(
  callScript: CallScript,
  contactName?: string,
  variant: "intro" | "what" | "email" | "email-insist" = "intro",
) {
  const script = callScript;

  if (variant === "what") {
    return fillNameTemplate(
      script.reception.ifAskedWhatTopic || script.reception.alternativeShort || script.reception.intro,
      contactName,
    );
  }

  if (variant === "email") {
    return fillNameTemplate(
      script.reception.ifEmailSuggested || script.reception.alternativeShort || script.reception.intro,
      contactName,
    );
  }

  if (variant === "email-insist") {
    return fillNameTemplate(
      script.reception.ifEmailInsisted || script.reception.ifEmailSuggested || script.reception.intro,
      contactName,
    );
  }

  return fillNameTemplate(script.reception.intro, contactName);
}

function buildDecisionMakerHello(contactName?: string) {
  if (contactName?.trim()) {
    return `${buildAgentIntroduction()} Spreche ich direkt mit ${contactName}?`;
  }

  return `${buildAgentIntroduction()} Spreche ich direkt mit der zuständigen Person?`;
}

function buildDecisionMakerPrompt(topic: Topic, contactName?: string) {
  if (contactName?.trim()) {
    return buildDecisionMakerHello(contactName);
  }

  return `${buildAgentIntroduction()} ${buildTopicIntro(topic)} Sind Sie dafür die richtige Ansprechperson?`;
}

function buildConsentPrompt(contactName?: string, script?: ScriptConfig) {
  const customPrompt = script?.consentPrompt?.trim();
  if (customPrompt) {
    return fillNameTemplate(customPrompt, contactName);
  }

  const intro = buildAgentIntroduction();
  const directAddress = contactName?.trim() ? ` ${contactName},` : "";
  return `${intro}${directAddress} Ich rufe im Auftrag von Herrn Matthias Duic an. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?`;
}

function nextBusinessDay(date: Date, offsetDays = 0) {
  const next = new Date(date);
  next.setDate(next.getDate() + offsetDays);

  while (next.getDay() === 0 || next.getDay() === 6) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

function buildAppointmentOptions() {
  const first = nextBusinessDay(new Date(), 1);
  first.setHours(10, 0, 0, 0);

  const second = nextBusinessDay(first, 2);
  second.setHours(15, 0, 0, 0);

  return [first, second] as const;
}

function formatAppointmentLabel(value: Date) {
  const datePart = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  }).format(value);
  const timePart = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);

  return `${datePart} um ${timePart} Uhr`;
}

function buildAppointmentOffer(script?: ScriptConfig) {
  const customOffer = script?.appointmentOffer?.trim();
  if (customOffer) {
    return customOffer;
  }

  const [first, second] = buildAppointmentOptions();
  return `Sehr gut. Für den kurzen Austausch mit Herrn Duic kann ich Ihnen ${formatAppointmentLabel(first)} oder ${formatAppointmentLabel(second)} anbieten. Welcher Termin passt Ihnen besser?`;
}

function resolveAppointmentSelection(speech: string) {
  const [first, second] = buildAppointmentOptions();
  const normalized = normalizeName(speech);
  const firstWeekday = normalizeName(formatAppointmentLabel(first).split(" um")[0] || "");
  const secondWeekday = normalizeName(formatAppointmentLabel(second).split(" um")[0] || "");

  if (
    /erste|zuerst|fruher|früh|vormittag|10|zehn|morgen/.test(normalized) ||
    normalized.includes(firstWeekday)
  ) {
    return first;
  }

  if (
    /zweite|spater|später|nachmittag|15|fünfzehn|funfzehn/.test(normalized) ||
    normalized.includes(secondWeekday)
  ) {
    return second;
  }

  if (/ja|passt|gerne|einverstanden|okay|ok|machen wir/.test(normalized)) {
    return first;
  }

  return undefined;
}

function buildAppointmentConfirmation(appointmentAt: Date, script?: ScriptConfig) {
  const customConfirm = script?.appointmentConfirmation?.trim();
  if (customConfirm) {
    const slotLabel = formatAppointmentLabel(appointmentAt);
    if (customConfirm.includes("{{termin}}")) {
      return customConfirm.replace("{{termin}}", slotLabel);
    }
    return `${customConfirm} (${slotLabel})`;
  }

  return `Vielen Dank. Dann habe ich den Termin für ${formatAppointmentLabel(appointmentAt)} mit Herrn Duic notiert. Die Bestätigung erhalten Sie im Anschluss. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.`;
}

const PKV_HEALTH_QUESTIONS = [
  "Wie ist Ihr aktueller Versicherungsstatus, gesetzlich oder privat?",
  "Bei welchem Versicherer sind Sie derzeit versichert?",
  "Nehmen Sie aktuell regelmäßig Medikamente?",
  "Gibt es bestehende Erkrankungen, die wir für die Vorbereitung berücksichtigen sollten?",
  "Gab es in den letzten zehn Jahren Krankenhausaufenthalte oder psychische Behandlungen?",
];

function detectYesNoIntent(text: string) {
  if (/(^|\b)(ja|gern|gerne|okay|ok|einverstanden|passt|natürlich)(\b|$)/.test(text)) {
    return "yes" as const;
  }

  if (/(^|\b)(nein|lieber nicht|mochte ich nicht|möchte ich nicht|ohne daten|ohne datenangaben)(\b|$)/.test(text)) {
    return "no" as const;
  }

  return undefined;
}

function detectDayPart(text: string) {
  if (/vormittag|fruh|früh|morgens/.test(text)) {
    return "vormittag" as const;
  }

  if (/nachmittag|spater|später|mittags|ab 14|ab 15/.test(text)) {
    return "nachmittag" as const;
  }

  return undefined;
}

const WEEKDAY_LABELS = [
  "sonntag",
  "montag",
  "dienstag",
  "mittwoch",
  "donnerstag",
  "freitag",
  "samstag",
] as const;

function detectWeekday(text: string) {
  const normalized = normalizeName(text);
  return WEEKDAY_LABELS.find((weekday) => normalized.includes(weekday));
}

function buildNextWeekSlot(weekday: (typeof WEEKDAY_LABELS)[number], dayPart: "vormittag" | "nachmittag") {
  const today = new Date();
  const target = new Date(today);
  const targetIndex = WEEKDAY_LABELS.indexOf(weekday);

  let dayDiff = (targetIndex - target.getDay() + 7) % 7;
  if (dayDiff === 0) {
    dayDiff = 7;
  }

  target.setDate(target.getDate() + dayDiff);
  target.setHours(dayPart === "vormittag" ? 10 : 15, 0, 0, 0);
  return target;
}

function readTranscriptMarker(transcript: string, key: string) {
  const markerRegex = new RegExp(`${key}:\\s*([^\\n]+)`, "i");
  const match = transcript.match(markerRegex);
  return match?.[1]?.trim();
}

function buildDecisionMakerGreeting(topic: Topic, contactName?: string, script?: ScriptConfig) {
  const customGreeting = script?.decisionMakerGreeting?.trim();
  if (customGreeting) {
    return customGreeting;
  }

  const warmIntro = contactName?.trim()
    ? `Vielen Dank, ${contactName}.`
    : "Vielen Dank.";

  return `${warmIntro} Dann steigen wir direkt ein. Soll ich Ihnen kurz sagen, worum es geht?`;
}

function buildTopicExplanationPrompt(topic: Topic, script?: ScriptConfig) {
  const customExplanation = script?.topicExplanation?.trim();
  if (customExplanation) {
    return customExplanation;
  }

  if (topic === "betriebliche Altersvorsorge") {
    return "Es geht um die Frage, wie sich die betriebliche Altersvorsorge für Mitarbeitende verständlich und attraktiver aufstellen lässt.";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Es geht um einen kurzen Abgleich, ob Ihre gewerblichen Versicherungen in Preis und Leistung noch sauber zu Ihrem aktuellen Risiko passen.";
  }

  if (topic === "private Krankenversicherung") {
    return "Es geht um ein Konzept, mit dem sich Krankenversicherungsbeiträge im Alter deutlich planbarer und stabiler aufstellen lassen.";
  }

  if (topic === "Energie") {
    return "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich, um mögliche Einsparpotenziale und bessere Konditionen sichtbar zu machen.";
  }

  return "Es geht darum, wie Unternehmen mit der betrieblichen Krankenversicherung Mitarbeiterbindung und Arbeitgeberattraktivität spürbar stärken können.";
}

function buildTopicDiscoveryPrompt(callScript: CallScript) {
  return cleanScriptText(callScript.needs.questions[0] || callScript.problem.text);
}

function buildPreparationConsentPrompt(topic: Topic, script?: ScriptConfig) {
  const customConsent = script?.preparationConsent?.trim();
  if (customConsent) {
    return customConsent;
  }

  if (topic === "private Krankenversicherung") {
    return "Um den Termin perfekt vorzubereiten, benötige ich noch ein paar Gesundheitsangaben. Ist das für Sie in Ordnung?";
  }

  return "Um den Termin perfekt vorzubereiten, benötige ich noch zwei kurze Angaben. Ist das für Sie in Ordnung?";
}

function buildPreparationQuestions(callScript: CallScript) {
  if (callScript.id.startsWith("pkv")) {
    return PKV_HEALTH_QUESTIONS;
  }

  const fields = callScript.dataCollection.fields.slice(0, 2);

  if (!fields.length) {
    return ["Worauf sollen wir im Termin besonders achten?"];
  }

  return fields.map((field) => `Kurze Frage zur Vorbereitung: ${field}?`);
}

function soundsLikeYes(text: string) {
  return /(^|\b)(ja|ja gern|ja gerne|gern|gerne|interessant|klingt gut|passt|einverstanden|okay|ok|machen wir)(\b|$)/.test(
    normalizeName(text),
  );
}

function soundsLikeNo(text: string) {
  return /(^|\b)(nein|nicht interessant|kein interesse|eher nicht|lieber nicht|kein bedarf)(\b|$)/.test(
    normalizeName(text),
  );
}

function buildProblemBenefitConfirmation(topic: Topic, script?: ScriptConfig) {
  const customConfirmation = script?.problemBenefitConfirmation?.trim();
  if (customConfirmation) {
    return customConfirmation;
  }

  if (topic === "private Krankenversicherung") {
    return "Verstehe, das geht vielen Unternehmern so. Jetzt stellen Sie sich einmal vor: Sie und Herr Duic sitzen zusammen und Herr Duic zeigt Ihnen schwarz auf weiß, wie sich die Beiträge nach heutigem Stand entwickeln und wie Sie von unserem Konzept profitieren. Wäre das für Sie interessant?";
  }

  if (topic === "betriebliche Krankenversicherung") {
    return "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich kurz vor, Herr Duic zeigt Ihnen schwarz auf weiß, wie Sie Mitarbeiterbindung und Gesundheitsleistungen mit einem klaren, kalkulierbaren Modell verbessern können. Wäre das für Sie interessant?";
  }

  if (topic === "betriebliche Altersvorsorge") {
    return "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, wie sich Ihre bAV für Mitarbeitende verständlicher und attraktiver aufstellen lässt. Wäre das für Sie interessant?";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, wo bei Ihren Policen Leistung, Preis und mögliche Lücken wirklich stehen. Wäre das für Sie interessant?";
  }

  return "Verstehe, das geht vielen Unternehmern so. Stellen Sie sich vor, Herr Duic zeigt Ihnen schwarz auf weiß, welche Einsparungen und Konditionen aktuell für Ihr Unternehmen realistisch sind. Wäre das für Sie interessant?";
}

function soundsLikeTransfer(text: string) {
  return /ich verbinde|verbinde sie|stelle.*durch|einen moment|augenblick|ich hole|bleiben sie dran|ich leite.*weiter/.test(text);
}

function soundsLikeNotDecisionMaker(text: string) {
  return /nicht zuständig|bin ich nicht|dafür ist .* zuständig|sekretariat|empfang|zentrale|assistenz|büro|nicht da|außer haus|weiterleiten/.test(text);
}

function soundsLikeDecisionMaker(text: string) {
  return /ich bin zuständig|das bin ich|ja,? ich bin|da sprechen sie richtig|das passt|ich kümmere mich|dafür bin ich zuständig|spreche selbst/.test(text);
}

function soundsLikeSelfIdentification(text: string) {
  return /hier spricht|mein name ist|sie sprechen mit|am apparat ist|am telefon ist/.test(text);
}

function soundsLikeCompanyReception(text: string) {
  return /(gmbh|ag|kg|ug|holding|gruppe|zentrale|empfang|sekretariat|büro|firma)\b/.test(text);
}

function soundsLikeSwitchboardHandOff(text: string) {
  return /am apparat|ist dran|habe .* dran|einen moment .* herr|einen moment .* frau|ich stelle .* durch/.test(
    text,
  );
}

function isLikelyGreeting(text: string) {
  if (soundsLikeDecisionMaker(text) || soundsLikeNotDecisionMaker(text) || soundsLikeTransfer(text)) {
    return false;
  }

  if (soundsLikeCompanyReception(text)) {
    return false;
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3 || /hallo|guten tag|ja bitte|wer ist da|moin/.test(text);
}

function detectConsent(speech: string, digits: string) {
  if (digits === "1") {
    return true;
  }

  if (digits === "2") {
    return false;
  }

  if (/(^|\b)(ja|gern|gerne|okay|in ordnung|einverstanden)(\b|$)/.test(speech)) {
    return true;
  }

  if (/(^|\b)(nein|nicht|keine aufzeichnung|ohne aufzeichnung)(\b|$)/.test(speech)) {
    return false;
  }

  return null;
}

function isCallbackRequest(speech: string) {
  return /(später|andermal|nächste woche|rückruf|rufen sie wieder an|kein[e]? zeit|im moment schlecht|gerade schlecht|heute nicht|morgen|bitte später|nochmal anrufen)/.test(
    speech,
  );
}

function isAppointmentAcceptance(
  speech: string,
  stage: "discovery" | "problem" | "benefit" | "objection" | "closing" = "discovery",
) {
  if (/termin|machen wir|passt .*vormittag|passt .*nachmittag|einverstanden mit termin|gerne termin/.test(speech)) {
    return true;
  }

  if (
    stage === "closing" &&
    /(^|\b)(ja|ja gern|ja gerne|gern|gerne|okay|ok|einverstanden|passt|passt gut|ja passt|machen wir)(\b|$)/.test(
      speech.trim(),
    )
  ) {
    return true;
  }

  return false;
}

function classifyOutcome(
  speech: string,
  stage: "discovery" | "problem" | "benefit" | "objection" | "closing" = "discovery",
): ReportOutcome {
  if (/(kein interesse|nicht interessant|bitte nicht|nein danke|keinen bedarf|kein bedarf)/.test(speech)) {
    return "Absage";
  }

  if (isCallbackRequest(speech)) {
    return "Wiedervorlage";
  }

  if (isAppointmentAcceptance(speech, stage)) {
    return "Termin";
  }

  return "Kein Kontakt";
}

function buildFollowUpDate(speech: string, outcome: ReportOutcome) {
  const now = new Date();
  const result = new Date(now);
  const wantsNextWeek = /nächste woche/.test(speech);
  result.setDate(now.getDate() + (wantsNextWeek ? 7 : 2));
  result.setHours(
    outcome === "Termin" ? (/nachmittag|14|15|16/.test(speech) ? 14 : 10) : 11,
    0,
    0,
    0,
  );
  return result.toISOString();
}

function buildAudioUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const url = new URL("/api/twilio/audio", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function buildProcessUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const url = new URL("/api/twilio/voice/process", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function trimTranscript(value: string, maxLength = 1200) {
  const normalized = value.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxLength);
}

function respondWithGather(options: {
  response: twilio.twiml.VoiceResponse;
  baseUrl: string;
  promptText: string;
  audioParams?: Record<string, string | undefined>;
  context: ReturnType<typeof readContext>;
  consent: "yes" | "no";
  turn: number;
  transcript: string;
  lowLatency?: boolean;
  step?: "intro" | "consent" | "conversation" | "appointment";
  contactRole?: ContactRole;
  callSid?: string;
}) {
  const nextStep = options.step || "conversation";
  const nextRole = options.contactRole || options.context.contactRole;
  const nextTranscript = trimTranscript(options.transcript);
  const nextCallSid = options.callSid || options.context.callSid;
  const stateToken = encodeCallStateToken({
    callSid: nextCallSid,
    leadId: options.context.leadId,
    company: options.context.company,
    contactName: options.context.contactName,
    topic: options.context.topic,
    step: nextStep,
    consent: options.consent,
    turn: options.turn,
    transcript: nextTranscript,
    contactRole: nextRole,
  });
  const actionUrl = buildProcessUrl(options.baseUrl, {
    callSid: nextCallSid,
    step: nextStep,
    company: options.context.company,
    contactName: options.context.contactName,
    topic: options.context.topic,
    state: stateToken,
  });

  const hints =
    nextStep === "intro"
      ? "zuständig, richtige Ansprechperson, durchstellen, worum geht es, einen Moment"
      : nextStep === "consent"
        ? "ja, nein, aufzeichnung erlaubt, ohne aufzeichnung"
        : "ja, nein, Termin, Rückruf, kein Interesse, später, nächste Woche";

  const gather = options.response.gather({
    input: ["speech", "dtmf"],
    action: actionUrl,
    method: "POST",
    language: "de-DE",
    speechTimeout: "auto",
    timeout: 4,
    actionOnEmptyResult: true,
    hints,
  });

  if (options.promptText.trim()) {
    if (isElevenLabsConfigured()) {
      gather.play(
        buildAudioUrl(options.baseUrl, {
          text: options.promptText,
          ...options.audioParams,
        }),
      );
    } else {
      gather.say({ voice: "alice", language: "de-DE" }, options.promptText);
    }
  }

  return new NextResponse(options.response.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

async function safelyStoreReport(payload: Parameters<typeof storeCallReport>[0]) {
  try {
    const report = await storeCallReport(payload);
    await sendReportEmail(report).catch(() => undefined);
    return report;
  } catch (error) {
    console.error("Twilio report could not be saved", error);

    if (payload.summary && payload.outcome) {
      await sendReportEmail({
        id: `fallback-${Date.now()}`,
        callSid: payload.callSid,
        leadId: payload.leadId,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        summary: payload.summary,
        outcome: payload.outcome,
        conversationDate: new Date().toISOString(),
        appointmentAt: payload.appointmentAt,
        nextCallAt: payload.nextCallAt,
        attempts: payload.attempts ?? 1,
        recordingConsent: Boolean(payload.recordingConsent),
        recordingUrl: payload.recordingUrl,
        emailedTo:
          process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
      }).catch(() => undefined);
    }

    return undefined;
  }
}

async function safelyLogConversationEvent(payload: {
  callSid?: string;
  topic: Topic;
  company: string;
  step: string;
  eventType: string;
  contactRole?: ContactRole;
  turn?: number;
  text?: string;
}) {
  try {
    await appendConversationEvent(payload);
  } catch (error) {
    console.error("Twilio conversation event could not be saved", error);
  }
}

export async function POST(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("state");
  const baseContext = readContext(request);
  const form = await request.formData();
  const tokenFromForm = String(form.get("state") || "").trim();
  const callSidRaw = String(form.get("CallSid") || "").trim();
  const callSid = callSidRaw || baseContext.callSid;
  const tokenState = decodeCallStateToken(tokenFromForm || tokenFromQuery, callSid);
  const context = mergeContextWithToken(baseContext, tokenState);
  const speech = normalizeText(form.get("SpeechResult"));
  const digits = normalizeText(form.get("Digits"));
  const response = new twilio.twiml.VoiceResponse();
  const dashboardData = await getDashboardData();
  const activeScript = dashboardData.scripts.find((entry) => entry.topic === context.topic);
  const callScript = resolveCallScript(context.topic, activeScript);

  if (context.step === "intro") {
    const heardText = speech || digits;
    const atGatekeeper = context.contactRole === "gatekeeper";

    if (!heardText) {
      const prompt = atGatekeeper
        ? buildReceptionPrompt(callScript, context.contactName, "intro")
        : buildDecisionMakerPrompt(context.topic, context.contactName);

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: atGatekeeper ? "gatekeeper" : "decision-maker",
      });
    }

    if (/(nicht da|außer haus|im termin|gerade nicht erreichbar|später erreichbar|morgen wieder da|heute nachmittag|heute vormittag|rufen sie.*wieder an|nochmal anrufen)/.test(heardText)) {
      const nextCallAt = buildFollowUpDate(heardText, "Wiedervorlage");

      await safelyStoreReport({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText}`),
        outcome: "Wiedervorlage",
        nextCallAt,
        recordingConsent: false,
        attempts: 1,
      });

      if (isElevenLabsConfigured()) {
        response.play(buildAudioUrl(baseUrl, { step: "final", variant: "callback" }));
      } else {
        response.say(
          { voice: "alice", language: "de-DE" },
          "Vielen Dank für die Info. Ich notiere die Wiedervorlage und melde mich dann passend noch einmal.",
        );
      }

      response.hangup();

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    if (atGatekeeper) {
      await safelyLogConversationEvent({
        callSid,
        topic: context.topic,
        company: context.company,
        step: "intro",
        eventType: "gatekeeper_turn",
        contactRole: "gatekeeper",
        turn: context.turn,
        text: heardText,
      });

      // If the known contact name is heard, switch immediately to decision-maker flow.
      if (mentionsTargetName(heardText, context.contactName)) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "transfer_connected",
          contactRole: "decision-maker",
          turn: context.turn,
          text: heardText,
        });

        const consentPrompt = buildConsentPrompt(context.contactName, activeScript);

        return respondWithGather({
          response,
          baseUrl,
          promptText: consentPrompt,
          audioParams: { text: consentPrompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
          step: "consent",
          contactRole: "decision-maker",
        });
      }

      if (/worum geht|was genau|um was geht/.test(heardText)) {
        const prompt = buildReceptionPrompt(callScript, context.contactName, "what");
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "gatekeeper",
        });
      }

      if (/email|e-mail|mailen|schicken sie/.test(heardText)) {
        const prompt = buildReceptionPrompt(
          callScript,
          context.contactName,
          /nur per mail|bitte per e-?mail|allgemeine mail/.test(heardText) ? "email-insist" : "email",
        );
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "gatekeeper",
        });
      }

      if (soundsLikeTransfer(heardText)) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "transfer_requested",
          contactRole: "gatekeeper",
          turn: context.turn,
          text: heardText,
        });

        const prompt = "Danke Ihnen.";
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "decision-maker",
          lowLatency: true,
        });
      }

      // A personal self-identification without clear reception cues is a strong signal
      // that we are already speaking to the decision-maker.
      if (soundsLikeSelfIdentification(heardText) && !soundsLikeCompanyReception(heardText)) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "transfer_connected",
          contactRole: "decision-maker",
          turn: context.turn,
          text: heardText,
        });

        const consentPrompt = buildConsentPrompt(context.contactName, activeScript);

        return respondWithGather({
          response,
          baseUrl,
          promptText: consentPrompt,
          audioParams: { text: consentPrompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
          step: "consent",
          contactRole: "decision-maker",
        });
      }

      // Phrases like "Mueller am Apparat" are often still spoken by reception.
      // Keep gatekeeper mode unless the known target contact is explicitly recognized.
      if (soundsLikeSwitchboardHandOff(heardText) && !mentionsTargetName(heardText, context.contactName)) {
        const prompt = buildReceptionPrompt(callScript, context.contactName, "intro");
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "gatekeeper",
        });
      }

      // After one or more gatekeeper turns, a short greeting often means
      // the decision-maker picked up after transfer. Switch mode proactively.
      if (context.turn >= 1 && isLikelyGreeting(heardText)) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "transfer_connected",
          contactRole: "decision-maker",
          turn: context.turn,
          text: heardText,
        });

        const prompt = buildDecisionMakerHello(context.contactName);
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "decision-maker",
        });
      }

      if (mentionsTargetName(heardText, context.contactName) || soundsLikeDecisionMaker(heardText)) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "transfer_connected",
          contactRole: "decision-maker",
          turn: context.turn,
          text: heardText,
        });

        const consentPrompt = buildConsentPrompt(context.contactName, activeScript);

        return respondWithGather({
          response,
          baseUrl,
          promptText: consentPrompt,
          audioParams: { text: consentPrompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
          step: "consent",
          contactRole: "decision-maker",
        });
      }

      if (context.turn >= 3 && (soundsLikeNotDecisionMaker(heardText) || isLikelyGreeting(heardText))) {
        await safelyLogConversationEvent({
          callSid,
          topic: context.topic,
          company: context.company,
          step: "intro",
          eventType: "gatekeeper_loop_break",
          contactRole: "gatekeeper",
          turn: context.turn,
          text: heardText,
        });

        const prompt =
          "Danke Ihnen. Dann klären wir es kurz direkt: Sind Sie selbst die zuständige Person für dieses Thema?";

        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "decision-maker",
        });
      }

      const prompt =
        mentionsDifferentNamedPerson(heardText, context.contactName) ||
        soundsLikeNotDecisionMaker(heardText) ||
        isLikelyGreeting(heardText)
          ? buildReceptionPrompt(callScript, context.contactName, "intro")
          : buildReceptionPrompt(callScript, context.contactName, "what");

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: "gatekeeper",
      });
    }

    if (soundsLikeNotDecisionMaker(heardText)) {
      const prompt = buildReceptionPrompt(callScript, context.contactName, "intro");
      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: "gatekeeper",
      });
    }

    const consentPrompt = buildConsentPrompt(context.contactName, activeScript);

    return respondWithGather({
      response,
      baseUrl,
      promptText: consentPrompt,
      audioParams: { text: consentPrompt },
      context,
      consent: "no",
      turn: 0,
      transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
      step: "consent",
      contactRole: "decision-maker",
    });
  }

  if (context.step === "consent") {
    const consent = detectConsent(speech, digits);

    if (consent === null) {
      const retryStateToken = encodeCallStateToken({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        step: "consent",
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn,
        transcript: context.transcript,
        contactRole: "decision-maker",
      });
      const retry = response.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: buildProcessUrl(baseUrl, {
          callSid,
          step: "consent",
          company: context.company,
          contactName: context.contactName,
          topic: context.topic,
          state: retryStateToken,
        }),
        method: "POST",
        language: "de-DE",
        speechTimeout: "auto",
      });

      if (isElevenLabsConfigured()) {
        retry.play(buildAudioUrl(baseUrl, { step: "consent-retry" }));
      } else {
        retry.say(
          { voice: "alice", language: "de-DE" },
          "Danke. Ich habe Sie akustisch nicht sicher verstanden. Wenn die Aufzeichnung in Ordnung ist, sagen Sie bitte ja oder drücken Sie die eins. Wenn nicht, sagen Sie bitte nein oder drücken Sie die zwei.",
        );
      }

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const consentValue = consent ? "yes" : "no";
    const appointmentText = `${consent ? "Vielen Dank." : "Natürlich, dann ohne Aufzeichnung."} ${buildDecisionMakerGreeting(context.topic, context.contactName, activeScript)}`;

    if (getTwilioConversationMode() === "media-stream") {
      const mediaStreamUrl = getTwilioMediaStreamUrl();

      if (mediaStreamUrl) {
        if (isElevenLabsConfigured()) {
          response.play(buildAudioUrl(baseUrl, { text: appointmentText }));
        } else {
          response.say({ voice: "alice", language: "de-DE" }, appointmentText);
        }

        const connect = response.connect();
        const stream = connect.stream({ url: mediaStreamUrl });
        stream.parameter({ name: "leadId", value: context.leadId || "" });
        stream.parameter({ name: "company", value: context.company });
        stream.parameter({ name: "contactName", value: context.contactName || "" });
        stream.parameter({ name: "topic", value: context.topic });
        stream.parameter({ name: "recordingConsent", value: consentValue });

        return new NextResponse(response.toString(), {
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        });
      }
    }

    return respondWithGather({
      response,
      baseUrl,
      promptText: appointmentText,
      audioParams: {
        step: "appointment",
        topic: context.topic,
        consent: consentValue,
      },
      context,
      consent: consentValue,
      turn: 0,
      transcript: `Gloria: ${appointmentText}`,
    });
  }

  if (context.step === "appointment") {
    const heardText = speech || digits;
    const prepQuestions = buildPreparationQuestions(callScript);
    const prepMode = readTranscriptMarker(context.transcript, "PREP_MODE");

    if (context.turn === 0) {
      const prompt = buildPreparationConsentPrompt(context.topic, activeScript);

      if (!heardText) {
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nGloria: ${prompt}`),
          step: "appointment",
          contactRole: "decision-maker",
        });
      }

      const consentIntent = detectYesNoIntent(heardText);

      if (consentIntent === "yes") {
        const firstQuestion = prepQuestions[0] || "Worauf sollen wir im Termin besonders achten?";
        return respondWithGather({
          response,
          baseUrl,
          promptText: firstQuestion,
          audioParams: { text: firstQuestion },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: 1,
          transcript: trimTranscript(
            `${context.transcript}\nInteressent: ${heardText}\nPREP_MODE: full\nGloria: ${firstQuestion}`,
          ),
          step: "appointment",
          contactRole: "decision-maker",
        });
      }

      const fallbackPrompt =
        context.topic === "private Krankenversicherung"
          ? "Das ist kein Problem. Dann nur kurz die Frage: Würden Sie sagen, dass Sie derzeit grundsätzlich gesund sind?"
          : `Das ist kein Problem. Dann nur kurz vorab: ${buildTopicDiscoveryPrompt(callScript)}`;

      return respondWithGather({
        response,
        baseUrl,
        promptText: fallbackPrompt,
        audioParams: { text: fallbackPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: 100,
        transcript: trimTranscript(
          `${context.transcript}\nInteressent: ${heardText}\nPREP_MODE: short\nGloria: ${fallbackPrompt}`,
        ),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    if (prepMode === "full" && context.turn >= 1 && context.turn <= prepQuestions.length) {
      const currentIndex = context.turn - 1;
      const answerLine = heardText ? `Interessent: ${heardText}` : "Interessent: keine Angabe";
      const answerLog = `PREP_ANSWER_${currentIndex + 1}: ${heardText || "keine Angabe"}`;

      if (currentIndex + 1 < prepQuestions.length) {
        const nextQuestion = prepQuestions[currentIndex + 1];
        return respondWithGather({
          response,
          baseUrl,
          promptText: nextQuestion,
          audioParams: { text: nextQuestion },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\n${answerLine}\n${answerLog}\nGloria: ${nextQuestion}`),
          step: "appointment",
          contactRole: "decision-maker",
        });
      }

      const nextPrompt =
        "Vielen Dank. Wann passt es Ihnen in der nächsten Woche besser, eher vormittags oder eher nachmittags?";
      return respondWithGather({
        response,
        baseUrl,
        promptText: nextPrompt,
        audioParams: { text: nextPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: 200,
        transcript: trimTranscript(`${context.transcript}\n${answerLine}\n${answerLog}\nGloria: ${nextPrompt}`),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    if (prepMode === "short" && context.turn === 100) {
      const nextPrompt =
        "Danke Ihnen. Wann passt es Ihnen in der nächsten Woche besser, eher vormittags oder eher nachmittags?";
      return respondWithGather({
        response,
        baseUrl,
        promptText: nextPrompt,
        audioParams: { text: nextPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: 200,
        transcript: trimTranscript(
          `${context.transcript}\nInteressent: ${heardText || "keine Angabe"}\nPREP_SHORT: ${heardText || "keine Angabe"}\nGloria: ${nextPrompt}`,
        ),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    const selectedDayPart = readTranscriptMarker(context.transcript, "APPT_DAYPART") as
      | "vormittag"
      | "nachmittag"
      | undefined;

    if (context.turn === 200) {
      const dayPart = heardText ? detectDayPart(heardText) : undefined;
      const prompt = dayPart
        ? "Welcher Tag passt Ihnen denn hier am besten?"
        : "Damit ich es sauber eintragen kann: passt es in der nächsten Woche eher vormittags oder eher nachmittags?";

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: dayPart ? 201 : 200,
        transcript: trimTranscript(
          `${context.transcript}\nInteressent: ${heardText || "keine Angabe"}${
            dayPart ? `\nAPPT_DAYPART: ${dayPart}` : ""
          }\nGloria: ${prompt}`,
        ),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    if (context.turn === 201) {
      const weekday = heardText ? detectWeekday(heardText) : undefined;

      if (!weekday || !selectedDayPart) {
        const prompt = "Damit ich den Termin fest eintrage: welcher Wochentag passt Ihnen am besten?";
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: 201,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText || "keine Angabe"}\nGloria: ${prompt}`),
          step: "appointment",
          contactRole: "decision-maker",
        });
      }

      const slot = buildNextWeekSlot(weekday, selectedDayPart);
      const slotLabel = formatAppointmentLabel(slot);
      const prompt = `Dann machen wir ${slotLabel}. Möchten Sie dazu eine Bestätigungsmail erhalten?`;

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: 202,
        transcript: trimTranscript(
          `${context.transcript}\nInteressent: ${heardText}\nAPPT_DAY: ${weekday}\nAPPT_SLOT_ISO: ${slot.toISOString()}\nAPPT_SLOT_LABEL: ${slotLabel}\nGloria: ${prompt}`,
        ),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    if (context.turn === 202) {
      const slotIso = readTranscriptMarker(context.transcript, "APPT_SLOT_ISO");
      const slotLabel = readTranscriptMarker(context.transcript, "APPT_SLOT_LABEL") || "vereinbarten Zeitpunkt";
      const wantsMail = detectYesNoIntent(heardText || "") === "yes";
      const finalSummaryNote = wantsMail
        ? `Mitteilung erhalten: Kunde ${context.company} möchte eine Terminbestätigungsmail für ${slotLabel}. Bitte Terminbestätigungsmail vorbereiten.`
        : "Kunde wünscht keine Terminbestätigungsmail.";

      await safelyStoreReport({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText || "keine Angabe"}\n${finalSummaryNote}`),
        outcome: "Termin",
        appointmentAt: slotIso || undefined,
        recordingConsent: context.consent === "yes",
        attempts: 1,
      });

      const closingText = wantsMail
        ? `Perfekt, dann ist der Termin für ${slotLabel} fest eingetragen und wir bereiten die Bestätigungsmail für Sie vor. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.`
        : `Perfekt, dann ist der Termin für ${slotLabel} fest eingetragen. Vielen Dank für das nette Gespräch, ich wünsche Ihnen einen schönen Tag. Auf Wiederhören.`;

      if (isElevenLabsConfigured()) {
        response.play(buildAudioUrl(baseUrl, { text: closingText }));
      } else {
        response.say({ voice: "alice", language: "de-DE" }, closingText);
      }

      response.hangup();
      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    if (!heardText) {
      const prompt = buildAppointmentOffer(activeScript);
      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nGloria: ${prompt}`),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    if (/(kein interesse|doch nicht|lieber nicht)/.test(heardText)) {
      await safelyStoreReport({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText}`),
        outcome: "Absage",
        recordingConsent: context.consent === "yes",
        attempts: 1,
      });

      response.say(
        { voice: "alice", language: "de-DE" },
        "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.",
      );
      response.hangup();

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    if (isCallbackRequest(heardText)) {
      const nextCallAt = buildFollowUpDate(heardText, "Wiedervorlage");
      await safelyStoreReport({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText}`),
        outcome: "Wiedervorlage",
        nextCallAt,
        recordingConsent: context.consent === "yes",
        attempts: 1,
      });

      response.say(
        { voice: "alice", language: "de-DE" },
        "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.",
      );
      response.hangup();

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const selectedAppointment = resolveAppointmentSelection(heardText);

    if (!selectedAppointment) {
      const prompt = `Danke. Damit ich den Termin konkret eintragen kann: ${buildAppointmentOffer(activeScript)}`;
      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    const confirmationText = buildAppointmentConfirmation(selectedAppointment, activeScript);
    await safelyStoreReport({
      callSid,
      leadId: context.leadId,
      company: context.company,
      contactName: context.contactName,
      topic: context.topic,
      summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${confirmationText}`),
      outcome: "Termin",
      appointmentAt: selectedAppointment.toISOString(),
      recordingConsent: context.consent === "yes",
      attempts: 1,
    });

    if (isElevenLabsConfigured()) {
      response.play(buildAudioUrl(baseUrl, { text: confirmationText }));
    } else {
      response.say({ voice: "alice", language: "de-DE" }, confirmationText);
    }

    response.hangup();

    return new NextResponse(response.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  if (context.step === "conversation") {
    const heardText = speech || digits;
    const problemConfirmPending = readTranscriptMarker(context.transcript, "PROBLEM_CONFIRM_PENDING") === "yes";

    if (!heardText) {
      if (context.turn >= MAX_SILENT_RETRIES) {
        await safelyStoreReport({
          callSid,
          leadId: context.leadId,
          company: context.company,
          contactName: context.contactName,
          topic: context.topic,
          summary: trimTranscript(
            `${context.transcript}\nInteressent: keine verwertbare Rückmeldung im Live-Gespräch.`,
          ),
          outcome: "Kein Kontakt",
          recordingConsent: context.consent === "yes",
          attempts: 1,
        });

        if (isElevenLabsConfigured()) {
          response.play(buildAudioUrl(baseUrl, { step: "final", variant: "neutral" }));
        } else {
          response.say(
            { voice: "alice", language: "de-DE" },
            "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
          );
        }

        response.hangup();

        return new NextResponse(response.toString(), {
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        });
      }

      const retryText =
        "Ich habe Sie akustisch gerade nicht ganz verstanden. Was ist Ihnen bei dem Thema aktuell wichtiger: eher Mitarbeiterbindung, Kosten oder erstmal nur ein kurzer Überblick?";

      return respondWithGather({
        response,
        baseUrl,
        promptText: retryText,
        audioParams: { step: "dynamic", text: retryText },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nGloria: ${retryText}`),
        lowLatency: true,
      });
    }

    if (
      context.turn === 0 &&
      /worum geht|was genau|gern|gerne|ja|ja bitte|okay|ok|ich hore|ich höre|sagen sie|erzählen sie|um was geht/.test(heardText)
    ) {
      const explanationPrompt = `${buildTopicExplanationPrompt(context.topic, activeScript)} ${buildTopicDiscoveryPrompt(callScript)}`;

      return respondWithGather({
        response,
        baseUrl,
        promptText: explanationPrompt,
        audioParams: { text: explanationPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${explanationPrompt}`),
      });
    }

    if (problemConfirmPending) {
      if (soundsLikeYes(heardText)) {
        const appointmentPrompt = buildPreparationConsentPrompt(context.topic, activeScript);
        return respondWithGather({
          response,
          baseUrl,
          promptText: appointmentPrompt,
          audioParams: { text: appointmentPrompt },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: 0,
          transcript: trimTranscript(
            `${context.transcript}\nInteressent: ${heardText}\nPROBLEM_CONFIRM_PENDING: no\nGloria: ${appointmentPrompt}`,
          ),
          step: "appointment",
          contactRole: "decision-maker",
        });
      }

      if (soundsLikeNo(heardText)) {
        const objectionPrompt = cleanScriptText(
          activeScript?.objectionHandling ||
            callScript.objections["kein interesse"] ||
            "Verstehe. Lassen Sie uns gern einen ruhigen Zeitpunkt für eine Wiedervorlage festhalten.",
        );

        return respondWithGather({
          response,
          baseUrl,
          promptText: objectionPrompt,
          audioParams: { text: objectionPrompt },
          context,
          consent: context.consent === "yes" ? "yes" : "no",
          turn: context.turn + 1,
          transcript: trimTranscript(
            `${context.transcript}\nInteressent: ${heardText}\nPROBLEM_CONFIRM_PENDING: no\nGloria: ${objectionPrompt}`,
          ),
          step: "conversation",
          contactRole: "decision-maker",
        });
      }

      const clarifyPrompt = "Danke. Nur kurz zur Einordnung: Wäre das für Sie grundsätzlich interessant, ja oder nein?";
      return respondWithGather({
        response,
        baseUrl,
        promptText: clarifyPrompt,
        audioParams: { text: clarifyPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${clarifyPrompt}`),
        step: "conversation",
        contactRole: "decision-maker",
      });
    }

    const isObjection =
      /kein interesse|keine zeit|später|unterlagen|email|e-mail|nicht zuständig|falsche person|was genau|worum geht|erklären sie|wir haben schon|haben bereits|zu teuer|zu klein|kein bedarf/.test(
        heardText,
      );
    const isPositiveSignal = /interessant|passt|gerne|gern|okay|einverstanden|ja/.test(heardText);
    const stage = isObjection
      ? "objection"
      : context.turn <= 0
        ? "discovery"
        : context.turn === 1
          ? "problem"
          : context.turn === 2
            ? "benefit"
            : context.turn >= 3 || isPositiveSignal
              ? "closing"
              : "discovery";

    if (stage === "problem") {
      const confirmationPrompt = buildProblemBenefitConfirmation(context.topic, activeScript);

      return respondWithGather({
        response,
        baseUrl,
        promptText: confirmationPrompt,
        audioParams: { text: confirmationPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(
          `${context.transcript}\nInteressent: ${heardText}\nPROBLEM_CONFIRM_PENDING: yes\nGloria: ${confirmationPrompt}`,
        ),
        step: "conversation",
        contactRole: "decision-maker",
      });
    }

    const shouldUseFastRuleMode = !process.env.OPENAI_API_KEY;

    const aiResult = await generateAdaptiveReply({
      topic: context.topic,
      prospectMessage: heardText,
      transcript: context.transcript,
      script: activeScript,
      stage,
      preferFastResponse: shouldUseFastRuleMode,
    });

    const updatedTranscript = trimTranscript(
      [context.transcript, `Interessent: ${heardText}`, `Gloria: ${aiResult.reply}`]
        .filter(Boolean)
        .join("\n"),
    );

    const detectedOutcome = classifyOutcome(heardText, stage);
    if (detectedOutcome === "Termin") {
      const appointmentPrompt = buildPreparationConsentPrompt(context.topic, activeScript);
      return respondWithGather({
        response,
        baseUrl,
        promptText: appointmentPrompt,
        audioParams: { text: appointmentPrompt },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: 0,
        transcript: trimTranscript(`${updatedTranscript}\nGloria: ${appointmentPrompt}`),
        step: "appointment",
        contactRole: "decision-maker",
      });
    }

    const reachedTurnLimit = context.turn >= MAX_LIVE_TURNS;
    const shouldFinish = detectedOutcome !== "Kein Kontakt" || reachedTurnLimit;

    if (!shouldFinish) {
      return respondWithGather({
        response,
        baseUrl,
        promptText: aiResult.reply,
        audioParams: { step: "dynamic", text: aiResult.reply },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: updatedTranscript,
      });
    }

    const finalOutcome = detectedOutcome;
    const followUpDate = buildFollowUpDate(heardText, finalOutcome);
    await safelyStoreReport({
      callSid,
      leadId: context.leadId,
      company: context.company,
      contactName: context.contactName,
      topic: context.topic,
      summary: updatedTranscript,
      outcome: finalOutcome,
      nextCallAt: finalOutcome === "Wiedervorlage" ? followUpDate : undefined,
      recordingConsent: context.consent === "yes",
      attempts: 1,
    });

    if (isElevenLabsConfigured()) {
      response.play(
        buildAudioUrl(baseUrl, {
          step: "final",
          variant:
            finalOutcome === "Wiedervorlage"
                ? "callback"
                : finalOutcome === "Absage"
                  ? "rejection"
                  : "neutral",
        }),
      );
    } else if (finalOutcome === "Wiedervorlage") {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.",
      );
    } else if (finalOutcome === "Absage") {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.",
      );
    } else {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
      );
    }

    response.hangup();

    return new NextResponse(response.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  const outcome = classifyOutcome(speech, "closing");
  const followUpDate = buildFollowUpDate(speech, outcome);
  await safelyStoreReport({
    callSid,
    leadId: context.leadId,
    company: context.company,
    contactName: context.contactName,
    topic: context.topic,
    summary:
      speech
        ? `Twilio-Sprachdialog: ${speech}`
        : "Twilio-Sprachdialog ohne klar verwertbare Rückmeldung.",
    outcome,
    appointmentAt: outcome === "Termin" ? followUpDate : undefined,
    nextCallAt: outcome === "Wiedervorlage" ? followUpDate : undefined,
    recordingConsent: context.consent === "yes",
    attempts: 1,
  });

  if (isElevenLabsConfigured()) {
    response.play(
      buildAudioUrl(baseUrl, {
        step: "final",
        variant:
          outcome === "Termin"
            ? "success"
            : outcome === "Wiedervorlage"
              ? "callback"
              : outcome === "Absage"
                ? "rejection"
                : "neutral",
      }),
    );
  } else if (outcome === "Termin") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Vielen Dank. Ich habe den Termin verbindlich notiert und Herr Duic meldet sich mit der Bestätigung bei Ihnen.",
    );
  } else if (outcome === "Wiedervorlage") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.",
    );
  } else if (outcome === "Absage") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.",
    );
  } else {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
    );
  }

  response.hangup();

  return new NextResponse(response.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
