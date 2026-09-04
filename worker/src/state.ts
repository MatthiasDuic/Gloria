import {
  detectTopicKind,
  createVoiceProfile,
  type TopicKind,
  type VoiceProfile,
} from "./topic-policy.js";

export type DialogPhase = "opener" | "discovery" | "objection" | "close" | "done";

/**
 * PKV-specific step counter for explicit state machine flow.
 * 0 = awaiting permission ("Darf ich sagen worum es geht?")
 * 1 = RELEVANZ (explain rising costs, open question)
 * 2 = BEITRAG (ask for current monthly contribution)
 * 3 = HOCHRECHNUNG (present 10-year projection)
 * 4 = KONZEPT (explain Herr Duic's approach, ask for interest)
 * 5 = TERMIN (schedule appointment)
 */
export type PkvStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type DialogState = {
  phase: DialogPhase;
  pkvStep: PkvStep; // Current step in PKV conversation flow
  askedQuestions: Set<string>;
  answeredQuestions: Set<string>;
  phaseStartedAt: number;
};

export type CallContext = {
  callSid: string;
  streamSid: string;
  startedAt: number;
  // Custom parameters passed through the Telnyx stream client state.
  userId?: string;
  leadId?: string;
  company?: string;
  contactName?: string;
  leadNote?: string;
  topic?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  voiceId?: string;
  topicKind: TopicKind;
  voiceProfile: VoiceProfile;
  // Optionaler, bereits formatierter Topic-Policy-Abschnitt (vom Vercel-Backend).
  topicPolicyPrompt?: string;
  // Wiedervorlage-Anruf: Zusammenfassung des vorherigen Gesprächs (vom Backend
  // beim auto-Wiederanruf mitgegeben). Wird im System-Prompt verwendet, damit
  // Gloria mit einer kurzen Recap eröffnet und direkt in Phase 7 (Termin) einsteigt.
  previousSummary?: string;
  isCallback?: boolean;
  // Vom Anrufenden bestätigte Termin-Phrase (z. B. "Donnerstag, den siebten Mai um vierzehn Uhr dreißig").
  // Sobald gesetzt, MUSS Phase 10 diese Phrase wortwörtlich übernehmen.
  confirmedSlotPhrase?: string;
  appointmentMode?: "Beim Kunden vor Ort" | "In der Agentur" | "Microsoft Teams";
  // Bereits belegte Termin-Slots (für diesen User). In Berlin-Zeit-Strings,
  // werden in den System-Prompt injiziert, damit Gloria keine Doppelbelegung vorschlägt.
  busySlotsPrompt?: string;
  // Adaptive Slot-Vorschläge: 4–6 freie 30-Min-Slots in den nächsten 5 Geschäftstagen,
  // berechnet aus der Busy-Liste. Wenn der Anrufende einen Vorschlag ablehnt, kann
  // Gloria aus dieser Liste alternative Slots ziehen, ohne Doppelbelegung.
  freeSlotsPrompt?: string;
  // Conversation memory.
  memory: {
    facts: string[];
    concerns: string[];
    preferences: string[];
    tone: "neutral" | "skeptical" | "open" | "rushed";
  };
  // Dialog State Machine – tracks phase, asked/answered questions, prevents repetition
  dialogState: DialogState;
  transcript: Array<{
    role: "user" | "assistant";
    text: string;
    /** Wall-clock ms when speech ended (assistant) bzw. wann die ASR final wurde (user). */
    at: number;
    /** Reaktionszeit in ms: nur bei assistant-Einträgen befüllt. */
    latencyMs?: number;
    /** Aktueller Gesprächsschritt für die spätere Qualitätsauswertung. */
    phase?: string;
  }>;
  /** Wall-clock ms des letzten user-Final – wird zur Latenz-Berechnung genutzt. */
  lastUserFinalAt?: number;
  // Speaking flag — used for barge-in detection.
  speaking: boolean;
  // Counter for inbound user utterances during a Gloria turn (used to abort TTS).
  userBytesWhileSpeaking: number;
  // Runtime-Klassifikation fuer Spezialfaelle im Call.
  detectedVoicemail?: boolean;
  waitingForDecisionMaker?: boolean;
  queueDetected?: boolean;
};

export function newContext(initial: Partial<CallContext> & { callSid: string; streamSid: string }): CallContext {
  const topic = initial.topic;
  return {
    memory: {
      facts: [],
      concerns: [],
      preferences: [],
      tone: "neutral",
    },
    dialogState: {
      phase: "opener",
      pkvStep: 0,
      askedQuestions: new Set(),
      answeredQuestions: new Set(),
      phaseStartedAt: Date.now(),
    },
    transcript: [],
    speaking: false,
    userBytesWhileSpeaking: 0,
    startedAt: Date.now(),
    ...initial,
    topicKind: initial.topicKind || detectTopicKind(topic),
    voiceProfile: initial.voiceProfile || createVoiceProfile(topic),
  };
}
