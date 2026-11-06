export type CallbackStage = "inactive" | "asking_time" | "asked_again" | "done";

export type CallbackNumberStage = "waiting_for_ready" | "waiting_for_confirmation" | "waiting_for_repeat_confirmation";
export type CallbackNumberReply = "wait" | "repeat" | "finish" | "other";

const CALLBACK_NUMBER = "(?:telefonnummer|telefon-?nummer|rufnummer|rückrufnummer|rueckrufnummer|mobilnummer|handynummer|durchwahl|nummer)";

export function isCallbackNumberRequest(text: string): boolean {
  if (!new RegExp(`\\b${CALLBACK_NUMBER}\\b`, "i").test(text)
    || new RegExp(`\\b(?:keine|keinen)\\s+${CALLBACK_NUMBER}\\b`, "i").test(text)) return false;

  const mentionsTheirNumber = new RegExp(`\\b(?:meine|meinen|unsere|unseren)\\s+${CALLBACK_NUMBER}\\b`, "i").test(text);
  const mentionsOurNumber = new RegExp(`\\b(?:ihre|ihren|ihrer|eure|euren)\\s+${CALLBACK_NUMBER}\\b`, "i").test(text);
  const offersTheirNumber = new RegExp(`\\b(?:ich|wir)\\s+(?:(?:kann|können|möchte|möchten|würde|würden)\\s+)?(?:(?:gebe|geben|nenne|nennen|sage|sagen)\\s+)?(?:ihnen|euch)\\s+(?:(?:eine?|die|meine|unsere)\\s+)?${CALLBACK_NUMBER}\\b`, "i").test(text);
  if ((mentionsTheirNumber || offersTheirNumber) && !mentionsOurNumber) return false;

  return new RegExp(`\\b(?:unter\\s+welcher|welche[rmn]?)\\s+${CALLBACK_NUMBER}\\b`, "i").test(text)
    || new RegExp(`\\b${CALLBACK_NUMBER}\\b[\\s\\S]{0,100}\\b(?:hinterlassen|geben|durchgeben|nennen|sagen|mitteilen|aufschreiben|notieren|weitergeben|erreichen|wiederholen)\\b`, "i").test(text)
    || new RegExp(`\\b(?:hinterlassen|geben|durchgeben|nennen|sagen|mitteilen|aufschreiben|notieren|weitergeben|bekommen|haben)\\b[\\s\\S]{0,100}\\b${CALLBACK_NUMBER}\\b`, "i").test(text)
    || (mentionsOurNumber && /\b(?:wie|bitte|kann|können|könnte|könnten|darf|dürfen|hätte|hätten|lautet)\b|\?/i.test(text));
}

export function classifyCallbackDirection(text: string): "incoming" | "outgoing" | undefined {
  const outgoing = [
    /\b(?:rufen|melden)\s+sie\b[\s\S]{0,100}\b(?:zurück|nochmal|erneut|an|später|morgen)\b/gi,
    /\b(?:können|könnten|würden|werden|sollen)\s+sie\b[\s\S]{0,100}\b(?:zurückrufen|anrufen|melden)\b/gi,
    /\bsie\s+(?:können|könnten|sollen)\b[\s\S]{0,100}\b(?:zurückrufen|anrufen|melden)\b/gi,
  ];
  if (outgoing.some((pattern) => [...text.matchAll(pattern)]
    .some((match) => !/\b(?:ich|wir|er|sie)\s*$/i.test(text.slice(0, match.index))))) return "outgoing";

  const subject = "(?:ich|wir|er|sie|(?:herr|frau)\\s+[\\p{L}-]+)";
  const incoming = new RegExp(
    `\\b(?:(?:ich\\s+rufe|wir\\s+rufen|(?:er|sie|(?:herr|frau)\\s+[\\p{L}-]+)\\s+ruft)|(?:wird|werde|werden)\\s+${subject}|${subject}\\s+(?:wird|werde|werden))\\b[\\s\\S]{0,100}\\b(?:zurück|zurückrufen)\\b`,
    "iu",
  );
  return incoming.test(text) ? "incoming" : undefined;
}

export function formatCallbackPhoneForSpeech(phone?: string): string | undefined {
  const normalized = phone?.trim();
  if (!normalized || !/^\+[1-9]\d{7,14}$/.test(normalized)) return undefined;
  const digitWords = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
  const digits = [...normalized.slice(1)].map((digit) => digitWords[Number(digit)]);
  const groups = [digits.slice(0, 2).join(" ")];
  for (let index = 2; index < digits.length; index += 3) {
    groups.push(digits.slice(index, index + 3).join(" "));
  }
  return `plus ${groups.join(", ")}`;
}

