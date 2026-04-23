import { normalizeContactName } from "@/lib/phone-utils";
import type { Topic } from "@/lib/types";
import type { TokenizedCallState } from "@/lib/call-state-token";

export const CALL_FLOW_STATES = [
  "CALL_START",
  "RECEPTION",
  "DECIDER_INTRO",
  "PROBLEM",
  "BEDARF",
  "KONZEPT",
  "DATEN",
  "TERMINIERUNG",
  "CALL_END",
] as const;

export type CallFlowState = (typeof CALL_FLOW_STATES)[number];

export function classifyInitialGreeting(params: {
  heardText: string;
  contactName?: string;
}): "decision-maker" | "gatekeeper" {
  const normalized = normalizeContactName(params.contactName) || "";
  if (!normalized) return "gatekeeper";

  const heardLower = params.heardText.toLowerCase();
  const nameTokens = normalized
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[.,;:!?]/g, ""))
    .filter((t) => t.length >= 3 && !/^(herr|frau|dr|prof|dipl|ing)$/.test(t));

  if (nameTokens.length === 0) return "gatekeeper";

  const matchesName = nameTokens.some((token) =>
    new RegExp(`\\b${token.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i").test(heardLower),
  );

  return matchesName ? "decision-maker" : "gatekeeper";
}

export function getTopicReasonLine(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "es geht um eine kurze Einordnung zur betrieblichen Krankenversicherung und wie Betriebe damit Gesundheitsthemen greifbar entlasten";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "es geht um eine kurze Einordnung zur betrieblichen Altersvorsorge und wie Arbeitgeber damit langfristige Bindung aufbauen";
  }
  if (topic === "private Krankenversicherung") {
    return "es geht um die stetig steigenden Beiträge zur Gesundheitsversorgung und wie man sich in der Krankenversicherung langfristig planbarer aufstellen kann";
  }
  return `es geht um eine kurze Einordnung zum Thema ${topic}`;
}

export function getResponsibleRoleByTopic(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung" || topic === "betriebliche Altersvorsorge") {
    return "der zuständigen Person für Personal oder Benefits";
  }
  return "der zuständigen Person";
}

export function buildGatekeeperOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const transferTarget = name || getResponsibleRoleByTopic(state.topic);
  return `Guten Tag, ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich melde mich im Auftrag von Herrn Matthias Duic. Ich würde gerne mit ${transferTarget} verbunden werden.`;
}

export function buildDecisionMakerOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const salutation = name ? `Guten Tag ${name}` : "Guten Tag";
  const topicReason = getTopicReasonLine(state.topic);
  return `${salutation}, ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich melde mich im Auftrag von Herrn Matthias Duic, ${topicReason}. Darf ich Ihnen dazu eine kurze Frage stellen?`;
}

export function buildDecisionMakerDiscoveryQuestion(topic: Topic): string {
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

export function buildDecisionMakerTransitionToAppointment(topic: Topic): string {
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

export function buildGatekeeperObjectionReply(state: TokenizedCallState, heardText: string): string | null {
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
