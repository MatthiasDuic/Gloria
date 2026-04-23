// Gloria spricht ausschließlich über ElevenLabs TTS. OpenAI liefert den Text
// via Chat Completions — kein Realtime-Audio, keine OpenAI-Stimme.
const configuredChatModel = process.env.OPENAI_MODEL?.trim();
const isLegacyModel =
  configuredChatModel === "gpt-4.1-mini" || configuredChatModel === "gpt-4o-mini";

export const AI_CONFIG = {
  // Upgrade-Schutz: alte Standardmodelle werden automatisch auf gpt-5 angehoben.
  // Falls der Account z. B. "gpt-5.4" freigeschaltet hat, kann OPENAI_MODEL direkt darauf gesetzt werden.
  chatModel: !configuredChatModel || isLegacyModel ? "gpt-5" : configuredChatModel,
  realtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-4o-realtime-preview",
} as const;