export function needsTimeToWriteCallbackNumber(text: string): boolean {
  return /\b(?:einen\s+(?:moment|augenblick)|warten\s+sie|ich\s+(?:(?:muss|möchte|will)\s+)?(?:erst\s+)?(?:einen\s+)?(?:stift|zettel)\s+(?:holen|suchen)|(?:noch\s+)?nicht\s+bereit)\b/i.test(text);
}

export function classifyCallbackNumberReply(text: string, stage: CallbackNumberStage): CallbackNumberReply {
  const normalized = text.trim();
  if (needsTimeToWriteCallbackNumber(normalized)) return "wait";
  if (/\b(?:wiederholen|wiederhole|noch\s+einmal|nochmal|noch\s+mal|wie\s+bitte|langsamer|nicht\s+verstanden|nicht\s+mitbekommen|nicht\s+vollständig)\b/i.test(normalized)) return "repeat";
  const yes = /^(?:ja|genau|richtig|klar|okay|ok|gerne|bitte|bereit)(?:[.!?,\s]|$)/i.test(normalized);
  const no = /^(?:nein|ne|nö)(?:[.!?,\s]|$)/i.test(normalized);
  if (stage === "waiting_for_ready") {
    return yes || /\b(?:ich\s+bin|bin\s+jetzt|jetzt\s+bin\s+ich)\s+bereit\b/i.test(normalized) ? "repeat" : "other";
  }
  if (stage === "waiting_for_repeat_confirmation") {
    if (yes) return "repeat";
    if (no) return "finish";
  } else if (no) {
    return "repeat";
  }
  if (yes || /\b(?:danke|vielen\s+dank|notiert|aufgeschrieben|habe\s+(?:ich|sie)|gebe\s+(?:ich|es|sie|das)|ruft\s+(?:sie\s+)?zurück)\b/i.test(normalized)) {
    return "finish";
  }
  return "other";
}

const NO_TIME_PATTERNS: RegExp[] = [
  /\bkeine\s+zeit\b/i,
  /\b(?:gerade|grade|jetzt|im\s+moment|momentan|aktuell|heute)\s+(?:ist\s+es\s+|passt\s+es\s+|ist'?s\s+|passt'?s\s+|wird\s+es\s+)?(?:leider\s+|eher\s+|ganz\s+|sehr\s+|echt\s+)?(?:schlecht|ungünstig|unpassend|stressig)\b/i,
  /\b(?:passt|geht|kann)\s+(?:es\s+)?(?:mir\s+|ich\s+)?(?:gerade|grade|jetzt|im\s+moment|momentan)\s+(?:leider\s+)?(?:nicht|schlecht|ungünstig)\b/i,
  /\b(?:gerade|grade|jetzt|im\s+moment|momentan)\s+(?:passt|geht)\s+(?:es\s+)?(?:leider\s+)?(?:nicht|schlecht)\b/i,
  /\bbin\s+(?:gerade\s+|grade\s+|jetzt\s+|leider\s+)*(?:in\s+einem\s+(?:termin|meeting|gespräch|kundengespräch)|im\s+(?:termin|meeting|auto|urlaub)|beim\s+kunden|unterwegs|beschäftigt|eingespannt)\b/i,
  /\bmuss\s+(?:gleich|sofort|jetzt)\s+(?:weg|los)\b/i,
  /\b(?:rufen|melden)\s+sie\s+(?:mich\s+|sich\s+)?(?:bitte\s+|gerne\s+|gern\s+|doch\s+)?(?:später|morgen|übermorgen|nächste\s+woche|ein\s+anderes\s+mal|in\s+\S+\s+(?:minuten|stunden?|tagen?))\b/i,
];

const SLOT_CONTEXT = /\b(?:vormittag|nachmittag|uhr|montag|dienstag|mittwoch|donnerstag|freitag|samstag|termin|persönlich\s+oder\s+digital)\b/i;

export function isNoTimeRequest(text: string, previousAssistantText = ""): boolean {
  if (SLOT_CONTEXT.test(previousAssistantText) && !/\bpasst\s+es\s+(?:gerade|jetzt)\b/i.test(previousAssistantText)) return false;
  return NO_TIME_PATTERNS.some((pattern) => pattern.test(text));
}

