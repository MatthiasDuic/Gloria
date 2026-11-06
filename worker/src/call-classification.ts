export type CallClassification = "voicemail" | "queue" | "human" | "unknown";

const VOICEMAIL_PATTERNS: RegExp[] = [
  /anrufbeantworter/i,
  /(?:ihre?|die)\s+mailbox\b/i,
  /sie\s+(?:sind\s+)?(?:mit\s+)?(?:der\s+)?mailbox\b/i,
  /(?:sie\s+)?erreichen\s+(?:hier\s+)?(?:die\s+)?mailbox\b/i,
  /sie\s+haben\s+die\s+mailbox\s+von\b/i,
  /you\s+have\s+reached\s+(?:the\s+)?(?:voicemail|voice\s+mail|answering\s+machine)\b/i,
  /leave\s+(?:a\s+)?message\s+after\s+(?:the\s+)?(?:tone|beep)\b/i,
  /please\s+(?:leave|record)\s+(?:a\s+)?message\b/i,
  /(?:voicemail|answering\s+machine)\s+(?:of|for)\b/i,
  /hinterlassen\s+sie\s+(?:bitte\s+)?(?:eine\s+)?(?:nachricht|sprachnachricht)\b/i,
  /sprechen\s+sie\s+(?:bitte\s+)?(?:nach\s+(?:dem|dem\s+signalton|dem\s+piepton)|nach\s+dem\s+ton)\b/i,
  /nachricht(?:\s+nach)?\s+dem\s+(?:signalton|piepton|ton)\b/i,
  /(?:signalton|piepton)\s+abwart(?:en|et)/i,
  /^\s*[\[(]?(?:piep|beep|signalton|piepton)[\])\s.!?]*$/i,
  /teilnehmer\s+ist\s+(?:(?:zurzeit|momentan|derzeit)\s+)?nicht\s+erreichbar/i,
  /(?:unser\s+b[üu]ro|unsere\s+praxis|unser\s+gesch[äa]ft)[\s\S]{0,40}nicht\s+besetzt/i,
  /sind\s+vor[üu]bergehend\s+nicht\s+erreichbar/i,
  /(?:hinterlassen|aufzeichnen)\s+sie\s+(?:ihre\s+)?(?:nachricht|aufnahme)\b/i,
];

const QUEUE_PATTERNS: RegExp[] = [
  /^\s*(?:herzlich\s+)?willkommen\b/i,
  /(?:vielen\s+)?dank(?:e)?\s+f[üu]r\s+ihren\s+anruf/i,
  /ihr\s+anruf\s+ist\s+uns\s+wichtig/i,
  /^\s*[\[(]?\s*(?:musik|music|wartemusik|hold\s+music)\s*[\])]*[.!?\s]*$/i,
  /ich\s+verbinde(?:\s+sie\b(?![^.!?,;]{0,40}\b(?:nicht|nie)\b)|[.!?,\s]*$)/i,
  /sie\s+werden\s+(?:jetzt\s+)?(?:weiter)?verbunden/i,
  /ihre\s+verbindung\s+wird\s+(?:gehalten|hergestellt|weitergeleitet)/i,
  /ihr\s+anruf\s+wird\s+(?:weitergeleitet|verbunden|entgegengenommen)/i,
  /bleiben\s+sie\s+(?:bitte\s+)?(?:in\s+der\s+leitung|am\s+apparat)/i,
  /bitte\s+warten\s+sie/i,
  /einen\s+moment(?:\s+bitte)?/i,
  /einen\s+augenblick(?:\s+bitte)?/i,
  /warteschleife/i,
  /(?:alle|unsere)\s+(?:mitarbeiter|leitungen|gespr[äa]che)[\s\S]{0,70}(?:besetzt|im\s+gespr[äa]ch)/i,
  /(?:alle\s+)?mitarbeiter\s+sind\s+(?:zurzeit\s+)?(?:besetzt|belegt|im\s+gespr[äa]ch)/i,
  /(?:der|die)\s+n[äa]chste\s+freie\s+(?:mitarbeiter|ansprechpartner)/i,
  /bitte\s+haben\s+sie\s+(?:einen\s+)?(?:moment|augenblick)\s+geduld/i,
  /sie\s+befinden\s+sich\s+in\s+(?:unserer\s+)?warteschleife/i,
  /(?:vielen\s+dank|willkommen)\s+bei\b[\s\S]{0,90}\b(?:bitte\s+warten|moment\s+geduld|sie\s+werden\s+verbunden|ihren\s+anruf)\b/i,
  /(?:to\s+)?(?:continue|hold|remain)\s+(?:please\s+)?(?:press\s+\d|on\s+the\s+line)/i,
  /(?:dr[üu]cken|w[äa]hlen)\s+sie\s+(?:bitte\s+)?(?:die\s+)?(?:\d|eins|eins\s+bis\s+neun)\b/i,
];

