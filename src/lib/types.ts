export const TOPICS = [
  "betriebliche Krankenversicherung",
  "betriebliche Altersvorsorge",
  "gewerbliche Versicherungen",
  "private Krankenversicherung",
  "Energie",
  "Outbound Service (Kundenzufriedenheit)",
  "Outbound Bestandskunden (Jahresgespraech)",
  "Inbound Service (Anliegen und Tasks)",
] as const;

// Dynamische Themen sind erlaubt: TOPICS sind nur die Standard-Vorgaben.
export type Topic = string;
export type LeadStatus = "neu" | "angerufen" | "termin" | "absage" | "wiedervorlage";
export type ReportOutcome = "Termin" | "Absage" | "Wiedervorlage" | "Kein Kontakt";

export interface Lead {
  id: string;
  userId?: string;
  listId?: string;
  listName?: string;
  company: string;
  contactName: string;
  phone: string;
  directDial?: string;
  email?: string;
  location?: string;
  topic: Topic;
  note?: string;
  nextCallAt?: string;
  status: LeadStatus;
  attempts: number;
}

export interface TopicPolicyConfig {
  id: string;
  topic: Topic;
  /**
   * Worum es im Thema fachlich geht, welchen Nutzen der Interessent davon hat
   * und wie Gloria das Thema inhaltlich einordnet.
   */
  topicSummary?: string;
  /**
   * Wie Gloria zum Thema spricht: Haltung, Ton, Reaktionsstil, Führung.
   */
  behavior?: string;
  /**
   * Harte Leitplanken und Verbote für dieses Thema.
   */
  conversationGuardrails?: string;
  /**
   * Pflichtfragen, die in der Terminierungs-/Vorbereitungsphase gestellt
   * werden müssen oder in die Terminbestätigungsmail gehören.
   * Eine Frage pro Zeile.
   */
  requiredQuestions?: string;
  // Legacy-/Kompatibilitätsfelder ------------------------------------------------
  callObjective?: string;
  requiredData?: string;
  knowledge?: string;
  objectionResponses?: string;
  proofPoints?: string;
  transferHandling?: string;
  // --- Legacy-Felder (werden nicht mehr im UI editiert) ----------------
  opener: string;
  discovery: string;
  objectionHandling: string;
  close: string;
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
}

/** @deprecated Use TopicPolicyConfig. Retained as alias during the Skript → Playbook migration. */
export type ScriptConfig = TopicPolicyConfig;

export interface CallReport {
  id: string;
  userId?: string;
  phoneNumberId?: string;
  callSid?: string;
  leadId?: string;
  directDial?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  summary: string;
  outcome: ReportOutcome;
  conversationDate: string;
  appointmentAt?: string;
  nextCallAt?: string;
  attempts: number;
  recordingConsent: boolean;
  recordingUrl?: string;
  emailedTo: string;
}

export interface MetricSummary {
  dialAttempts: number;
  conversations: number;
  appointments: number;
  rejections: number;
  callbacksOpen: number;
  gatekeeperLoops: number;
  transferSuccessRate: number;
}

export interface ConversationEvent {
  id: string;
  callSid?: string;
  topic: Topic;
  company: string;
  step: string;
  eventType: string;
  contactRole?: "gatekeeper" | "decision-maker";
  turn?: number;
  text?: string;
  createdAt: string;
}

export interface LearningInsight {
  topic: Topic;
  totalConversations: number;
  appointments: number;
  rejections: number;
  callbacks: number;
  appointmentRate: number;
  signals: string[];
  recommendations: string[];
  optimizedPlaybook: TopicPolicyConfig;
}

export interface LearningResponse {
  insights: LearningInsight[];
  globalSummary: string[];
}

export interface DashboardData {
  leads: Lead[];
  reports: CallReport[];
  topicPolicies: TopicPolicyConfig[];
  metrics: MetricSummary;
  reportStorageMode: "postgres" | "file";
  topicPoliciesStorageMode: "postgres" | "file";
}
