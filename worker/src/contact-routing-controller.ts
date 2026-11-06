import { classifyInboundSpeech, hasExplicitQueueInstruction, hasInteractiveReceptionQuestion, hasTransferWaitInstruction, isHumanContactAfterQueue } from "./call-classification.js";
import { endsWithSentenceAbbreviation } from "./german-sentence.js";

export const CONTACT_WAIT_TIMEOUT_MS = 3 * 60_000;

export type ContactRoutingStage =
  | "awaiting_contact"
  | "confirming_decision_maker"
  | "gatekeeper"
  | "waiting_for_transfer"
  | "decision_maker"
  | "voicemail";

export type ContactRoutingState = {
  stage: ContactRoutingStage;
  targetName?: string;
  gatekeeperRequestMade?: boolean;
  gatekeeperReasonGiven?: boolean;
  awaitingAvailabilityAnswer?: boolean;
  availabilityFollowUpAsked?: boolean;
};

export function isGatekeeperReasonQuestion(text: string): boolean {
  return /\b(?:worum\s+(?:es\s+)?geht|um\s+was\s+geht|(?:worum|um\s+was)\s+handelt\s+es\s+sich|was\s+(?:genau\s+)?ist\s+(?:denn\s+)?(?:der\s+)?(?:grund|anlass)|was\s+(?:ist|wäre)\s+(?:denn\s+)?(?:ihr\s+)?anliegen|weshalb\s+rufen|warum\s+rufen)\b/i.test(text);
}

export function getSpeakableCampaignReason(callObjective?: string): string | undefined {
  const firstSentence = callObjective?.trim().match(/^[^.!?]{8,220}[.!?]/)?.[0]?.trim();
  if (!firstSentence || endsWithSentenceAbbreviation(firstSentence)
    || !/^(?:es geht um|ich rufe (?:zum|wegen)|der anlass (?:meines|des) anrufs ist|wir sprechen über)\b/i.test(firstSentence)) {
    return undefined;
  }
  return `${firstSentence.replace(/[.!?]+$/, "").replace(/\s+/g, " ")}.`;
}

export function buildGatekeeperReason(topic?: string, callObjective?: string, receptionTopicReason?: string): string | null {
  if (/privat.*krankenversicherung|\bpkv\b/i.test(topic || "")) {
    return "Es geht um die langfristige Beitragsentwicklung in der Gesundheitsversorgung.";
  }
  const spokenReason = getSpeakableCampaignReason(callObjective) || getSpeakableCampaignReason(receptionTopicReason);
  if (spokenReason) return spokenReason;
  if (callObjective?.trim()) return null;
  const safeTopic = buildGatekeeperTopic(undefined, undefined, receptionTopicReason).inline?.replace(/^zum\s+thema\s+/i, "");
  return safeTopic
    ? `Es geht um das Thema ${safeTopic}.`
    : "Es geht um ein kurzes Anliegen für die zuständige Person.";
}

/** Topic for the gatekeeper transfer request: either inline ("zum Thema …") or as a short follow-up sentence. */
export function buildGatekeeperTopic(
  topic?: string,
  callObjective?: string,
  receptionTopicReason?: string,
): { inline?: string; sentence?: string } {
  if (/privat.*krankenversicherung|\bpkv\b/i.test(topic || "")) {
    return { inline: "zum Thema Beitragsentwicklung in der Gesundheitsversorgung" };
  }
  const storedTopic = receptionTopicReason?.match(/\bzum\s+thema\s+([^.!?]+)/i)?.[1]
    ?.split(/[,;:]|\s+(?:und|sowie)\s+(?:wie|was|warum|ob)\b/i)[0]?.trim();
  if (storedTopic) return { inline: `zum Thema ${storedTopic}` };
  const reason = getSpeakableCampaignReason(receptionTopicReason) || getSpeakableCampaignReason(callObjective);
  if (reason) {
    const short = reason.split(/\s*[:;–—]\s*/)[0].replace(/[.!?]+$/, "").trim();
    return { sentence: `${short}.` };
  }
  return {};
}

function isNegatedTransfer(text: string): boolean {
  return text.split(/[,;.!?]|\b(?:aber|sondern)\b/i).some((part) => {
    const negated = /\b(?:nicht|nie|kein(?:e|en|er|em|es)?)\b/i.test(part);
    const transferVerb = /\b(?:verbinden|verbinde|verbunden|weiterleiten|weiterleite|weitergeleitet|durchstellen|durchgestellt|weitergeben)\b/i.test(part)
      || /\b(?:stelle|stellen|leite|leiten|gebe|geben|schalte|schalten)\b[^.!?]{0,100}\b(?:durch|weiter|zu)\b/i.test(part);
    return negated && transferVerb;
  });
}

