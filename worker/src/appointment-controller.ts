import { assessPkvConversation, instructionForPkvStage, type ConversationTurn } from "./pkv-conversation-controller.js";

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
export type AppointmentMode = "Beim Kunden vor Ort" | "In der Agentur" | "Microsoft Teams";

export type AppointmentDecision =
  | { ok: true; preference: AppointmentPreference; slotPhrase: string }
  | { ok: false; error: "conversation_not_ready" | "missing_slot_phrase" | "slot_not_offered"; instruction: string };

function normalizeSlot(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-zäöüß0-9:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectAppointmentPreference(turns: ConversationTurn[]): AppointmentPreference {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    if (/\b(?:vormittag|vormittags|morgens|früh)\b/i.test(turn.text)) return "morning";
    if (/\b(?:nachmittag|nachmittags|mittags|später)\b/i.test(turn.text)) return "afternoon";
  }
  return "unknown";
}

export function detectAppointmentMode(turns: ConversationTurn[]): AppointmentMode | undefined {
  const latestUserText = [...turns].reverse().find((turn) => turn.role === "user")?.text || "";
  if (/\b(?:teams|video(?:termin|call)?|online)\b/i.test(latestUserText)) return "Microsoft Teams";
  if (/\b(?:in\s+(?:ihrer|eurer|der)\s+agentur|zu\s+ihnen\s+in\s+die\s+agentur|bei\s+(?:ihnen|euch|herrn\s+duic))\b/i.test(latestUserText)) return "In der Agentur";
  if (/\b(?:bei\s+mir|bei\s+uns|zu\s+hause|in\s+meinem\s+betrieb|bei\s+mir\s+vor\s+ort)\b/i.test(latestUserText)) return "Beim Kunden vor Ort";
  return undefined;
}

export function isSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): boolean {
  return Boolean(findSuppliedAppointmentSlot(freeSlotsPrompt, phrase));
}

export function findSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): string | undefined {
  const normalizedPhrase = normalizeSlot(phrase);
  const offeredText = normalizeSlot(freeSlotsPrompt || "");
  if (normalizedPhrase.length > 10 && offeredText.includes(normalizedPhrase)) return phrase.trim();

  const weekdayMatch = normalizedPhrase.match(/\b(montag|dienstag|mittwoch|donnerstag|freitag)\b/i)?.[1];
  const time = normalizedPhrase.match(/\b(?:um\s*)?(\d{1,2})(?::|\s+uhr\s*)(\d{2})?\b/);

  if (weekdayMatch && !time) {
    const offeredLines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
    const match = offeredLines.find((line) => normalizeSlot(line).includes(weekdayMatch.toLowerCase()));
    if (match) return match;
  }

  if (!time) return undefined;
  const day = normalizedPhrase.match(/\b(\d{1,2})\.?\b/)?.[1];
  const offeredLines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  return offeredLines.find((line) => {
    const normalizedLine = normalizeSlot(line);
    const lineHour = normalizedLine.match(/\b(?:um\s*)?(\d{1,2}):?(\d{2})\s*uhr\b/)?.[1];
    return (!weekdayMatch || normalizedLine.includes(weekdayMatch.toLowerCase()))
      && (!day || new RegExp(`\\b${day}\\.?\\b`).test(normalizedLine))
      && lineHour === time[1]
      && (!time[2] || normalizedLine.includes(`:${time[2]}`));
  });
}

export function appointmentOfferInstruction(freeSlotsPrompt: string | undefined, preference: AppointmentPreference): string | undefined {
  const lines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter((line) => /\b(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag)\b/i.test(line));
  const preferred = lines.filter((line) => preference === "morning" ? /\bum\s+(?:0?9|1[0-2]):/i.test(line) : /\bum\s+(?:1[3-8]):/i.test(line));
  const choices = (preferred.length >= 2 ? preferred : lines).slice(0, 2);
  if (choices.length < 2) return undefined;
  return `Biete jetzt ausschließlich diese zwei echten freien Termine an: ${choices[0]} oder ${choices[1]}. Frage, welcher Termin besser passt. Erfinde keine gekürzten oder anderen Termine.`;
}

export function decideAppointment(params: {
  turns: ConversationTurn[];
  topicKind: "pkv" | "other";
  freeSlotsPrompt?: string;
  slotPhrase?: string;
}): AppointmentDecision {
  if (params.topicKind === "pkv") {
    const assessment = assessPkvConversation(params.turns);
    if (assessment.stage !== "ready_to_schedule") {
      return {
        ok: false,
        error: "conversation_not_ready",
        instruction: instructionForPkvStage(assessment),
      };
    }
  }

  const slotPhrase = params.slotPhrase?.trim() || "";
  const latestUserText = [...params.turns].reverse().find((turn) => turn.role === "user")?.text.trim() || "";
  const assistantText = params.turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text).join(" ");
  const confirmationWasAsked = /(?:meinen\s+sie|passt\s+der|ist\s+das\s+so|richtig\s+verstanden)[^.?!]*(?:uhr|termin|donnerstag|freitag|montag|dienstag|mittwoch)/i.test(assistantText);
  const explicitConfirmation = /^(?:ja\b|ja[, ]+das passt|das passt|passt|genau|richtig|genau richtig|bestätigt|einverstanden|nehme ich|der passt|diesen nehme ich)\b/i.test(latestUserText)
    || /\b(?:montag|dienstag|mittwoch|donnerstag|freitag)\b[^.!?]{0,20}\b(?:passt|passt\s+gut|gut\s+so|stimmt|klingt\s+gut|besser)\b/i.test(latestUserText);
  if (confirmationWasAsked && !explicitConfirmation) {
    return {
      ok: false,
      error: "conversation_not_ready",
      instruction: "Die Terminrückfrage ist noch nicht eindeutig bestätigt. Frage nur kurz, ob der konkret genannte Termin so passt.",
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