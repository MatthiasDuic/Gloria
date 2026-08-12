import { z } from "zod";
import { TOPICS } from "@/lib/types";

const TopicSchema = z.string().trim().min(2);

export const TopicPolicyPayloadSchema = z
  .object({
    id: z.string().optional(),
    topic: TopicSchema.optional(),
    callObjective: z.string().optional(),
    behavior: z.string().optional(),
    conversationGuardrails: z.string().optional(),
    requiredData: z.string().optional(),
    knowledge: z.string().optional(),
    objectionResponses: z.string().optional(),
    proofPoints: z.string().optional(),
    transferHandling: z.string().optional(),
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
      description: "Welches konkrete Ergebnis Gloria in diesem Thema erreichen soll.",
    },
    behavior: {
      type: "string",
      description: "Wie Gloria spricht, fuehrt und argumentiert.",
    },
    conversationGuardrails: {
      type: "string",
      description: "Harte Regeln, Verbote und Muss-Vorgaben fuer das Thema.",
    },
    requiredData: {
      type: "string",
      description: "Pflichtfragen / Basisdaten, idealerweise eine Frage pro Zeile.",
    },
    proofPoints: {
      type: "string",
      description: "Konkrete Zahlen und Belege, die Gloria aktiv nennen darf oder muss.",
    },
    objectionResponses: {
      type: "string",
      description: "Einwand-Bibliothek, eine Zeile pro Einwand mit Konter-Linie.",
    },
    knowledge: {
      type: "string",
      description: "Faktenwissen, Freigaben, Grenzen und belastbare Argumente.",
    },
    transferHandling: {
      type: "string",
      description: "Wie Gloria bei Wunsch nach einem Menschen oder einer Uebergabe reagieren soll.",
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
