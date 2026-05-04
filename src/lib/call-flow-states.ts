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
  const heardLower = params.heardText.toLowerCase();

  const alreadyOnLineSignals =
    /\b(ich\s+bin\s+(schon\s+)?dran|ich\s+bin\s+am\s+apparat|ja,?\s*ich\s+bin(?:\s+es)?\b|ja,?\s*selbst\b|das\s+bin\s+ich\b|spreche\s+selbst|sprechen\s+sie\s+mit\s+mir|selbst\s+am\s+apparat)\b/.test(
      heardLower,
    );

  if (alreadyOnLineSignals) {
    return "decision-maker";
  }

  // Wenn wir keinen Zielkontakt kennen, bleiben wir konservativ.
  if (!normalized) return "gatekeeper";
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

  // Standard ist Empfang, solange kein klarer Entscheider-Hinweis vorliegt.
  return "gatekeeper";
}

export function getTopicReasonLine(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "es geht um eine kurze Einordnung zur betrieblichen Krankenversicherung und deren Mehrwert für Bindung und Arbeitgeberattraktivität";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "es geht um eine kurze Einordnung zur betrieblichen Altersvorsorge und wie sie verständlich im Alltag genutzt wird";
  }
  if (topic === "gewerbliche Versicherungen") {
    return "es geht um eine kurze Einordnung, ob Deckung, Beitrag und Risiko in Ihren gewerblichen Policen noch sauber zusammenpassen";
  }
  if (topic === "private Krankenversicherung") {
    return "es geht um die Beitragsentwicklung in der Krankenversicherung und wie sich das langfristig planbarer aufstellen lässt";
  }
  if (topic === "Energie") {
    return "es geht um eine kurze wirtschaftliche Einordnung Ihrer Strom- und Gaskonditionen";
  }
  return `es geht um eine kurze Einordnung zum Thema ${topic}`;
}

export function getResponsibleRoleByTopic(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung" || topic === "betriebliche Altersvorsorge") {
    return "der zuständigen Person für Personal oder Benefits";
  }
  if (topic === "gewerbliche Versicherungen") {
    return "der zuständigen Person für Versicherungen oder Risikothemen";
  }
  if (topic === "Energie") {
    return "der zuständigen Person für Energie, Einkauf oder Geschäftsführung";
  }
  return "der zuständigen Person";
}

export function buildGatekeeperOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const transferTarget = name || getResponsibleRoleByTopic(state.topic);
  return `Guten Tag, Gloria von der Agentur Duic, im Auftrag von Herrn Matthias Duic. Könnten Sie mich bitte kurz mit ${transferTarget} verbinden?`;
}

export function buildDecisionMakerOpenerLine(state: TokenizedCallState): string {
  const name = normalizeContactName(state.contactName);
  const salutation = name ? `Guten Tag ${name}` : "Guten Tag";
  const topicReason = getTopicReasonLine(state.topic);
  return `${salutation}, ich bin Gloria von der Agentur Duic im Auftrag von Herrn Matthias Duic. ${topicReason}. Passt eine kurze Frage?`;
}

export function buildDecisionMakerDiscoveryQuestion(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "Wie zufrieden sind Sie aktuell mit Ihrer Wirkung bei Gewinnung und Bindung von Mitarbeitenden?";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "Wie verständlich und attraktiv ist Ihre bAV aktuell aus Sicht Ihrer Mitarbeitenden?";
  }
  if (topic === "gewerbliche Versicherungen") {
    return "Wann haben Sie Ihre gewerblichen Policen zuletzt einmal komplett auf Passung und Preis geprüft?";
  }
  if (topic === "private Krankenversicherung") {
    // Zuerst explizit nach Versicherungsart fragen, bevor weitere Fakten folgen dürfen
    return "Darf ich vorab fragen: Sind Sie aktuell gesetzlich oder privat krankenversichert?";
  }
  if (topic === "Energie") {
    return "Wann haben Sie Ihre Strom- und Gaskonditionen zuletzt aktiv neu bewertet?";
  }
  return `Danke. Wie ist das Thema ${topic} bei Ihnen aktuell aufgestellt?`;
}

export function buildDecisionMakerTransitionToAppointment(topic: Topic): string {
  if (topic === "betriebliche Krankenversicherung") {
    return "Danke, das ist ein guter Einblick. Wollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "betriebliche Altersvorsorge") {
    return "Danke, das hilft sehr. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "gewerbliche Versicherungen") {
    return "Danke für die Einordnung. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "private Krankenversicherung") {
    return "Danke, das hilft sehr. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
  }
  if (topic === "Energie") {
    return "Danke für den Einblick. Sollen wir dafür einen kurzen Termin mit Herrn Duic abstimmen, eher vormittags oder nachmittags?";
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
    return `Gern: Gloria von der Agentur Duic, im Auftrag von Herrn Matthias Duic. Verbinden Sie mich bitte kurz mit ${transferTarget}.`;
  }

  if (isGatekeeperTargetPersonQuestion(heardText)) {
    return `Am besten mit ${transferTarget}. Danke Ihnen fürs kurze Durchstellen.`;
  }

  if (isGatekeeperReasonQuestion(heardText)) {
    return `Gern, in einem Satz: ${topicReason}. Ich stimme das kurz direkt mit ${transferTarget} ab. Können Sie mich bitte verbinden?`;
  }

  return null;
}
