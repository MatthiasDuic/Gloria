import { z } from "zod";
import { TOPICS } from "@/lib/types";

const TopicSchema = z.string().trim().min(2);

export const TopicPolicyPayloadSchema = z
  .object({
    id: z.string().optional(),
    topic: TopicSchema.optional(),
    topicSummary: z.string().optional(),
    behavior: z.string().optional(),
    conversationGuardrails: z.string().optional(),
    requiredQuestions: z.string().optional(),
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
