import { parseSlotPhraseToIso } from "./finalize.js";

type ConversationTurn = { role: "user" | "assistant"; text: string };

export function convertSlotPhraseForSpeech(slotPhrase: string): string {
  const hourWords = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig"];
  const minuteWords = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig", "vierundzwanzig", "fünfundzwanzig", "sechsundzwanzig", "siebenundzwanzig", "achtundzwanzig", "neunundzwanzig", "dreißig", "einunddreißig", "zweiunddreißig", "dreiunddreißig", "vierunddreißig", "fünfunddreißig", "sechsunddreißig", "siebenunddreißig", "achtunddreißig", "neununddreißig", "vierzig", "einundvierzig", "zweiundvierzig", "dreiundvierzig", "vierundvierzig", "fünfundvierzig", "sechsundvierzig", "siebenundvierzig", "achtundvierzig", "neunundvierzig", "fünfzig", "einundfünfzig", "zweiundfünfzig", "dreiundfünfzig", "vierundfünfzig", "fünfundfünfzig", "sechsundfünfzig", "siebenundfünfzig", "achtundfünfzig", "neunundfünfzig"];

  let result = slotPhrase;
  result = result.replace(/\b(um\s+)?(\d{1,2}):(\d{2})\s*(?:Uhr)?/gi, (match, prefix, hourStr, minuteStr) => {
    const hour = Number.parseInt(hourStr, 10);
    const minute = Number.parseInt(minuteStr, 10);
    const hourWord = hourWords[hour % 24] || String(hour);
    const spokenPrefix = /\bum\b/i.test(match) ? "um " : "";
    if (minute === 0) return `${spokenPrefix}${hourWord} Uhr`;
    const minuteWord = minuteWords[minute] || String(minute);
    return `${spokenPrefix}${hourWord} Uhr ${minuteWord}`;
  });

  return result;
}
export type AppointmentPreference = "morning" | "afternoon" | "unknown";
export type AppointmentMode = "Beim Kunden vor Ort" | "Microsoft Teams";

export type AppointmentDecision =
  | { ok: true; preference: AppointmentPreference; slotPhrase: string }
  | { ok: false; error: "conversation_not_ready" | "missing_slot_phrase" | "slot_not_offered"; instruction: string };

