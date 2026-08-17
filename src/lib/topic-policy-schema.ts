import { z } from "zod";
import { TOPICS } from "@/lib/types";

const TopicSchema = z.string().trim().min(2);

export const TopicPolicyPayloadSchema = z
  .object({
    id: z.string().optional(),
    topic: TopicSchema.optional(),
    callObjective: z.string().optional(),
    topicSummary: z.string().optional(),
    behavior: z.string().optional(),
    conversationGuardrails: z.string().optional(),
    requiredQuestions: z.string().optional(),
    exampleSentences: z.string().optional(),
    greetingDecisionMaker: z.string().optional(),
    greetingGatekeeper: z.string().optional(),
    reasonForCall: z.string().optional(),
    relevanceQuestion: z.string().optional(),
    contributionQuestion: z.string().optional(),
    projectionText: z.string().optional(),
    opener: z.string().optional(),
    discovery: z.string().optional(),
    objectionHandling: z.string().optional(),
    close: z.string().optional(),
    aiKeyInfo: z.string().optional(),
    consentPrompt: z.string().optional(),
    pkvHealthIntro: z.string().optional(),
    pkvHealthQuestions: z.string().optional(),
    gatekeeperTask: z.string().optional(),
    gatekeeperBehavior: z.string().optional(),
    decisionMakerTask: z.string().optional(),
    decisionMakerBehavior: z.string().optional(),
    decisionMakerContext: z.string().optional(),
    appointmentGoal: z.string().optional(),
    receptionTopicReason: z.string().optional(),
    problemBuildup: z.string().optional(),
    conceptTransition: z.string().optional(),
    appointmentConfirmation: z.string().optional(),
    availableAppointmentSlots: z.string().optional(),
  })
  .strict();

export const TOPIC_POLICY_JSON_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Gloria Topic Policy v1",
  type: "object",
  additionalProperties: false,
  required: ["topic"],
  properties: {
    topic: {
      type: "string",
      description: "Thema, für das die Topic Policy gilt.",
      examples: [...TOPICS],
    },
    callObjective: {
      type: "string",
      description: "Das gewünschte Ergebnis des Anrufs, zum Beispiel Terminvereinbarung, Rückruf oder Serviceklärung.",
    },
    topicSummary: {
      type: "string",
      description: "Worum es fachlich geht, wie Gloria den Nutzen erklärt und welche Einordnung der Interessent davon hat.",
    },
    behavior: {
      type: "string",
      description: "Wie Gloria spricht, fuehrt und argumentiert.",
    },
    conversationGuardrails: {
      type: "string",
      description: "Harte Regeln, Verbote und Muss-Vorgaben fuer das Thema.",
    },
    requiredQuestions: {
      type: "string",
      description: "Pflichtfragen, die in der Terminierungs-/Vorbereitungsphase gestellt oder in die Terminbestätigungsmail übernommen werden sollen.",
    },
  },
} as const;
