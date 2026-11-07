import {
  detectTopicKind,
  createVoiceProfile,
  type TopicKind,
  type VoiceProfile,
} from "./topic-policy.js";

export type DialogPhase = "opener" | "discovery" | "objection" | "close" | "done";

/**
 * PKV-specific step counter for explicit state machine flow.
 * 0 = reason and short-moment question
 * 1 = contribution trend and initial contribution
 * 2 = current contribution
 * 3 = 10-year projection
 * 4 = concept bridge and interest
 * 6 = appointment scheduling
 */
export type PkvStep = 0 | 1 | 2 | 3 | 4 | 6;

export type DialogState = {
  phase: DialogPhase;
  pkvStep: PkvStep; // Current step in PKV conversation flow
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
  calledPhone?: string;
  contactName?: string;
  leadNote?: string;
  topic?: string;
  policyTopic?: string;
  callObjective?: string;
  ownerRealName?: string;
  ownerRealPhone?: string;
  ownerRole?: "master" | "user";
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  /** Spoken company phrase, e.g. "von der BarmeniaGothaer in Sprockhövel". */
  ownerIntroCompanyPhrase?: string;
  /** Spoken answer to "Woher haben Sie meine Nummer?". */
  ownerDataSourceStatement?: string;
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
  isTestCall?: boolean;
  // Vom Anrufenden bestätigte Termin-Phrase (z. B. "Donnerstag, den siebten Mai um vierzehn Uhr dreißig").
  // Sobald gesetzt, MUSS Phase 10 diese Phrase wortwörtlich übernehmen.
  confirmedSlotPhrase?: string;
  appointmentMode?: "Beim Kunden vor Ort" | "Microsoft Teams";
  // Adaptive Slot-Vorschläge: 4–6 freie 30-Min-Slots in den nächsten 5 Geschäftstagen,
  // berechnet aus der Busy-Liste. Wenn der Anrufende einen Vorschlag ablehnt, kann
  // Gloria aus dieser Liste alternative Slots ziehen, ohne Doppelbelegung.
  freeSlotsPrompt?: string;
  // Conversation memory.
  // Dialog State Machine – tracks phase, asked/answered questions, prevents repetition
  dialogState: DialogState;
  appointmentPreferenceAsked?: boolean;
  appointmentSlotsOffered?: boolean;
  appointmentOfferedSlots?: string[];
  selectedAppointmentSlot?: string;
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
  // Runtime-Klassifikation fuer Spezialfaelle im Call.
  detectedVoicemail?: boolean;
  humanContactDetected?: boolean;
  /** The intended contact person was on the line at some point during the call. */
  decisionMakerReached?: boolean;
  waitingForDecisionMaker?: boolean;
  queueDetected?: boolean;
  /** Campaign-configured short reason for the reception ("Anlass am Empfang"). */
  receptionTopicReason?: string;
  /** Set when Gloria (not the remote party) initiated the hangup. */
  endedByGloria?: boolean;
  endReason?: "voicemail_detected" | "transfer_timeout" | "farewell" | "transferred" | "time_limit" | "error";
  callbackNumberDelivered?: boolean;
  /** The callee objected to further calls (do-not-call); deletion = also asked to delete the data. */
  optOut?: { deletion: boolean };
  /** The intended contact person no longer works at the company. */
  contactLeftCompany?: boolean;
  /** Lead contact before Gloria switched to a named successor. */
  originalContactName?: string;
  /** Successor named by the reception after the original contact left. */
  successorContactName?: string;
};

export function newContext(initial: Partial<CallContext> & { callSid: string; streamSid: string }): CallContext {
  const topic = initial.topic;
  return {
    dialogState: {
      phase: "opener",
      pkvStep: 0,
      phaseStartedAt: Date.now(),
    },
    transcript: [],
    startedAt: Date.now(),
    ...initial,
    topicKind: initial.topicKind || detectTopicKind(initial.policyTopic || topic),
    voiceProfile: initial.voiceProfile || createVoiceProfile(initial.policyTopic || topic),
  };
}