function mentionsConcreteSlot(text: string): boolean {
  return /\b(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)\b/i.test(text)
    || /\b\d{1,2}:\d{2}\b/.test(text)
    || /\b\d{1,2}\.\s*(?:januar|februar|m[äa]rz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i.test(text)
    || /\berste[rn]?\b|\bzweite[rn]?\b/.test(text);
}

function rejectsBothOfferedSlots(text: string): boolean {
  return /\b(?:beide|beiden|keiner|keinen\s+von\s+beiden|weder\s+noch|passt\s+keiner|passen\s+beide\s+nicht|beide\s+nicht)\b/i.test(text);
}

function normalizeSlot(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-zäöüß0-9:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type ChoiceClause = { text: string; question: boolean; preferred: boolean };
type AppointmentModeSignal = {
  mode?: AppointmentMode;
  mentioned: boolean;
  question: boolean;
};

function splitChoiceClauses(text: string): ChoiceClause[] {
  const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
  return sentences.flatMap((sentence) => {
    const question = sentence.includes("?");
    const clauses: ChoiceClause[] = [];
    const separators = /[,;]|\b(?:aber|sondern|stattdessen|lieber|eher)\b/gi;
    let start = 0;
    let preferred = false;
    for (const match of sentence.matchAll(separators)) {
      const clause = sentence.slice(start, match.index).trim();
      if (clause) {
        clauses.push({
          text: clause,
          question,
          preferred: preferred || /\b(?:am\s+liebsten|bevorzugt)\b/i.test(clause),
        });
      }
      preferred = /\b(?:sondern|stattdessen|lieber|eher)\b/i.test(match[0]);
      start = match.index + match[0].length;
    }
    const clause = sentence.slice(start).trim();
    if (clause) {
      clauses.push({
        text: clause,
        question,
        preferred: preferred || /\b(?:am\s+liebsten|bevorzugt)\b/i.test(clause),
      });
    }
    return clauses;
  });
}

function isNegatedChoice(text: string): boolean {
  const normalized = text.replace(/\bnicht\s+nur\b/i, "nur");
  return /\b(?:nicht|kein(?:e|en|er|em|es)?|niemals|keinesfalls|weder)\b/i.test(normalized);
}

function analyzeAppointmentPreference(text: string): { value?: "morning" | "afternoon"; mentioned: boolean } {
  const candidates: Array<{ value: "morning" | "afternoon"; index: number; preferred: boolean }> = [];
  const negated: Array<{ value: "morning" | "afternoon"; index: number }> = [];
  let mentioned = false;

  splitChoiceClauses(text).forEach((clause, index) => {
    const values: Array<"morning" | "afternoon"> = [];
    if (/\b(?:vormittag|vormittags|morgens|früh)\b/i.test(clause.text)) values.push("morning");
    if (/\b(?:nachmittag|nachmittags|mittags|später)\b/i.test(clause.text)) values.push("afternoon");
    if (values.length === 0) return;
    mentioned = true;
    if (clause.question) return;
    if (isNegatedChoice(clause.text)) {
      for (const value of values) negated.push({ value, index });
      return;
    }
    for (const value of values) candidates.push({ value, index, preferred: clause.preferred });
  });

  const active = candidates.filter((candidate) =>
    !negated.some((entry) => entry.value === candidate.value && entry.index > candidate.index));
  const values = new Set(active.map((candidate) => candidate.value));
  if (values.size === 1) return { value: active[0].value, mentioned };
  const preferredValues = new Set(active.filter((candidate) => candidate.preferred).map((candidate) => candidate.value));
  return { value: preferredValues.size === 1 ? [...preferredValues][0] : undefined, mentioned };
}

function analyzeAppointmentMode(text: string): AppointmentModeSignal {
  const mentioned = /\b(?:digital|online|teams|video(?:termin|call)?|persönlich|persoenlich|vor\s+ort|agentur)\b/i.test(text);
  const question = /\?/.test(text) && mentioned;
  const candidates: Array<{ value: AppointmentMode; index: number; preferred: boolean }> = [];
  const negated: Array<{ value: AppointmentMode; index: number }> = [];

  splitChoiceClauses(text).forEach((clause, index) => {
    const values: AppointmentMode[] = [];
    const inPerson = !/\bagentur\b/i.test(clause.text) && /\b(?:persönlich|persoenlich|vor\s+ort|bei\s+(?:mir|uns)(?=\s*[.!?,]|$)|zu\s+(?:mir|uns)(?=\s*[.!?,]|$)|zu\s+(?:mir|uns)\s+(?:kommen|nach\s+hause)|(?:bei|in)\s+(?:meinem|unserem|meiner|unserer)\s+(?:betrieb|büro|firma)|bei\s+(?:mir|uns)\s+im\s+(?:büro|betrieb))\b/i.test(clause.text);
    if (inPerson) values.push("Beim Kunden vor Ort");
    if (/\b(?:digital|online|teams|video(?:termin|call)?)\b/i.test(clause.text)) values.push("Microsoft Teams");
    if (values.length === 0 || clause.question) return;
    if (isNegatedChoice(clause.text)) {
      for (const value of values) negated.push({ value, index });
      return;
    }
    for (const value of values) candidates.push({ value, index, preferred: clause.preferred });
  });

  const active = candidates.filter((candidate) =>
    !negated.some((entry) => entry.value === candidate.value && entry.index > candidate.index));
  const preferredValues = new Set(active.filter((candidate) => candidate.preferred).map((candidate) => candidate.value));
  const values = preferredValues.size === 1
    ? preferredValues
    : new Set(active.map((candidate) => candidate.value));
  if (values.size !== 1) return { mentioned, question };
  return { mode: [...values][0], mentioned, question };
}

export function appointmentModeFollowUp(text: string): string {
  const signal = analyzeAppointmentMode(text);
  if (signal.question) {
    return "Digital bedeutet eine Beratung per Microsoft Teams, persönlich bedeutet, dass der Berater zu Ihnen kommt. Was ist Ihnen lieber?";
  }
  return "Soll der Termin persönlich oder digital stattfinden?";
}

export function detectAppointmentPreference(turns: ConversationTurn[]): AppointmentPreference {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    const signal = analyzeAppointmentPreference(turn.text);
    if (signal.mentioned) return signal.value || "unknown";
  }
  return "unknown";
}

export function detectAppointmentMode(turns: ConversationTurn[]): AppointmentMode | undefined {
  const latestUserTurn = [...turns].reverse().find((turn) => turn.role === "user");
  return latestUserTurn ? analyzeAppointmentMode(latestUserTurn.text).mode : undefined;
}

export function isSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): boolean {
  return Boolean(findSuppliedAppointmentSlot(freeSlotsPrompt, phrase));
}

