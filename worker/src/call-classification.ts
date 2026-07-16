export type CallClassification = "voicemail" | "queue" | "human" | "unknown";

const VOICEMAIL_PATTERNS: RegExp[] = [
  /anrufbeantworter/i,
  /mailbox/i,
  /nachricht(?:\s+nach)?\s+dem\s+signalton/i,
  /hinterlassen\s+sie\s+(?:eine\s+)?nachricht/i,
  /teilnehmer\s+ist\s+(?:zurzeit\s+)?nicht\s+erreichbar/i,
  /momentan\s+nicht\s+erreichbar/i,
  /sind\s+vor[üu]bergehend\s+nicht\s+erreichbar/i,
  /piep|signalton/i,
];

const QUEUE_PATTERNS: RegExp[] = [
  /ich\s+verbinde\s+sie/i,
  /einen\s+moment\s+bitte/i,
  /bleiben\s+sie\s+in\s+der\s+leitung/i,
  /bitte\s+warten\s+sie/i,
  /warteschleife/i,
  /sie\s+werden\s+verbunden/i,
  /der\s+n[äa]chste\s+freie\s+mitarbeiter/i,
  /einen\s+augenblick\s+geduld/i,
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