const RETRY_WEEKDAYS = ["montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag", "sonntag"];

// Turns a receptionist's availability hint into a natural retry phrase ("nächste Woche", "am Montag", ...).
export function extractRetryTimePhrase(text: string): string | undefined {
  const normalized = text.toLowerCase().replace(/\bguten\s+morgen\b/g, " ");
  const numberWords: Record<string, string> = { "2": "zwei", "3": "drei", "4": "vier", zwei: "zwei", drei: "drei", vier: "vier" };
  if (/\bübernächste[nr]?\s+woche\b/.test(normalized)) return "übernächste Woche";
  if (/\b(?:nächste[nr]?|kommende[nr]?)\s+woche\b/.test(normalized)) return "nächste Woche";
  const weeks = normalized.match(/\bin\s+(2|3|4|zwei|drei|vier)\s+wochen\b/);
  if (weeks) return `in ${numberWords[weeks[1]]} Wochen`;
  if (/\b(?:nächste[nr]?|kommende[nr]?)\s+monat\b/.test(normalized)) return "nächsten Monat";
  if (/\bnach\s+(?:dem|seinem|ihrem)\s+urlaub\b/.test(normalized)) return "nach dem Urlaub";
  if (/\bübermorgen\b/.test(normalized)) return "übermorgen";
  const dayPart = normalized.match(/\b(heute|morgen)\s+(vormittag|nachmittag|früh|abend)\b/);
  if (dayPart) return `${dayPart[1]} ${dayPart[2] === "früh" ? "früh" : dayPart[2][0].toUpperCase() + dayPart[2].slice(1)}`;
  if (/\bmorgen\b/.test(normalized)) return "morgen";
  const weekday = RETRY_WEEKDAYS.find((day) => new RegExp(`\\b${day}\\b`).test(normalized));
  if (weekday) return `am ${weekday[0].toUpperCase()}${weekday.slice(1)}`;
  if (/\bheute\s+nachmittag\b|\bam\s+nachmittag\b|\bnachmittags?\b/.test(normalized)) return "am Nachmittag";
  if (/\bheute\s+vormittag\b|\bam\s+vormittag\b|\bvormittags?\b/.test(normalized)) return "am Vormittag";
  if (/\bin\s+(?:einer|1)\s+stunde\b/.test(normalized)) return "in einer Stunde";
  if (/\bheute\s+(?:noch|später)\b|\bspäter\s+heute\b/.test(normalized)) return "heute etwas später";
  return undefined;
}

export function mentionsRetryTime(text: string): boolean {
  return Boolean(extractRetryTimePhrase(text))
    || /\b(?:uhr|halb\s+[a-zäöüß]+|viertel\s+(?:nach|vor))\b|\bab\s+(?:dem\s+)?\d/i.test(text);
}

function extractClockPhrase(text: string): string | undefined {
  const match = text.match(/\b(gegen|um|ab)\s+((?:halb|viertel\s+(?:nach|vor))\s+[a-zäöüß]+|[a-zäöüß]+|\d{1,2}(?:[:.]\d{2})?)\s+uhr\b/i);
  return match ? `${match[1].toLowerCase()} ${match[2]} Uhr` : undefined;
}

export function buildRetryFarewell(text: string, prefix = "Vielen Dank"): string {
  const dayPhrase = extractRetryTimePhrase(text);
  const clock = extractClockPhrase(text);
  const phrase = dayPhrase && clock && /^(?:morgen|übermorgen|am\s+(?!vormittag|nachmittag))/i.test(dayPhrase)
    ? `${dayPhrase} ${clock}`
    : dayPhrase ?? clock;
  if (phrase) return `${prefix}. Dann versuche ich es ${phrase} erneut. Auf Wiederhören.`;
  if (mentionsRetryTime(text)) return `${prefix}. Dann versuche ich es zu der genannten Zeit erneut. Auf Wiederhören.`;
  return `${prefix}. Dann versuche ich es zu einem späteren Zeitpunkt erneut. Auf Wiederhören.`;
}

