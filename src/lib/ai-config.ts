export const AI_CONFIG = {
  chatModel: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-4o-realtime-preview",
  realtimeVoice: process.env.OPENAI_REALTIME_VOICE?.trim() || "alloy",
} as const;
