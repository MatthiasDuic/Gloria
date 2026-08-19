/**
 * JSON Schema for TopicPolicyConfig (Playbook) v1
 * Describes the structure and validation rules for playbooks.
 */
export const PLAYBOOK_JSON_SCHEMA_V1 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "Gloria Playbook (TopicPolicyConfig)",
  description: "Configuration for Gloria's behavior, questions, and responses on a specific topic.",
  type: "object",
  required: ["id", "topic", "opener", "discovery", "objectionHandling", "close"],
  properties: {
    id: {
      type: "string",
      description: "Unique identifier for this playbook configuration.",
      minLength: 1,
    },
    topic: {
      type: "string",
      enum: ["pkv", "gkv", "altersvorsorge", "vermögensaufbau", "immobilien"],
      description: "Topic category (topic kind).",
    },
    topicSummary: {
      type: "string",
      description:
        "Worum es im Thema fachlich geht, welchen Nutzen der Interessent davon hat und wie Gloria das Thema inhaltlich einordnet.",
    },
    behavior: {
      type: "string",
      description: "Wie Gloria zum Thema spricht: Haltung, Ton, Reaktionsstil, Führung.",
    },
    conversationGuardrails: {
      type: "string",
      description: "Harte Leitplanken und Verbote für dieses Thema.",
    },
    requiredQuestions: {
      type: "string",
      description: "Pflichtfragen, die in der Terminierungs-/Vorbereitungsphase gestellt werden müssen. Eine Frage pro Zeile.",
    },
    exampleSentences: {
      type: "string",
      description: "Beispielantworten und Formulierungen, die Gloria als Stilvorlage nutzen darf.",
    },
    callObjective: {
      type: "string",
      description: "Ziel des Anrufs; was Gloria mit dem Gespräch erreichen will.",
    },
    greetingDecisionMaker: {
      type: "string",
      description: "Beispieltext für die Begrüßung, wenn die Zielperson selbst am Telefon ist.",
    },
    greetingGatekeeper: {
      type: "string",
      description: "Beispieltext für die Begrüßung am Empfang bzw. beim Gatekeeper.",
    },
    reasonForCall: {
      type: "string",
      description: "Beispieltext für den Grund des Anrufs.",
    },
    relevanceQuestion: {
      type: "string",
      description: "Beispieltext für die Relevanzfrage.",
    },
    contributionQuestion: {
      type: "string",
      description: "Beispieltext für die Beitragsermittlung.",
    },
    projectionText: {
      type: "string",
      description: "Beispieltext für die Hochrechnung und die Brücke zum Nutzungsvorteil.",
    },
    // Legacy/compatibility fields
    requiredData: {
      type: "string",
      description: "[Legacy] Required data points.",
    },
    knowledge: {
      type: "string",
      description: "[Legacy] Knowledge base.",
    },
    objectionResponses: {
      type: "string",
      description: "[Legacy] Objection handling responses.",
    },
    proofPoints: {
      type: "string",
      description: "[Legacy] Proof points and evidence.",
    },
    transferHandling: {
      type: "string",
      description: "[Legacy] Transfer handling instructions.",
    },
    // Core legacy fields (always required for runtime)
    opener: {
      type: "string",
      description: "Initial greeting and setup for the call.",
      minLength: 1,
    },
    discovery: {
      type: "string",
      description: "Discovery phase instructions and key questions.",
      minLength: 1,
    },
    objectionHandling: {
      type: "string",
      description: "Strategies for handling common objections.",
      minLength: 1,
    },
    close: {
      type: "string",
      description: "Closing and appointment confirmation instructions.",
      minLength: 1,
    },
    aiKeyInfo: {
      type: "string",
      description: "[Legacy] Key information for AI context.",
    },
    consentPrompt: {
      type: "string",
      description: "[Legacy] Consent and recording prompt.",
    },
    pkvHealthIntro: {
      type: "string",
      description: "[Legacy] PKV health insurance introduction.",
    },
    pkvHealthQuestions: {
      type: "string",
      description: "[Legacy] PKV health-related questions.",
    },
    gatekeeperTask: {
      type: "string",
      description: "[Legacy] Gatekeeper routing task.",
    },
    gatekeeperBehavior: {
      type: "string",
      description: "[Legacy] How to behave with gatekeeper.",
    },
    decisionMakerTask: {
      type: "string",
      description: "[Legacy] Decision maker engagement task.",
    },
    decisionMakerBehavior: {
      type: "string",
      description: "[Legacy] Behavior with decision maker.",
    },
    decisionMakerContext: {
      type: "string",
      description: "[Legacy] Context for decision maker.",
    },
    appointmentGoal: {
      type: "string",
      description: "[Legacy] Appointment booking goal.",
    },
    receptionTopicReason: {
      type: "string",
      description: "[Legacy] Topic reason for reception.",
    },
    problemBuildup: {
      type: "string",
      description: "[Legacy] Problem buildup narrative.",
    },
    conceptTransition: {
      type: "string",
      description: "[Legacy] Transition to concept explanation.",
    },
    appointmentConfirmation: {
      type: "string",
      description: "[Legacy] Appointment confirmation template.",
    },
    availableAppointmentSlots: {
      type: "string",
      description: "[Legacy] Available appointment time slots.",
    },
  },
  additionalProperties: false,
};