export function isGatekeeperUnavailable(text: string): boolean {
  return isNegatedTransfer(text)
    || /\b(?:nicht\s+(?:da|erreichbar|zu\s+sprechen|im\s+haus|verfügbar|im\s+büro)|außer\s+haus|abwesend|im\s+termin|im\s+urlaub|(?:hat|habe|haben)\s+(?:gerade\s+|diese\s+woche\s+|noch\s+)*(?:keine\s+zeit|urlaub)|krank|in\s+elternzeit)\b/i.test(text);
}

export function classifyReceptionTransfer(text: string): "offered" | "in_progress" | null {
  if (isNegatedTransfer(text)) return null;
  if (/\b(?:nachricht|e-?mail|unterlagen|informationen)\b/i.test(text)
    && !/\b(?:sie|dich|anruf|gespräch)\b/i.test(text)) return null;

  if (/\b(?:ich|wir)\s+verbinde(?:n)?\b/i.test(text)
    || /\b(?:ich|wir)\s+(?:stelle|stellen|schalte|schalten)\s+(?:sie|dich|den\s+anruf|das\s+gespräch)\b[^.!?]{0,100}\b(?:durch|weiter|zu)\b/i.test(text)
    || /\b(?:ich|wir)\s+(?:stelle|stellen|schalte|schalten)\s+ihnen\b[^.!?]{0,100}\bdurch\b/i.test(text)
    || /\b(?:ich|wir)\s+(?:leite|leiten|gebe|geben)\s+(?:sie|dich|den\s+anruf|das\s+gespräch)\b[^.!?]{0,100}\bweiter\b/i.test(text)
    || /\b(?:ich|wir)\s+(?:werde|werden)\s+(?:sie|dich|den\s+anruf|das\s+gespräch)\b[^.!?]{0,100}\b(?:verbinden|weiterleiten|durchstellen|weitergeben)\b/i.test(text)
    || /\b(?:sie|ihr\s+anruf|das\s+gespräch)\s+w(?:ird|erden)\s+(?:jetzt\s+)?(?:weitergeleitet|verbunden|durchgestellt)\b/i.test(text)
    || /\b(?:ich|wir)\s+(?:hole|holen)\s+(?:ihn|sie|den\s+kollegen|die\s+kollegin)\b/i.test(text)) {
    return "in_progress";
  }
  const offered = text.split(/[.!?;]+/).some((part) =>
    /\b(?:verbinden|weiterleiten|durchstellen|durchschalten|weitergeben|vermitteln)\b/i.test(part)
    && /\b(?:(?:ich|wir)\s+(?:kann|könnte|können|könnten|würde|würden)|(?:kann|könnte|können|könnten|soll|sollen|darf|dürfen)\s+(?:ich|wir)|(?:möchten|wollen)\s+sie)\b/i.test(part));
  if (offered) return "offered";
  return null;
}

export function acceptsTransferRequest(text: string): boolean {
  return /^(?:ja(?:[, ]+(?:gerne|bitte|klar|natürlich|selbstverständlich))?|gerne|klar|natürlich|selbstverständlich|sicher|okay|ok|mache\s+ich|mach\s+ich)[.!?,\s]*$/i.test(text.trim());
}

