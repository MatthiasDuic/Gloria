// Textmodell für Hintergrundaufgaben der App (z. B. Leitfaden-Optimierung).
// Die Telefonate selbst laufen im Worker über OpenAI Realtime (Text) und
// ElevenLabs (Stimme); dieses Modell ist dafür nicht zuständig.
const configuredChatModel = process.env.OPENAI_MODEL?.trim();

export const AI_CONFIG = {
  chatModel: configuredChatModel || "gpt-4.1",
} as const;
