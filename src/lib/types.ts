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
  company: string;
  contactName: string;
  phone: string;
  email?: string;
  topic: Topic;
  note?: string;
  nextCallAt?: string;
  status: LeadStatus;
  attempts: number;
}

export interface ScriptConfig {
  id: string;
  topic: Topic;
  opener: string;
  discovery: string;
  objectionHandling: string;
  close: string;
}

export interface CallReport {
  id: string;
  callSid?: string;
  leadId?: string;
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
  optimizedScript: ScriptConfig;
}

export interface LearningResponse {
  insights: LearningInsight[];
  globalSummary: string[];
}

export interface DashboardData {
  leads: Lead[];
  reports: CallReport[];
  scripts: ScriptConfig[];
  metrics: MetricSummary;
  reportStorageMode: "postgres" | "file";
}
