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
  directDial?: string;
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
  // Full Leitfaden fields – editable and saved to JSON, override the .ts defaults
  receptionIntro?: string;
  receptionIfAskedWhatTopic?: string;
  receptionIfBlocked?: string;
  receptionIfEmailSuggested?: string;
  receptionIfEmailInsisted?: string;
  decisionMakerIntro?: string;
  needsQuestions?: string;        // newline-separated list
  needsReinforcement?: string;
  problemText?: string;
  conceptText?: string;
  pressureText?: string;
  closeMain?: string;
  closeIfNoTime?: string;
  closeIfAskWhatExactly?: string;
  objectionsText?: string;        // "Einwand: Antwort" per line
  dataCollectionIntro?: string;
  dataCollectionFields?: string;  // newline-separated list
  dataCollectionIfDetailsDeclined?: string;
  dataCollectionClosing?: string;
  finalText?: string;
  // Twilio voice process hardcoded prompts → extracted to Dashboard
  consentPrompt?: string;
  decisionMakerGreeting?: string;
  topicExplanation?: string;
  preparationConsent?: string;
  problemBenefitConfirmation?: string;
  appointmentOffer?: string;
  appointmentConfirmation?: string;
  // OpenAI-driven call configuration (replaces hard-coded prompts)
  aiKeyInfo?: string;              // Basisinformationen für den Anruf
  gatekeeperTask?: string;         // Aufgabe beim Empfang
  gatekeeperBehavior?: string;     // Verhalten beim Empfang
  decisionMakerTask?: string;      // Aufgabe beim Entscheider
  decisionMakerBehavior?: string;  // Verhalten beim Entscheider
  appointmentGoal?: string;        // Zielbeschreibung für erfolgreichen Abschluss
  recordingConsentLine?: string;   // Zusätzliche Einwilligungsformulierung (JA/NEIN)
  healthCheckQuestions?: string;   // Gesundheitsfragen als Liste/Textblock
  appointmentTransition?: string;  // Übergang von Bedarf/Einwand in Terminierung
  appointmentSchedulingRules?: string; // Konkrete Regeln für Datum/Uhrzeit/Alternativen
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
  scriptsStorageMode: "postgres" | "file";
}
