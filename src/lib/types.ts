export const TOPICS = [
  "betriebliche Krankenversicherung",
  "betriebliche Altersvorsorge",
  "gewerbliche Versicherungen",
  "private Krankenversicherung",
  "Energie",
] as const;

export type Topic = (typeof TOPICS)[number];
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
  topic: Topic;
  note?: string;
  nextCallAt?: string;
  status: LeadStatus;
  attempts: number;
}

export interface PlaybookConfig {
  id: string;
  topic: Topic;
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
  gatekeeperExample?: string;
  decisionMakerTask?: string;
  decisionMakerBehavior?: string;
  decisionMakerExample?: string;
  decisionMakerContext?: string;
  appointmentGoal?: string;
  receptionTopicReason?: string;
  problemBuildup?: string;
  conceptTransition?: string;
  appointmentConfirmation?: string;
  availableAppointmentSlots?: string;
}

/** @deprecated Use PlaybookConfig. Retained as alias during the Skript → Playbook migration. */
export type ScriptConfig = PlaybookConfig;

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
  optimizedPlaybook: PlaybookConfig;
}

export interface LearningResponse {
  insights: LearningInsight[];
  globalSummary: string[];
}

export interface DashboardData {
  leads: Lead[];
  reports: CallReport[];
  playbooks: PlaybookConfig[];
  metrics: MetricSummary;
  reportStorageMode: "postgres" | "file";
  playbooksStorageMode: "postgres" | "file";
}
