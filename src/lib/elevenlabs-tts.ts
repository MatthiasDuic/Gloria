export interface ElevenLabsVoiceOption {
  id: string;
  name: string;
  category?: string;
}

export type ElevenLabsPreviewResult = {
  provider: "elevenlabs";
  audioBase64?: string;
  audioMimeType?: string;
  error?: string;
};

function getApiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() || "";
}

export function isElevenLabsConfigured(): boolean {
  return Boolean(getApiKey() && getDefaultElevenLabsVoiceId());
}

export function getDefaultElevenLabsVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || "";
}

export function getProjectVoicePresets(): ElevenLabsVoiceOption[] {
  const voiceId = getDefaultElevenLabsVoiceId();
  return voiceId
    ? [{ id: voiceId, name: process.env.ELEVENLABS_VOICE_NAME?.trim() || "Gloria", category: "default" }]
    : [];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function generateElevenLabsPreview(text: string, overrideVoiceId?: string): Promise<ElevenLabsPreviewResult> {
  const apiKey = getApiKey();
  const voiceId = (overrideVoiceId || getDefaultElevenLabsVoiceId()).trim();
  if (!apiKey || !voiceId) {
    return { provider: "elevenlabs", error: "ELEVENLABS_API_KEY oder ELEVENLABS_VOICE_ID fehlt." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL?.trim() || "eleven_multilingual_v2",
        output_format: "mp3_44100_128",
        voice_settings: { stability: 0.42, similarity_boost: 0.9, style: 0.38, use_speaker_boost: true },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      return { provider: "elevenlabs", error: `ElevenLabs TTS antwortete ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}` };
    }
    return {
      provider: "elevenlabs",
      audioBase64: toBase64(new Uint8Array(await response.arrayBuffer())),
      audioMimeType: "audio/mpeg",
    };
  } catch (error) {
    return {
      provider: "elevenlabs",
      error: error instanceof Error && error.name === "AbortError" ? "ElevenLabs TTS-Timeout." : "ElevenLabs ist momentan nicht erreichbar.",
    };
  } finally {
    clearTimeout(timeout);
  }
}