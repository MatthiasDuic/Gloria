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
export type LeadCustomerKind = "privat" | "firma";
export type LeadCustomerOwner = "BarmeniaGothaer" | "Agentur-Duic";
export type ReportOutcome =
  | "Termin"
  | "Absage"
  | "Wiedervorlage"
  | "Nicht erreicht / kein Kontakt"
  | "Gespräch abgebrochen";

export interface LeadEmailActivity {
  id: string;
  source: "gloria" | "outlook";
  subject: string;
  body?: string;
  to?: string;
  sentAt: string;
  createdAt: string;
}

export interface LeadTask {
  id: string;
  title: string;
  topic?: string;
  dueAt?: string;
  status: "open" | "done";
  createdAt: string;
  completedAt?: string;
}

export interface LeadActivity {
  id: string;
  type: "details_updated" | "note_updated" | "email_logged" | "task_created" | "task_completed";
  message: string;
  createdAt: string;
}

export type LeadPipelineStage = "neu" | "qualifiziert" | "angebot" | "verhandlung" | "gewonnen" | "verloren";

export interface LeadPipeline {
  stage: LeadPipelineStage;
  valueEUR?: number;
  probability?: number;
  expectedCloseAt?: string;
  updatedAt: string;
}

export interface CrmSavedView {
  id: string;
  name: string;
  search: string;
  owner: "" | "BarmeniaGothaer" | "Agentur-Duic";
  customerKind: "" | "privat" | "firma";
  pipelineStage: "" | LeadPipelineStage;
  contactFilter: "" | "mitEmail" | "ohneEmail" | "mitTelefon";
  createdAt: string;
}

export interface CrmUiPreferences {
  crmTab?: "customers" | "pipeline" | "callbacks";
  crmDetailTab?: "stammdaten" | "produkte" | "pipeline" | "historie" | "kommunikation" | "termine" | "aufgaben" | "zugehoerigkeiten";
  crmSearch?: string;
  crmTypeFilter?: "" | "BarmeniaGothaer" | "Agentur-Duic";
  crmCustomerKindFilter?: "" | "privat" | "firma";
  crmPipelineFilter?: "" | LeadPipelineStage;
  crmContactFilter?: "" | "mitEmail" | "ohneEmail" | "mitTelefon";
}

export interface LeadAffiliation {
  id: string;
  companyId?: string;
  companyName: string;
  role: string;
  createdAt: string;
}

export interface LeadProductDetail {
  id: string;
  category: string;
  label: string;
  insurer?: string;
  contractNumber?: string;
  premium?: string;
  paymentMethod?: string;
  productType?: string;
  energyType?: string;
  startDate?: string;
  endDate?: string;
  notes?: string;
  documentName?: string;
  documentUrl?: string;
  createdAt: string;
}

export interface Lead {
  id: string;
  userId?: string;
  listId?: string;
  listName?: string;
  customerKind?: LeadCustomerKind;
  customerOwner?: LeadCustomerOwner;
  company: string;
  contactName: string;
  phone: string;
  directDial?: string;
  email?: string;
  birthDate?: string;
  location?: string;
  addressStreet?: string;
  addressPostalCode?: string;
  addressCity?: string;
  addressCountry?: string;
  products?: string[];
  productDetails?: LeadProductDetail[];
  affiliations?: LeadAffiliation[];
  emailHistory?: LeadEmailActivity[];
  tasks?: LeadTask[];
  activities?: LeadActivity[];
  crmPipeline?: LeadPipeline;
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
  /** Beispielantworten und Formulierungen, die Gloria als Stilvorlage nutzen darf. */
  exampleSentences?: string;
  /** Ziel des Anrufs; was Gloria mit dem Gespräch erreichen will. */
  callObjective?: string;
  /** Beispieltext für die Begrüßung, wenn die Zielperson selbst am Telefon ist. */
  greetingDecisionMaker?: string;
  /** Beispieltext für die Begrüßung am Empfang bzw. beim Gatekeeper. */
  greetingGatekeeper?: string;
  /** Beispieltext für den Grund des Anrufs. */
  reasonForCall?: string;
  /** Beispieltext für die Relevanzfrage. */
  relevanceQuestion?: string;
  /** Beispieltext für die Beitragsermittlung. */
  contributionQuestion?: string;
  /** Beispieltext für die Hochrechnung und die Brücke zum Nutzungsvorteil. */
  projectionText?: string;
  // Legacy-/Kompatibilitätsfelder ------------------------------------------------
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
