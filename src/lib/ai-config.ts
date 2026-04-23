// Gloria spricht ausschließlich über ElevenLabs TTS. OpenAI liefert den Text
// via Chat Completions — kein Realtime-Audio, keine OpenAI-Stimme.
const configuredChatModel = process.env.OPENAI_MODEL?.trim();

// Für Telefonie brauchen wir ein latenzarmes Modell. gpt-5 ist ein
// Reasoning-Modell mit 3–8 s Antwortzeit und damit ungeeignet für Live-
// Gespräche (Twilio-Gather bricht ab, Angerufener legt auf).
// gpt-4o-mini liefert stabiles JSON in typisch 400–900 ms und ist der
// richtige Default für Voice. Wer bewusst gpt-4o oder gpt-5 testen will,
// setzt OPENAI_MODEL in der Umgebung.
export const AI_CONFIG = {
  chatModel: configuredChatModel || "gpt-4o-mini",
  realtimeModel: process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-4o-realtime-preview",
} as const;