function targetNameTokens(targetName?: string): string[] {
  return (targetName || "")
    .toLowerCase()
    .replace(/[^a-zäöüß\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(?:herr|frau|dr|prof)$/.test(token));
}

function deniesDecisionMakerIdentity(text: string): boolean {
  return /\b(?:das\s+bin\s+ich|ich\s+bin\s+(?:es|selbst|zuständig))\s+(?:(?:leider|definitiv|doch)\s+)?nicht\b/i.test(text);
}

function identifiesDecisionMaker(text: string, targetName?: string): boolean {
  const normalized = text.toLowerCase();
  if (deniesDecisionMakerIdentity(normalized) || isGatekeeperUnavailable(normalized)) {
    return false;
  }
  if (/\b(?:stelle\s+sie\s+zu|stellen\s+sie\s+zu|verbinde\s+sie|verbinde|durchstellen|weiterleiten|weiterleite|schalte\s+weiter|durchstellen\s+zu)\b/i.test(normalized)) {
    return false;
  }
  if (/\b(?:das bin ich|ich bin es|ich bin selbst|selbst am apparat|sprechen sie mit mir|ich bin zuständig|ich bin der verantwortliche|ich bin der entscheidungsträger)\b/i.test(normalized)) {
    return true;
  }

  const targetTokens = targetNameTokens(targetName);
  if (targetTokens.length === 0) return false;
  const escapedName = targetTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const escapedSurname = targetTokens.at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRegex = new RegExp(
      `(?:` +
        `\\bmein(?:e)?\\s+name\\s+ist\\s+${escapedName}\\b|` +
        `\\bsie\\s+sprechen\\s+mit\\s+(?:herrn?|frau)?\\s*${escapedName}\\b|` +
        `\\bhier\\s+(?:ist|spricht)\\s+(?:herr|frau)?\\s*${escapedName}\\b|` +
        `\\b(?:herr|frau)?\\s*${escapedName}\\s+am\\s+apparat\\b|` +
        `\\bich\\s+bin\\s+(?:herr|frau)?\\s*${escapedName}\\b|` +
        `(?:^|[,.!?]\\s*|\\b(?:ja|hallo|guten\\s+(?:tag|morgen|abend))\\s*,?\\s*)(?:herrn?\\s+|frau\\s+)?(?:${escapedName}|${escapedSurname})\\s*,?\\s*(?:guten\\s+(?:tag|morgen|abend)|hallo|hier|am\\s+apparat)\\b` +
      `)`,
      "i",
  );

  return nameRegex.test(normalized);
}

const NON_NAME_WORDS = new Set([
  "hallo", "ja", "jaa", "nein", "guten", "tag", "morgen", "abend", "moin", "servus", "grüß", "gott", "hier", "wer", "was",
  "ist", "spricht", "bitte", "firma", "praxis", "büro", "kanzlei", "agentur", "zentrale", "empfang", "herr", "herrn", "frau",
  "der", "die", "das", "dem", "den", "und", "mit", "ich", "sie", "wir", "schönen", "schön", "einen", "willkommen",
]);

function selfIntroducedNameTokens(text: string): string[] {
  const nameWord = "[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?";
  const name = `(${nameWord}(?:\\s+${nameWord})?)`;
  const patterns = [
    new RegExp(`\\b(?:sie\\s+sprechen\\s+mit|mein(?:e)?\\s+name\\s+ist|hier\\s+(?:ist|spricht))\\s+(?:(?:herr|herrn|frau)\\s+)?${name}`, "i"),
    new RegExp(`\\bich\\s+bin\\s+(?:herr|frau)\\s+${name}`, "i"),
    new RegExp(`(?:^|[,.!?;]\\s*|\\b(?:hallo|ja|moin|guten\\s+(?:tag|morgen|abend))\\s*,?\\s*)(?:(?:herr|frau)\\s+)?${name}\\s+(?:hier|am\\s+apparat)\\b`, "i"),
    new RegExp(`(?:^|[,.!?;]\\s*|\\b(?:hallo|ja|moin|guten\\s+(?:tag|morgen|abend))\\s*,?\\s*)(?:(?:herr|frau)\\s+)?${name}\\s*,?\\s*(?:guten\\s+(?:tag|morgen|abend)|hallo)\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const tokens = match[1].toLowerCase().split(/\s+/).filter((token) => token.length >= 3 && !NON_NAME_WORDS.has(token));
    // Only a capitalized word that is not a greeting or a business label counts as a personal name.
    if (tokens.length > 0 && /^[A-ZÄÖÜ]/.test(match[1])) return tokens;
  }
  return [];
}

// Phone greetings are often garbled by ASR (company names); a short human utterance still means someone answered.
function isShortHumanAnswer(text: string, classification: ReturnType<typeof classifyInboundSpeech>): boolean {
  if (classification !== "human") return false;
  const words = text.trim().split(/\s+/).filter((word) => /[a-zäöüß]/i.test(word));
  return words.length >= 2 && words.length <= 12;
}

function introducesOtherPerson(text: string, targetName?: string): boolean {
  const targetTokens = targetNameTokens(targetName);
  if (targetTokens.length === 0) return false;
  const spokenTokens = selfIntroducedNameTokens(text);
  if (spokenTokens.length === 0) return introducesOtherNameAtPhone(text, targetTokens);
  return !spokenTokens.some((token) => targetTokens.includes(token));
}

// "Musterbau GmbH, Stadler am Apparat" – a different surname right before "am Apparat" means reception.
function introducesOtherNameAtPhone(text: string, targetTokens: string[]): boolean {
  const match = text.match(/([A-ZÄÖÜ][a-zäöüß]{2,}(?:-[A-ZÄÖÜ][a-zäöüß]+)?)\s+[aA]m\s+[aA]pparat\b/);
  if (!match) return false;
  const spoken = match[1].toLowerCase();
  if (NON_NAME_WORDS.has(spoken) || /^(?:gmbh|kg|ag|ug|ohg|co)$/.test(spoken)) return false;
  // ASR often slightly misspells the target name; a shared prefix counts as the target.
  return !targetTokens.some((token) => token === spoken || token.slice(0, 4) === spoken.slice(0, 4));
}

function isClearlyGatekeeper(text: string, targetName?: string): boolean {
  const normalized = text.toLowerCase();
  const targetTokens = targetNameTokens(targetName);
  if (introducesOtherPerson(text, targetName)) return true;
  const mentionsUnavailableTarget = targetTokens.length > 0
    && new RegExp(
      `\\b${targetTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}\\b[\\s\\S]{0,40}\\b(?:nicht\\s+da|nicht\\s+erreichbar|abwesend|außer\\s+haus|im\\s+termin|gerade\\s+nicht)\\b`,
      "i",
    ).test(normalized);

  return mentionsUnavailableTarget
    || /\b(?:stelle\s+sie\s+zu|stellen\s+sie\s+zu|verbinde\s+sie|ich\s+verbinde|durchstellen|weiterleiten|weiterleite|schalte\s+weiter)\b/i.test(normalized)
    || /\b(?:zentrale|empfang|assistenz|telefonassistenz|sekretariat|rezeption|telefonzentrale)\b/i.test(normalized)
    || /\b(?:digitale|virtuelle|ki-?)\s*(?:telefon)?assistent(?:in)?\b|\bwie\s+lautet\s+ihr\s+name\b|\bmit\s+dem\s+richtigen\s+ansprechpartner\b/i.test(normalized)
    || /\b(?:gmbh|ag|kg|ug|ohg)\b[\s\S]{0,40}\b(?:guten\s+(?:tag|morgen|abend)|hallo)\b/i.test(normalized)
    || /\b(?:gmbh|ag|kg|ug|ohg)\b.{0,60}\b(?:mein(?:e)?\s+name|hier\s+ist)\b/i.test(text);
}

function confirmsDecisionMaker(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (deniesDecisionMakerIdentity(normalized)
    || /\b(?:nein|falsch|nicht\s+(?:der|die|das|zuständig|ich|selbst|herr|frau)|ich\s+verbinde|ich\s+stelle|weiterleiten|durchstellen)\b/i.test(normalized)) {
    return false;
  }
  return /^(?:ja|genau|richtig|am\s+apparat|hier|das\s+bin\s+ich|ich\s+bin\s+(?:es|das)|spreche[n]?\s+sie\s+mit\s+mir|korrekt)[.!?,\s]*$/i.test(normalized)
    || /\b(?:ja|genau|richtig|das\s+bin\s+ich|ich\s+bin\s+(?:es|das)|am\s+apparat)\b/i.test(normalized);
}

export function createContactRoutingState(targetName?: string): ContactRoutingState {
  return { stage: "awaiting_contact", targetName: targetName?.trim() || undefined };
}

export function advanceContactRouting(
  state: ContactRoutingState,
  userText: string,
): ContactRoutingState {
  if (state.stage === "voicemail") return state;

  const classification = classifyInboundSpeech(userText);
  if (classification === "voicemail") return { ...state, stage: "voicemail" };
  const transfer = classifyReceptionTransfer(userText);
  const asksBeforeTransfer = isGatekeeperReasonQuestion(userText)
    || Boolean(transfer && hasInteractiveReceptionQuestion(userText));
  if (state.stage === "decision_maker") {
    if (asksBeforeTransfer && !hasExplicitQueueInstruction(userText)) return state;
    return classification === "queue" || transfer
      ? { ...state, stage: "waiting_for_transfer", gatekeeperRequestMade: true }
      : state;
  }
  if (identifiesDecisionMaker(userText, state.targetName) && !hasExplicitQueueInstruction(userText)) {
    return { ...state, stage: "decision_maker" };
  }
  if (asksBeforeTransfer && !hasExplicitQueueInstruction(userText)) {
    return {
      ...state,
      stage: "gatekeeper",
      gatekeeperRequestMade: state.stage === "waiting_for_transfer" ? false : state.gatekeeperRequestMade || Boolean(transfer),
      gatekeeperReasonGiven: state.stage === "waiting_for_transfer" ? false : state.gatekeeperReasonGiven,
      awaitingAvailabilityAnswer: state.stage === "waiting_for_transfer" ? false : state.awaitingAvailabilityAnswer,
      availabilityFollowUpAsked: state.stage === "waiting_for_transfer" ? false : state.availabilityFollowUpAsked,
    };
  }
  if (transfer === "in_progress" || (transfer === "offered" && !hasTransferWaitInstruction(userText))) {
    return { ...state, stage: "waiting_for_transfer", gatekeeperRequestMade: true };
  }
  if (isGatekeeperUnavailable(userText)) {
    return { ...state, stage: "gatekeeper", gatekeeperRequestMade: true };
  }
  if (classification === "queue") return { ...state, stage: "waiting_for_transfer" };
  if (state.stage === "gatekeeper" && state.gatekeeperRequestMade && acceptsTransferRequest(userText)) {
    return { ...state, stage: "waiting_for_transfer" };
  }
  if (state.stage === "waiting_for_transfer" && !identifiesDecisionMaker(userText, state.targetName) && !isHumanContactAfterQueue(userText)) {
    return state;
  }
  if (state.stage === "awaiting_contact" && !identifiesDecisionMaker(userText, state.targetName)
    && !isClearlyGatekeeper(userText, state.targetName) && !isHumanContactAfterQueue(userText)
    && !isShortHumanAnswer(userText, classification)) {
    return state;
  }
  if (state.stage === "confirming_decision_maker") {
    return confirmsDecisionMaker(userText)
      ? { ...state, stage: "decision_maker" }
      : { ...state, stage: "gatekeeper" };
  }
  if (state.stage === "gatekeeper") return state;
  if (classification === "human") {
    return {
      ...state,
      gatekeeperRequestMade: state.stage === "waiting_for_transfer" ? false : state.gatekeeperRequestMade,
      gatekeeperReasonGiven: state.stage === "waiting_for_transfer" ? false : state.gatekeeperReasonGiven,
      awaitingAvailabilityAnswer: state.stage === "waiting_for_transfer" ? false : state.awaitingAvailabilityAnswer,
      availabilityFollowUpAsked: state.stage === "waiting_for_transfer" ? false : state.availabilityFollowUpAsked,
      stage: isClearlyGatekeeper(userText, state.targetName) ? "gatekeeper" : "confirming_decision_maker",
    };
  }
  return state;
}

export function instructionForContactRouting(state: ContactRoutingState): string {
  switch (state.stage) {
    case "awaiting_contact":
      return state.targetName
        ? `Stelle dich kurz transparent vor und frage ausschließlich nach ${state.targetName}. Noch kein Fachgespräch.`
        : "Stelle dich kurz transparent vor und frage ausschließlich nach der zuständigen Person. Noch kein Fachgespräch.";
    case "confirming_decision_maker":
      return state.targetName
        ? `Die Person könnte ${state.targetName} sein, aber die Namenszuordnung ist nicht sicher. Frage genau einmal höflich, ob du ${state.targetName} am Apparat hast. Bei Zustimmung beginne mit der regulären Eröffnung. Reagiere bei Nein auf die konkrete Antwort; ein Weiterleitungsangebot bestätigst du kurz statt erneut darum zu bitten. Noch kein Fachgespräch.`
        : "Die Zuständigkeit ist nicht sicher. Frage genau einmal höflich, ob du die zuständige Ansprechperson am Apparat hast. Bei Zustimmung beginne mit der regulären Eröffnung. Reagiere sonst auf die konkrete Antwort und wiederhole kein Weiterleitungsangebot. Noch kein Fachgespräch.";
    case "gatekeeper":
      return state.gatekeeperRequestMade
        ? `Du hast bereits um die Verbindung mit ${state.targetName || "der zuständigen Person"} gebeten. Wiederhole die Bitte nicht und starte kein Fachgespräch. Reagiere kurz auf die konkrete Antwort. Bei einem Rückrufangebot und einer Frage nach der Nummer nenne nur eine ausdrücklich bereitgestellte Rückrufnummer. Wenn keine Nummer vorliegt, sage das ehrlich.`
        : state.targetName
          ? `Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich freundlich um die Verbindung mit ${state.targetName}. Wenn nach dem Grund gefragt wird, nenne nur die kurze thematische Einordnung. Noch kein PKV-Fachgespräch.`
        : "Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich um die Verbindung mit der zuständigen Person. Noch kein Fachgespräch.";
    case "waiting_for_transfer":
      return "Es läuft eine Weiterleitung oder Warteschleife. Sprich nicht und starte kein Fachgespräch. Warte auf die nächste menschliche Äußerung.";
    case "decision_maker":
      return "Der Entscheider ist bestätigt. Fahre mit dem fachlichen Gespräch fort.";
    case "voicemail":
      return "Eine Mailbox wurde erkannt. Starte kein Fachgespräch und vereinbare keinen Termin.";
  }
}