export function findSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): string | undefined {
  const normalizedPhrase = normalizeSlot(phrase);
  const offeredText = normalizeSlot(freeSlotsPrompt || "");
  if (normalizedPhrase.length > 10 && offeredText.includes(normalizedPhrase)) return phrase.trim();

  const offeredLines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  const requestedStart = parseSlotPhraseToIso(phrase);
  if (requestedStart) {
    return offeredLines.find((line) => parseSlotPhraseToIso(line) === requestedStart);
  }

  const weekdayMatch = normalizedPhrase.match(/\b(montag|dienstag|mittwoch|donnerstag|freitag)\b/i)?.[1];
  const time = normalizedPhrase.match(/\b(?:um\s*)?(\d{1,2})(?::|\s+uhr\s*)(\d{2})?\b/);

  if (weekdayMatch && !time) {
    const match = offeredLines.find((line) => normalizeSlot(line).includes(weekdayMatch.toLowerCase()));
    if (match) return match;
  }

  if (!time) return undefined;
  const day = normalizedPhrase.match(/\b(\d{1,2})\.?\b/)?.[1];
  return offeredLines.find((line) => {
    const normalizedLine = normalizeSlot(line);
    const lineHour = normalizedLine.match(/\b(?:um\s*)?(\d{1,2}):?(\d{2})\s*uhr\b/)?.[1];
    return (!weekdayMatch || normalizedLine.includes(weekdayMatch.toLowerCase()))
      && (!day || new RegExp(`\\b${day}\\.?\\b`).test(normalizedLine))
      && Number(lineHour) === Number(time[1])
      && (!time[2] || normalizedLine.includes(`:${time[2]}`));
  });
}

function slotTimeMinutes(line: string): number | undefined {
  const match = line.match(/\b(?:um\s+)?(\d{1,2}):(\d{2})\b/i);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function berlinCalendarDay(start: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(start));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day"));
}

export function getAppointmentOfferSlots(freeSlotsPrompt: string | undefined, preference: AppointmentPreference): string[] {
  if (preference === "unknown") return [];
  const minMinutes = preference === "morning" ? 8 * 60 + 30 : 13 * 60;
  const maxMinutes = preference === "morning" ? 11 * 60 : 18 * 60;
  const matching = (freeSlotsPrompt || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
    .filter((line) => /\b(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag)\b/i.test(line))
    .filter((line) => {
      const time = slotTimeMinutes(line);
      return time !== undefined && time >= minMinutes && time <= maxMinutes;
    });

  for (let first = 0; first < matching.length; first += 1) {
    const firstStart = parseSlotPhraseToIso(matching[first]);
    if (!firstStart) continue;
    for (let second = first + 1; second < matching.length; second += 1) {
      const secondStart = parseSlotPhraseToIso(matching[second]);
      if (!secondStart) continue;
      if (Math.abs(berlinCalendarDay(secondStart) - berlinCalendarDay(firstStart)) < 2 * 86_400_000) continue;
      if (slotTimeMinutes(matching[first]) === slotTimeMinutes(matching[second])) continue;
      if (matching[first].split(",")[0] === matching[second].split(",")[0]) continue;
      return [matching[first], matching[second]];
    }
  }
  return [];
}

export function matchOfferedAppointmentSelection(text: string, offeredSlots: string[]): string | undefined {
  if (offeredSlots.length < 2) return undefined;
  const normalized = normalizeSlot(text);
  if (/\b(?:der\s+)?(?:erste|ersten|erster|erstes|1\.?|erste[nr]?)\b/i.test(normalized)) return offeredSlots[0];
  if (/\b(?:der\s+)?(?:zweite|zweiten|zweiter|zweites|2\.?|zweite[nr]?)\b/i.test(normalized)) return offeredSlots[1];

  const exact = offeredSlots.find((slot) => normalized.includes(normalizeSlot(slot)));
  if (exact) return exact;
  const weekday = normalized.match(/\b(montag|dienstag|mittwoch|donnerstag|freitag)\b/i)?.[1];
  if (weekday) return offeredSlots.find((slot) => normalizeSlot(slot).includes(weekday));
  const time = normalized.match(/\b(\d{1,2}):(\d{2})\b/);
  if (time) {
    return offeredSlots.find((slot) => {
      const slotTime = slot.match(/\b(\d{1,2}):(\d{2})\b/);
      return slotTime?.[1] === time[1] && slotTime[2] === time[2];
    });
  }
  return undefined;
}

// A short reply without a recognizable slot (e.g. garbled audio or a bare "Ja") must not be guessed by the model.
function isUnclearSlotSelection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("?") || rejectsBothOfferedSlots(trimmed)) return false;
  if (/\b(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|woche|monat|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|uhr|morgen|übermorgen|später|anderen?|nein|nicht|kein\w*)\b|\d/i.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= 5;
}