const WEEKDAY = "montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag";
const NUMBER_WORD = "ein|einer|eine|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|zwanzig|dreißig|fünfzehn|halben|viertel";
const TIME_PARTS: RegExp[] = [
  /\b(?:heute|morgen|übermorgen)\b/gi,
  new RegExp(`\\b(?:(?:am|nächsten|kommenden|diesen)\\s+)?(?:${WEEKDAY})(?:s)?\\b`, "gi"),
  /\b(?:(?:in\s+der\s+)?(?:nächsten|kommenden)\s+woche|nächste\s+woche|ende\s+der\s+woche|anfang\s+(?:der\s+)?nächste[nr]?\s+woche|nach\s+dem\s+wochenende)\b/gi,
  /\b(?:(?:am|früh\s+am)\s+)?(?:vormittag|nachmittag|mittag|abend|morgen\s+früh|früh)s?\b/gi,
  new RegExp(`\\b(?:(?:so\\s+)?(?:gegen|um|ab|nach|vor|bis)\\s+)?(?:\\d{1,2}(?:[:.]\\d{2})?|${NUMBER_WORD})\\s+uhr(?:\\s+(?:\\d{1,2}|dreißig|fünfzehn|fünfundvierzig))?\\b`, "gi"),
  /\b(?:(?:so\s+)?(?:gegen|um|ab|nach)\s+)\d{1,2}(?:[:.]\d{2})?\b/gi,
  new RegExp(`\\bin\\s+(?:\\d{1,3}|${NUMBER_WORD})(?:\\s+(?:halben\\s+)?)?\\s*(?:minuten|stunden?|stunde|tagen?|wochen?)\\b`, "gi"),
  /\bin\s+(?:einer\s+)?(?:halben\s+stunde|viertelstunde|stunde)\b/gi,
  /\b(?:später|nachher)\b/gi,
];

const NEGATED_AFTER = /^[^.?!;,]{0,28}?\b(?:schlecht|ungünstig|unpassend|stressig|nicht|keine\s+zeit|kann\s+ich\s+nicht)\b/i;
const VAGUE_PHRASE = /^(?:später|nachher)$/i;

export function extractCallbackTimePhrase(text: string): string | undefined {
  const spans: Array<[number, number]> = [];
  for (const pattern of TIME_PARTS) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
      const end = match.index + match[0].length;
      // "Heute ist es schlecht" / "Morgen geht nicht" names a time that does NOT work.
      if (NEGATED_AFTER.test(text.slice(end)) && !/\b(?:gut|gerne?|passt\s+(?:gut|mir)|ginge)\b/i.test(text.slice(end, end + 28))) continue;
      spans.push([match.index, end]);
    }
  }
  if (!spans.length) return undefined;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const groups: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = groups.at(-1);
    if (last && start <= last[1] + 6 && /^[\s,]*(?:und|so|also|oder\s+so)?[\s,]*$/i.test(text.slice(last[1], Math.max(start, last[1])))) {
      last[1] = Math.max(last[1], end);
    } else {
      groups.push([start, end]);
    }
  }
  const best = groups.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
  let phrase = text.slice(best[0], best[1]).replace(/\s+/g, " ").trim();
  if (!phrase) return undefined;
  if (/^(?:später|nachher|gleich)$/i.test(phrase)) phrase = phrase.toLowerCase();
  phrase = phrase.replace(/^(Gegen|Um|Ab|Nach|Vor|Bis|In|Am|So|Heute|Morgen|Übermorgen|Nächste|Nächsten|Kommenden|Ende|Anfang)\b/, (word) => word.toLowerCase());
  if (new RegExp(`^(?:${WEEKDAY})s?\\b`, "i").test(phrase)) phrase = `am ${phrase}`;
  if (/^(?:vormittag|nachmittag|mittag|abend)\b/i.test(phrase)) phrase = `am ${phrase}`;
  if (/^\d/.test(phrase)) phrase = `um ${phrase}`;
  return phrase;
}

export function callbackTimeQuestion(): string {
  return "Kein Problem. Wann passt es Ihnen besser?";
}

export function callbackTimeFollowUpQuestion(): string {
  return "Wann darf ich mich wieder bei Ihnen melden, zum Beispiel morgen oder nächste Woche?";
}

export function callbackFarewell(timePhrase?: string): string {
  const when = timePhrase?.trim() ? ` wie besprochen ${timePhrase.trim()}` : " zu einem späteren Zeitpunkt";
  return `Vielen Dank für das Gespräch. Dann melde ich mich${when} noch einmal bei Ihnen. Einen schönen Tag noch und auf Wiederhören.`;
}

export type CallbackStep = { stage: CallbackStage; speech: string; hangup: boolean };

export function advanceCallback(stage: CallbackStage, text: string): CallbackStep {
  const timePhrase = extractCallbackTimePhrase(text);
  if (timePhrase && !(stage === "inactive" && VAGUE_PHRASE.test(timePhrase))) {
    return { stage: "done", speech: callbackFarewell(timePhrase), hangup: true };
  }
  if (stage === "inactive") return { stage: "asking_time", speech: callbackTimeQuestion(), hangup: false };
  if (stage === "asking_time" && !/\b(?:egal|wann\s+sie\s+wollen|irgendwann|wie\s+sie\s+möchten)\b/i.test(text)) {
    return { stage: "asked_again", speech: callbackTimeFollowUpQuestion(), hangup: false };
  }
  return { stage: "done", speech: callbackFarewell(), hangup: true };
}
