import { fetch } from "undici";

export type ElevenLabsOutputFormat = "alaw_8000" | "ulaw_8000";

const DEFAULT_VOICE_ID = "Ywa4Py8gVz5ugeNVy6iC";

function getApiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() || "";
}

function getVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
}

export function isElevenLabsConfigured(): boolean {
  return Boolean(getApiKey() && getVoiceId());
}

export async function streamElevenLabsAudio(
  text: string,
  outputFormat: ElevenLabsOutputFormat,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const apiKey = getApiKey();
  const voiceId = getVoiceId();
  if (!apiKey || !voiceId) throw new Error("ELEVENLABS_API_KEY oder ELEVENLABS_VOICE_ID fehlt");

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${outputFormat}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/basic",
      },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2",
        voice_settings: { stability: 0.42, similarity_boost: 0.9, style: 0.38, use_speaker_boost: true },
      }),
      signal,
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS antwortete ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}`);
  }
  if (!response.body) throw new Error("ElevenLabs TTS lieferte keinen Audiostream");

  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      if (result.value?.length) onChunk(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
}
