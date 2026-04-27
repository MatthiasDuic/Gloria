export type CallContext = {
  callSid: string;
  streamSid: string;
  startedAt: number;
  // Custom params set via <Parameter name="..."/> in TwiML.
  userId?: string;
  leadId?: string;
  company?: string;
  contactName?: string;
  topic?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  // Optionaler, bereits formatierter Playbook-Abschnitt (vom Vercel-Backend).
  playbookPrompt?: string;
  // Conversation memory.
  transcript: Array<{ role: "user" | "assistant"; text: string; at: number }>;
  // Speaking flag — used for barge-in detection.
  speaking: boolean;
  // Counter for inbound user utterances during a Gloria turn (used to abort TTS).
  userBytesWhileSpeaking: number;
};

export function newContext(initial: Partial<CallContext> & { callSid: string; streamSid: string }): CallContext {
  return {
    transcript: [],
    speaking: false,
    userBytesWhileSpeaking: 0,
    startedAt: Date.now(),
    ...initial,
  };
}