// Digital receptionists greet like a queue but expect an answer ("Wie lautet Ihr Name und wie kann ich Ihnen helfen?").
const INTERACTIVE_ASSISTANT_PATTERNS: RegExp[] = [
  /wie\s+lautet\s+ihr\s+(?:name|anliegen)/i,
  /wie\s+kann\s+ich\s+ihnen\s+(?:weiter)?helfen/i,
  /was\s+kann\s+ich\s+f[üu]r\s+sie\s+tun/i,
  /(?:was\s+ist|worum\s+geht\s+es\s+bei)\s+ihr(?:em)?\s+anliegen/i,
  /(?:nennen|sagen)\s+sie\s+(?:mir\s+)?(?:bitte\s+)?(?:kurz\s+)?(?:ihren\s+namen|ihr\s+anliegen)/i,
  /mit\s+wem\s+(?:m[öo]chten|wollen)\s+sie\s+sprechen/i,
  /wer\s+(?:ruft|spricht|ist\s+am\s+apparat)\b/i,
  /wer\s+sind\s+sie\b|mit\s+wem\s+spreche\s+ich\b/i,
];

const HARD_QUEUE_PATTERNS: RegExp[] = [
  /bitte\s+warten\s+sie/i,
  /warteschleife/i,
  /(?:dr[üu]cken|w[äa]hlen)\s+sie\s+(?:bitte\s+)?(?:die\s+)?(?:\d|eins|zwei|drei)/i,
  /bleiben\s+sie\s+(?:bitte\s+)?(?:in\s+der\s+leitung|am\s+apparat)/i,
  /(?:alle|unsere)\s+(?:mitarbeiter|leitungen)[\s\S]{0,70}(?:besetzt|im\s+gespr[äa]ch)/i,
];

export function hasExplicitQueueInstruction(text: string): boolean {
  return HARD_QUEUE_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasInteractiveReceptionQuestion(text: string): boolean {
  return INTERACTIVE_ASSISTANT_PATTERNS.some((pattern) => pattern.test(text));
}

export function hasTransferWaitInstruction(text: string): boolean {
  return hasExplicitQueueInstruction(text) || /\beinen\s+(?:moment|augenblick)\b/i.test(text);
}

export function isHumanContactAfterQueue(text: string): boolean {
  return classifyInboundSpeech(text) === "human"
    && (hasInteractiveReceptionQuestion(text)
      || /\b(?:hallo|guten\s+(?:tag|morgen|abend)|am\s+apparat|hier\s+(?:ist|spricht)|mein\s+name\s+ist|ich\s+bin|das\s+bin\s+ich|wie\s+kann\s+ich|was\s+kann\s+ich|was\s+ist\s+ihr\s+anliegen|sie\s+sprechen\s+mit|wer\s+(?:ist\s+da|spricht)|worum\s+geht|was\s+(?:wollen|möchten)\s+sie)\b/i.test(text)
      || /\b(?:ich\s+(?:habe|möchte|will|kann|muss)|wir\s+(?:haben|möchten)|kein\s+interesse|nicht\s+(?:mehr\s+)?anrufen|rufen\s+sie\s+(?:bitte\s+)?nicht)\b/i.test(text)
      || /^(?:ja(?:\s+bitte)?|bitte|[a-zäöüß-]{3,}(?:\s+[a-zäöüß-]{3,})?),?\s*[.!?]*$/i.test(text.trim())
      || /^(?:ja|hallo|moin)\s*,?\s*[a-zäöüß-]{3,}(?:\s+[a-zäöüß-]{3,})?\s*[,.!?]*\s*(?:ja)?[.!?]*$/i.test(text.trim())
      || /^[a-zäöüß-]{3,}(?:\s+[a-zäöüß-]{3,})?\s*,\s*(?:ja|hallo)[.!?]*$/i.test(text.trim()));
}

export function classifyInboundSpeech(text: string): CallClassification {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (VOICEMAIL_PATTERNS.some((pattern) => pattern.test(normalized))) return "voicemail";
  if (hasInteractiveReceptionQuestion(normalized)
    && !hasExplicitQueueInstruction(normalized)) return "human";
  if (QUEUE_PATTERNS.some((pattern) => pattern.test(normalized))) return "queue";
  if (normalized.length >= 2) return "human";
  return "unknown";
}

export function looksLikeMeaningfulHumanTurn(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  if (classifyInboundSpeech(normalized) !== "human") return false;
  if (/^(ja|nein|hallo|moin|ok|okay|hm+|mhm+)[.!?\s]*$/i.test(normalized)) return false;
  return normalized.length >= 6;
}