export type AppointmentRoutingState = {
  appointmentOfferedSlots?: string[];
  selectedAppointmentSlot?: string;
  appointmentMode?: AppointmentMode;
};

export function advanceAppointmentRouting(
  state: AppointmentRoutingState,
  turns: ConversationTurn[],
  freeSlotsPrompt?: string,
): { state: AppointmentRoutingState; speechText?: string; readyToBook?: boolean } {
  const latestUser = [...turns].reverse().find((turn) => turn.role === "user")?.text || "";
  const lastAssistant = [...turns].reverse().find((turn) => turn.role === "assistant")?.text || "";
  const modeSignal = analyzeAppointmentMode(latestUser);
  const mode = modeSignal.mode;
  if (state.selectedAppointmentSlot) {
    if (mode) return { state: { ...state, appointmentMode: mode }, readyToBook: true };
    if (modeSignal.mentioned) {
      return {
        state: { ...state, appointmentMode: undefined },
        speechText: appointmentModeFollowUp(latestUser),
      };
    }
    return { state: { ...state, appointmentMode: undefined } };
  }
  if (state.appointmentOfferedSlots?.length) {
    const selected = matchOfferedAppointmentSelection(latestUser, state.appointmentOfferedSlots);
    if (!selected) {
      if (!isUnclearSlotSelection(latestUser)) return { state };
      const [first, second] = state.appointmentOfferedSlots;
      return {
        state,
        speechText: `Entschuldigung, das habe ich nicht genau verstanden. Passt Ihnen eher ${first} oder ${second}?`,
      };
    }
    const nextState = { ...state, selectedAppointmentSlot: selected, appointmentMode: mode };
    if (mode) return { state: nextState, readyToBook: true };
    return {
      state: nextState,
      speechText: modeSignal.mentioned ? appointmentModeFollowUp(latestUser) : appointmentModeFollowUp(""),
    };
  }
  if (!/\b(?:vormittags?|nachmittags?)\b/i.test(lastAssistant) || !/termin/i.test(lastAssistant)) return { state };
  const preference = detectAppointmentPreference([{ role: "user", text: latestUser }]);
  const choices = getAppointmentOfferSlots(freeSlotsPrompt, preference);
  if (preference === "unknown") return { state };
  if (choices.length < 2) return {
    state,
    speechText: "Für diesen Zeitraum finde ich gerade keine zwei freien Termine mit ausreichend Abstand und unterschiedlichen Uhrzeiten. Käme für Sie auch ein anderer Zeitraum infrage?",
  };
  return {
    state: { ...state, appointmentOfferedSlots: choices, appointmentMode: mode },
    speechText: `Ich kann Ihnen ${choices[0]} oder ${choices[1]} anbieten. Welcher Termin passt Ihnen besser?`,
  };
}

