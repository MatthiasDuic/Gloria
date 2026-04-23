// Gloria spricht ausschließlich über ElevenLabs TTS. OpenAI liefert den Text
// via Chat Completions — kein Realtime-Audio, keine OpenAI-Stimme.
export const AI_CONFIG = {
  chatModel: process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-4o-realtime-preview",
} as const;
