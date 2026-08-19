import { fetch } from "undici";
import type { VoiceProfile } from "./topic-policy.js";

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
  voiceProfile?: Pick<VoiceProfile, "stability" | "similarity" | "style" | "speed" | "speakerBoost">,
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
        voice_settings: {
          stability: Number.parseFloat(process.env.ELEVENLABS_STABILITY?.trim() || String(voiceProfile?.stability ?? 0.27)),
          similarity_boost: Number.parseFloat(process.env.ELEVENLABS_SIMILARITY?.trim() || String(voiceProfile?.similarity ?? 0.86)),
          style: Number.parseFloat(process.env.ELEVENLABS_STYLE?.trim() || String(voiceProfile?.style ?? 0.62)),
          speed: Number.parseFloat(process.env.ELEVENLABS_SPEED?.trim() || String(voiceProfile?.speed ?? 0.9)),
          use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST?.trim()
            ? process.env.ELEVENLABS_SPEAKER_BOOST.trim() === "true"
            : voiceProfile?.speakerBoost ?? false,
        },
      }),
      signal,
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS antwortete ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}`);
  }
  if (!response.body) throw new Error("ElevenLabs TTS lieferte keinen Audiostream");

  const STALL_TIMEOUT_MS = 8_000;
  const readWithTimeout = (): Promise<{ done: boolean; value?: Uint8Array }> =>
    new Promise((resolve, reject) => {
      const id = setTimeout(
        () => reject(new Error(`ElevenLabs stream stalled after ${STALL_TIMEOUT_MS / 1000}s`)),
        STALL_TIMEOUT_MS,
      );
      reader.read().then(
        (v) => { clearTimeout(id); resolve(v); },
        (e) => { clearTimeout(id); reject(e as Error); },
      );
    });

  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await readWithTimeout();
      if (result.done) return;
      if (result.value?.length) onChunk(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
}
