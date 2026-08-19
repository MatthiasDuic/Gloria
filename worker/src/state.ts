import {
  detectTopicKind,
  createVoiceProfile,
  type TopicKind,
  type VoiceProfile,
} from "./topic-policy.js";

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
  transcript: Array<{
    role: "user" | "assistant";
    text: string;
    /** Wall-clock ms when speech ended (assistant) bzw. wann die ASR final wurde (user). */
    at: number;
    /** Reaktionszeit in ms: nur bei assistant-Einträgen befüllt. */
    latencyMs?: number;
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
    transcript: [],
    speaking: false,
    userBytesWhileSpeaking: 0,
    startedAt: Date.now(),
    ...initial,
    topicKind: initial.topicKind || detectTopicKind(topic),
    voiceProfile: initial.voiceProfile || createVoiceProfile(topic),
  };
}