export function decideAppointment(params: {
  turns: ConversationTurn[];
  topicKind: "pkv" | "other";
  freeSlotsPrompt?: string;
  slotPhrase?: string;
}): AppointmentDecision {
  const slotPhrase = params.slotPhrase?.trim() || "";
  const latestUserText = [...params.turns].reverse().find((turn) => turn.role === "user")?.text.trim() || "";
  const recentUserTurns = [...params.turns].filter((turn) => turn.role === "user").slice(-4);
  const assistantText = params.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text).join(" ");
  const askedForConcreteSelection = /welcher\s+termin\s+passt\s+ihnen\s+besser|welcher\s+termin\s+passt\s+ihnen|welcher\s+passt\s+ihnen\s+besser/i.test(assistantText);
  const userNamedConcreteSlot = mentionsConcreteSlot(latestUserText);
  const recentUserNamedConcreteSlot = recentUserTurns.some((turn) => mentionsConcreteSlot(turn.text));
  const userRejectedBothSlots = rejectsBothOfferedSlots(latestUserText);
  const confirmationWasAsked = /(?:meinen\s+sie|passt\s+der|ist\s+das\s+so|richtig\s+verstanden)[^.?!]*(?:uhr|termin|donnerstag|freitag|montag|dienstag|mittwoch)/i.test(assistantText);
  const explicitConfirmation = /^(?:ja\b|ja[, ]+das passt|das passt|passt|genau|richtig|genau richtig|bestätigt|einverstanden|nehme ich|der passt|diesen nehme ich)\b/i.test(latestUserText)
    || /\b(?:montag|dienstag|mittwoch|donnerstag|freitag)\b[^.!?]{0,20}\b(?:passt|passt\s+gut|gut\s+so|stimmt|klingt\s+gut|besser)\b/i.test(latestUserText);
  if (userRejectedBothSlots) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Der Kunde lehnt beide angebotenen Slots ab. Frage jetzt exakt: 'Welchen Termin würden Sie vorschlagen?' und bestätige anschließend diesen genannten Termin.",
    };
  }
  if (askedForConcreteSelection && !recentUserNamedConcreteSlot) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Die Auswahl ist noch nicht eindeutig. Frage kurz: 'Meinen Sie den ersten oder den zweiten vorgeschlagenen Termin?' Bestätige erst nach klarer Zuordnung.",
    };
  }
  if (confirmationWasAsked && !explicitConfirmation && !recentUserNamedConcreteSlot) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Die Terminrückfrage ist noch nicht eindeutig bestätigt. Frage nur kurz, ob der konkret genannte Termin so passt.",
    };
  }
  if (!recentUserNamedConcreteSlot && !(confirmationWasAsked && explicitConfirmation)) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Bestätige keinen Termin, bevor die Kundin oder der Kunde einen konkreten vorgeschlagenen oder eigenen Zeitpunkt genannt hat.",
    };
  }
  if (/^(?:hallo|hallo\?|bitte\??|ja\?+|mhm|aha|okay\??|ok\??)[.!?]*$/i.test(latestUserText)) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Die letzte Kundenaussage war keine eindeutige Terminbestätigung. Frage kurz nach, welcher der angebotenen Termine gemeint ist, und bestätige erst nach einer klaren Auswahl.",
    };
  }
  if (!slotPhrase) {
    return {
      ok: false,
      error: "missing_slot_phrase",
      instruction: "Es fehlt ein eindeutig ausgewählter Termin.",
    };
  }

  const suppliedSlot = findSuppliedAppointmentSlot(params.freeSlotsPrompt, slotPhrase);
  if (!suppliedSlot) {
    // Check if Gloria already asked for the customer's own preferred time.
    // If so, accept any slot with a plausible date/time as customer-proposed.
    const gloriaAskedForCustomerSlot = /(?:welchen\s+termin\s+w[uü]rden\s+sie|welcher\s+termin\s+passt\s+f[uü]r\s+sie|welcher\s+w[aä]re\s+f[uü]r\s+sie|was\s+w[aä]re\s+f[uü]r\s+sie|nennen\s+sie\s+mir\s+einen\s+termin|machen\s+wir\s+einen\s+termin\s+nach\s+ihren\s+w[uü]nschen)/i.test(assistantText);
    const hasDateTime = /\b(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag)\b/i.test(slotPhrase)
      || /\b\d{1,2}\.\s*(?:januar|februar|m[aä]rz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i.test(slotPhrase)
      || /\b\d{1,2}:\d{2}\b/.test(slotPhrase);
    if (gloriaAskedForCustomerSlot && hasDateTime) {
      return { ok: true, preference: detectAppointmentPreference(params.turns), slotPhrase: slotPhrase.trim() };
    }
    return {
      ok: false,
      error: "slot_not_offered",
      instruction: "Dieser Termin steht nicht in der freien Slotliste und der Kunde wurde noch nicht nach seinem eigenen Wunschtermin gefragt. Biete zuerst die zwei freien Termine an. Falls keiner passt, frage: 'Welchen Termin würden Sie vorschlagen?'",
    };
  }

  return {
    ok: true,
    preference: detectAppointmentPreference(params.turns),
    slotPhrase: suppliedSlot,
  };
}