import { z } from "zod";
import { TOPICS } from "@/lib/types";

const TopicSchema = z.enum(TOPICS);

export const PlaybookPayloadSchema = z
  .object({
    topic: TopicSchema.optional(),
    opener: z.string().trim().min(1).optional(),
    discovery: z.string().trim().min(1).optional(),
    objectionHandling: z.string().trim().min(1).optional(),
    close: z.string().trim().min(1).optional(),
    aiKeyInfo: z.string().trim().optional(),
    consentPrompt: z.string().trim().optional(),
    pkvHealthIntro: z.string().trim().optional(),
    pkvHealthQuestions: z.string().trim().optional(),
    gatekeeperTask: z.string().trim().optional(),
    gatekeeperBehavior: z.string().trim().optional(),
    gatekeeperExample: z.string().trim().optional(),
    decisionMakerTask: z.string().trim().optional(),
    decisionMakerBehavior: z.string().trim().optional(),
    decisionMakerExample: z.string().trim().optional(),
    decisionMakerContext: z.string().trim().optional(),
    appointmentGoal: z.string().trim().optional(),
    receptionTopicReason: z.string().trim().optional(),
    problemBuildup: z.string().trim().optional(),
    conceptTransition: z.string().trim().optional(),
    appointmentConfirmation: z.string().trim().optional(),
    availableAppointmentSlots: z.string().trim().optional(),
  })
  .strict();

export const PLAYBOOK_JSON_SCHEMA_V1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Gloria Playbook v1",
  type: "object",
  additionalProperties: false,
  required: ["topic"],
  properties: {
    topic: {
      type: "string",
      enum: [...TOPICS],
      description: "Thema, für das das Playbook gilt.",
    },
    opener: {
      type: "string",
      description: "Kurze, natürliche Eröffnung für die Zielrolle.",
    },
    discovery: {
      type: "string",
      description: "Offene Bedarfsermittlungsfrage.",
    },
    objectionHandling: {
      type: "string",
      description: "Leitlinie für kurze, souveräne Einwandbehandlung.",
    },
    close: {
      type: "string",
      description: "Brücke in die Terminierung.",
    },
    aiKeyInfo: {
      type: "string",
      description: "Kerninformationen, die Gloria kennen soll.",
    },
    consentPrompt: {
      type: "string",
      description: "Aufzeichnungsfrage vor inhaltlichem Gespräch.",
    },
    gatekeeperTask: {
      type: "string",
      description: "Ziel am Empfang.",
    },
    gatekeeperBehavior: {
      type: "string",
      description: "Verhalten am Empfang.",
    },
    gatekeeperExample: {
      type: "string",
      description: "Beispielton für den Empfang.",
    },
    decisionMakerTask: {
      type: "string",
      description: "Ziel beim Entscheider.",
    },
    decisionMakerBehavior: {
      type: "string",
      description: "Verhalten beim Entscheider.",
    },
    decisionMakerExample: {
      type: "string",
      description: "Beispielton beim Entscheider.",
    },
    decisionMakerContext: {
      type: "string",
      description: "Problemaufbau und Relevanzkontext.",
    },
    appointmentGoal: {
      type: "string",
      description: "Terminierungsziel.",
    },
    receptionTopicReason: {
      type: "string",
      description: "Kurze Antwort auf 'Worum geht es?'.",
    },
    problemBuildup: {
      type: "string",
      description: "Bildhafter Problemaufbau.",
    },
    conceptTransition: {
      type: "string",
      description: "Übergang vom Bedarf zur Lösung.",
    },
    appointmentConfirmation: {
      type: "string",
      description: "Muster für Terminbestätigung.",
    },
    availableAppointmentSlots: {
      type: "string",
      description: "Optional vordefinierte freie Slots.",
    },
    pkvHealthIntro: {
      type: "string",
      description: "Einleitung für PKV-Datenaufnahme nach Termin.",
    },
    pkvHealthQuestions: {
      type: "string",
      description: "Zeilenweise PKV-Risikofragen.",
    },
  },
} as const;
