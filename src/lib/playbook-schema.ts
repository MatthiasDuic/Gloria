import { z } from "zod";
import { TOPICS } from "@/lib/types";

const TopicSchema = z.enum(TOPICS);

export const PlaybookPayloadSchema = z
  .object({
    // id kommt aus dem UI-Draft (PlaybookConfig.id). Der Server vergibt
    // die finale Id selbst in saveScript, akzeptiert das Feld aber, damit
    // .strict() keinen kompletten Save blockiert.
    id: z.string().optional(),
    topic: TopicSchema.optional(),
    // Vereinfachtes Modell (3 Felder)
    behavior: z.string().optional(),
    requiredData: z.string().optional(),
    knowledge: z.string().optional(),
    objectionResponses: z.string().optional(),
    proofPoints: z.string().optional(),
    // Legacy-Felder (werden nicht mehr im UI editiert, aber für Rückwärtskompatibilität weiter akzeptiert)
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
    decisionMakerTask: {
      type: "string",
      description: "Ziel beim Entscheider.",
    },
    decisionMakerBehavior: {
      type: "string",
      description: "Verhalten beim Entscheider.",
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
