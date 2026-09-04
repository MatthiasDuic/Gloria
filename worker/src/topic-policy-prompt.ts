import { fetch } from "undici";
import { log } from "./log.js";

export type TopicPolicyFields = {
  topic?: string;
  callObjective?: string;
  topicSummary?: string;
  behavior?: string;
  conversationGuardrails?: string;
  requiredQuestions?: string;
  exampleSentences?: string;
  close?: string;
  knowledge?: string;
  proofPoints?: string;
  objectionResponses?: string;
  transferHandling?: string;
  decisionMakerContext?: string;
  receptionTopicReason?: string;
  problemBuildup?: string;
  conceptTransition?: string;
  gatekeeperTask?: string;
  gatekeeperBehavior?: string;
  aiKeyInfo?: string;
  appointmentConfirmation?: string;
};

export async function loadTopicPolicy(opts: {
  userId?: string;
  topic?: string;
}): Promise<TopicPolicyFields | null> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token) {
    log.warn("topic_policy.skipped_no_config");
    return null;
  }
  if (!opts.topic) {
    log.warn("topic_policy.skipped_no_topic");
    return null;
  }

  const params = new URLSearchParams();
  if (opts.userId) params.set("userId", opts.userId);

  const url = `${baseUrl}/api/telnyx/topic-policies${params.toString() ? `?${params.toString()}` : ""}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-gloria-internal-token": token },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("topic_policy.http_error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as { topicPolicies?: TopicPolicyFields[] };
    const list = Array.isArray(json.topicPolicies) ? json.topicPolicies : [];
    const match =
      list.find((p) => (p.topic || "").toLowerCase() === opts.topic!.toLowerCase()) ||
      list[0] ||
      null;
    if (!match) {
      log.warn("topic_policy.no_match", { topic: opts.topic });
      return null;
    }
    log.info("topic_policy.loaded", { topic: match.topic, fields: Object.keys(match).length });
    return match;
  } catch (error) {
    log.warn("topic_policy.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function topicPolicyToSystemPrompt(policy: TopicPolicyFields): string {
  const topic = (policy.topic || "").trim();
  const callObjective = (policy.callObjective || "").trim();
  const topicSummary = (policy.topicSummary || "").trim();
  const behavior = (policy.behavior || "").trim();
  const conversationGuardrails = (policy.conversationGuardrails || "").trim();
  const requiredQuestions = (policy.requiredQuestions || "").trim();
  const exampleSentences = (policy.exampleSentences || "").trim();
  const objectionResponses = (policy.objectionResponses || "").trim();
  const decisionMakerContext = (policy.decisionMakerContext || "").trim();
  const problemBuildup = (policy.problemBuildup || "").trim();
  const conceptTransition = (policy.conceptTransition || "").trim();
  const knowledge = (policy.knowledge || "").trim();
  const proofPoints = (policy.proofPoints || "").trim();
  const transferHandling = (policy.transferHandling || "").trim();
  const gatekeeperTask = (policy.gatekeeperTask || "").trim();
  const gatekeeperBehavior = (policy.gatekeeperBehavior || "").trim();
  const appointmentConfirmation = (policy.appointmentConfirmation || "").trim();

  if (
    !topicSummary &&
    !callObjective &&
    !behavior &&
    !conversationGuardrails &&
    !requiredQuestions
  ) {
    return topic ? `THEMA DIESES CALLS: ${topic}` : "";
  }

  const parts: string[] = [];
  parts.push("TOPIC POLICY – fachliche Leitlinie für dieses Gespräch:");
  parts.push(
    "VORRANGREGEL: Die universellen Erstkontakt-, Transparenz-, Freiwilligkeits- und Datenschutzregeln im Hauptprompt stehen über dieser Topic Policy. Diese Topic Policy steuert jedoch fachlichen Anlass, Nutzen, Einwände und Gesprächsführung. Antworte immer zuerst situativ auf die letzte Kundenaussage und nutze keinen Fragenkatalog.",
  );
  if (topic) parts.push(`THEMA: ${topic}`);
  if (callObjective) {
    parts.push("", "ZIEL DIESES ANRUFS:", callObjective);
  }
  if (topicSummary) {
    parts.push("", "WORUM ES BEI DIESEM THEMA GEHT UND WELCHEN NUTZEN DER INTERESSENT DAVON HAT:", topicSummary);
  }
  if (behavior) {
    parts.push("", "VERHALTEN & TONALITÄT (themenspezifisch):", behavior);
  }
  if (conversationGuardrails) {
    parts.push("", "THEMENSPEZIFISCHE GRENZEN & HINWEISE (nicht als Skript vorlesen):", conversationGuardrails);
  }
  if (gatekeeperTask || gatekeeperBehavior) {
    parts.push("", "GATEKEEPER-FÜHRUNG (nur bis die Zielperson bestätigt ist):");
    if (gatekeeperTask) parts.push(gatekeeperTask);
    if (gatekeeperBehavior) parts.push(gatekeeperBehavior);
    if (policy.receptionTopicReason?.trim()) parts.push(`Kurzer Anlass auf Rückfrage: ${policy.receptionTopicReason.trim()}`);
  }
  if (decisionMakerContext || problemBuildup || conceptTransition) {
    parts.push("", "FÜHRUNG NACH BESTÄTIGTEM ENTSCHEIDER (situativ, niemals als Monolog):");
    if (decisionMakerContext) parts.push(`Kontext: ${decisionMakerContext}`);
    if (problemBuildup) parts.push(`Relevanzargument: ${problemBuildup}`);
    if (conceptTransition) parts.push(`Nutzen- und Terminbrücke: ${conceptTransition}`);
  }
  if (objectionResponses) {
    parts.push("", "EINWÄNDE:", "Nutze die passende Antwort nur als inhaltliche Orientierung. Beantworte den Einwand zuerst, ohne ihn zu widerlegen oder dieselbe Frage zu wiederholen:", objectionResponses);
  }
  if (knowledge || proofPoints) {
    parts.push("", "FACHLICHE FAKTEN UND GRENZEN:");
    if (knowledge) parts.push(knowledge);
    if (proofPoints) parts.push(`Belegbare Anhaltspunkte nur vorsichtig und passend verwenden, niemals als Garantie: ${proofPoints}`);
  }
  if (transferHandling) {
    parts.push("", "MENSCHLICHE ÜBERGABE:", transferHandling);
  }
  if (requiredQuestions) {
    parts.push(
      "",
      "FRAGEN NACH TERMINBESTÄTIGUNG:",
      "Nach bestätigtem Termin führst du diese Fragen als Vorbereitung zuverlässig durch: eine Frage pro Turn, in der vorgegebenen Reihenfolge und ohne bereits beantwortete Fragen zu wiederholen. Erkläre bei sensiblen Daten kurz den Nutzen. Sagt der Kunde Nein, hat keine Zeit oder möchte keine weiteren Angaben machen, akzeptiere das sofort, beende die Fragerunde und vermerke die offenen Punkte für die Terminbestätigung:",
      requiredQuestions,
    );
  }
  if (exampleSentences) {
    parts.push(
      "",
      "BEISPIELFORMULIERUNGEN (nur sinngemäß verwenden, nicht mechanisch wiederholen):",
      exampleSentences,
    );
  }
  if (appointmentConfirmation) {
    parts.push("", "NACH ERFOLGREICHER TERMINBESTÄTIGUNG (sinngemäß):", appointmentConfirmation);
  }

  return parts.join("\n");
}
