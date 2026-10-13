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
  /teilnehmer\s+ist\s+(?:zurzeit\s+)?nicht\s+erreichbar/i,
  /momentan\s+nicht\s+erreichbar/i,
  /sind\s+vor[üu]bergehend\s+nicht\s+erreichbar/i,
  /(?:hinterlassen|aufzeichnen)\s+sie\s+(?:ihre\s+)?(?:nachricht|aufnahme)\b/i,
];

const QUEUE_PATTERNS: RegExp[] = [
  /ich\s+verbinde\s+sie/i,
  /sie\s+werden\s+(?:jetzt\s+)?(?:weiter)?verbunden/i,
  /ihre\s+verbindung\s+wird\s+(?:gehalten|hergestellt|weitergeleitet)/i,
  /ihr\s+anruf\s+wird\s+(?:weitergeleitet|verbunden|entgegengenommen)/i,
  /bleiben\s+sie\s+(?:bitte\s+)?(?:in\s+der\s+leitung|am\s+apparat)/i,
  /einen\s+moment\s+bitte/i,
  /bitte\s+warten\s+sie/i,
  /warteschleife/i,
  /(?:alle|unsere)\s+(?:mitarbeiter|leitungen|gespr[äa]che)[\s\S]{0,70}(?:besetzt|im\s+gespr[äa]ch)/i,
  /(?:alle\s+)?mitarbeiter\s+sind\s+(?:zurzeit\s+)?(?:besetzt|belegt|im\s+gespr[äa]ch)/i,
  /(?:der|die)\s+n[äa]chste\s+freie\s+(?:mitarbeiter|ansprechpartner)/i,
  /einen\s+augenblick\s+(?:geduld|bitte)/i,
  /bitte\s+haben\s+sie\s+(?:einen\s+)?(?:moment|augenblick)\s+geduld/i,
  /sie\s+befinden\s+sich\s+in\s+(?:unserer\s+)?warteschleife/i,
  /(?:vielen\s+dank|willkommen)\s+bei\b[\s\S]{0,90}\b(?:bitte\s+warten|moment\s+geduld|sie\s+werden\s+verbunden|ihren\s+anruf)\b/i,
  /(?:to\s+)?(?:continue|hold|remain)\s+(?:please\s+)?(?:press\s+\d|on\s+the\s+line)/i,
  /(?:dr[üu]cken|w[äa]hlen)\s+sie\s+(?:bitte\s+)?(?:die\s+)?(?:\d|eins|eins\s+bis\s+neun)\b/i,
];

export function classifyInboundSpeech(text: string): CallClassification {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (VOICEMAIL_PATTERNS.some((pattern) => pattern.test(normalized))) return "voicemail";
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
