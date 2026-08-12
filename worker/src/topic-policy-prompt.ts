import { fetch } from "undici";
import { log } from "./log.js";

export type TopicPolicyFields = {
  topic?: string;
  callObjective?: string;
  behavior?: string;
  conversationGuardrails?: string;
  requiredData?: string;
  knowledge?: string;
  objectionResponses?: string;
  proofPoints?: string;
  transferHandling?: string;
  opener?: string;
  discovery?: string;
  objectionHandling?: string;
  close?: string;
  aiKeyInfo?: string;
  consentPrompt?: string;
  pkvHealthIntro?: string;
  pkvHealthQuestions?: string;
  gatekeeperTask?: string;
  gatekeeperBehavior?: string;
  decisionMakerTask?: string;
  decisionMakerBehavior?: string;
  decisionMakerContext?: string;
  appointmentGoal?: string;
  receptionTopicReason?: string;
  problemBuildup?: string;
  conceptTransition?: string;
  appointmentConfirmation?: string;
  availableAppointmentSlots?: string;
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
  const behavior = (policy.behavior || "").trim();
  const conversationGuardrails = (policy.conversationGuardrails || "").trim();
  const requiredData = (policy.requiredData || "").trim();
  const knowledge = (policy.knowledge || "").trim();
  const objectionResponses = (policy.objectionResponses || "").trim();
  const proofPoints = (policy.proofPoints || "").trim();
  const transferHandling = (policy.transferHandling || "").trim();

  if (
    !callObjective &&
    !behavior &&
    !conversationGuardrails &&
    !requiredData &&
    !knowledge &&
    !objectionResponses &&
    !proofPoints &&
    !transferHandling
  ) {
    return topic ? `THEMA DIESES CALLS: ${topic}` : "";
  }

  const parts: string[] = [];
  parts.push("TOPIC POLICY – fachliche Leitlinie für dieses Gespräch:");
  parts.push(
    "VORRANGREGEL: Die universellen Erstkontakt-, Transparenz-, Freiwilligkeits- und Datenschutzregeln im Hauptprompt stehen über dieser Topic Policy. Nutze die Topic Policy als Orientierung für Inhalt und Richtung, aber antworte immer situativ auf die letzte Kundenaussage und nicht als Skript.",
  );
  if (topic) parts.push(`THEMA: ${topic}`);
  if (callObjective) {
    parts.push("", "ZIELBILD / ERFOLG DIESES CALLS:", callObjective);
  }
  if (behavior) {
    parts.push("", "VERHALTEN & TONALITÄT (themenspezifisch):", behavior);
  }
  if (conversationGuardrails) {
    parts.push("", "THEMENSPEZIFISCHE GRENZEN & HINWEISE (nicht als Skript vorlesen):", conversationGuardrails);
  }
  if (requiredData) {
    parts.push("", "MÖGLICHE VORBEREITUNGSDATEN (freiwillig, erst nach Termin und ausdrücklichem Opt-in; bei Zurückhaltung per Mail anbieten, nie als Terminbedingung darstellen):", requiredData);
  }
  if (proofPoints) {
    parts.push("", "ZAHLEN & FAKTEN (als optionaler inhaltlicher Anker, nur wenn sie zur Kundenaussage passen):", proofPoints);
  }
  if (objectionResponses) {
    parts.push("", "EINWAND-BIBLIOTHEK (nur als fachlicher Hintergrund, nicht wortgetreu und nie als Druckmittel. Bei Skepsis transparent antworten; bei erstem Nein höchstens eine kurze Relevanzfrage, jedes weitere Nein akzeptieren):", objectionResponses);
  }
  if (knowledge) {
    parts.push("", "FACHWISSEN (nutze diese konkreten Fakten, BEVOR du auf Bilder/Metaphern ausweichst):", knowledge);
  }
  if (transferHandling) {
    parts.push("", "UEBERGABE / MENSCHLICHE WEITERLEITUNG:", transferHandling);
  }

  return parts.join("\n");
}
