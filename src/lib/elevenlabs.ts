interface ElevenLabsResult {
  provider: "elevenlabs" | "browser";
  audioBase64?: string;
  audioMimeType?: string;
  error?: string;
}

interface ElevenLabsConfig {
  apiKey: string;
  voiceId: string;
  modelId: string;
  latencyMode: string;
  stability: number;
  similarityBoost: number;
  style: number;
  speed: number;
  useSpeakerBoost: boolean;
}

const ELEVENLABS_CONFIG: ElevenLabsConfig = {
  apiKey: process.env.ELEVENLABS_API_KEY?.trim() || "",
  voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || "",
  modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2",
  latencyMode: process.env.ELEVENLABS_LATENCY_MODE?.trim() || "2",
  stability: Number(process.env.ELEVENLABS_STABILITY || 0.34),
  similarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.88),
  style: Number(process.env.ELEVENLABS_STYLE || 0.42),
  speed: Number(process.env.ELEVENLABS_SPEED || 0.9),
  useSpeakerBoost: (process.env.ELEVENLABS_USE_SPEAKER_BOOST || "true") === "true",
};

const WARMUP_INTERVAL_MS = 60_000;
let lastWarmupAt = 0;
let warmupInFlight: Promise<void> | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function buildSpeechText(text: string): string {
  return text
    .replace(/hier ist Gloria,\s*digitale/gi, "hier ist Gloria, die digitale")
    .replaceAll("zu Schulungs- und Qualitätszwecken", "für Schulung und Qualitätssicherung")
    .replaceAll("zu Schulungs und Qualitätszwecken", "für Schulung und Qualitätssicherung")
    .replaceAll("zu Schulungs- und Qualitaetszwecken", "für Schulung und Qualitätssicherung")
    .replaceAll("zu Schulungs und Qualitaetszwecken", "für Schulung und Qualitätssicherung")
    .replaceAll("im Auftrag von Herrn Matthias Duic", "im Auftrag von Matthias Duic")
    .replaceAll("von Herrn Matthias Duic", "von Matthias Duic")
    .replaceAll(" - ", ", ")
    .replace(/[–—]/g, ", ")
    .replace(/\s+/g, " ")
    .replace(/([.!?])\1+/g, "$1")
    .trim();
}

function buildSpeechBody(text: string) {
  return {
    text: buildSpeechText(text),
    model_id: ELEVENLABS_CONFIG.modelId,
    voice_settings: {
      stability: ELEVENLABS_CONFIG.stability,
      similarity_boost: ELEVENLABS_CONFIG.similarityBoost,
      style: ELEVENLABS_CONFIG.style,
      speed: ELEVENLABS_CONFIG.speed,
      use_speaker_boost: ELEVENLABS_CONFIG.useSpeakerBoost,
    },
  };
}

async function requestElevenLabsAudio(params: {
  text: string;
  outputFormat: "mp3_44100_128" | "ulaw_8000";
  accept: string;
  stream: boolean;
}): Promise<Response> {
  const modePath = params.stream ? "stream" : "";
  const basePath = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_CONFIG.voiceId}`;
  const endpoint = modePath ? `${basePath}/${modePath}` : basePath;
  const url = new URL(endpoint);
  url.searchParams.set("optimize_streaming_latency", ELEVENLABS_CONFIG.latencyMode);
  url.searchParams.set("output_format", params.outputFormat);

  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: params.accept,
      "xi-api-key": ELEVENLABS_CONFIG.apiKey,
    },
    body: JSON.stringify(buildSpeechBody(params.text)),
    cache: "no-store",
  });
}

export function isElevenLabsConfigured() {
  return Boolean(ELEVENLABS_CONFIG.apiKey && ELEVENLABS_CONFIG.voiceId);
}

export function maybeWarmupElevenLabsVoice(force = false): Promise<void> {
  if (!isElevenLabsConfigured()) {
    return Promise.resolve();
  }

  const now = Date.now();
  if (!force && now - lastWarmupAt < WARMUP_INTERVAL_MS) {
    return Promise.resolve();
  }

  if (!warmupInFlight) {
    warmupInFlight = (async () => {
      try {
        await requestElevenLabsAudio({
          text: "Hi.",
          outputFormat: "ulaw_8000",
          accept: "audio/basic",
          stream: true,
        });
      } catch {
        // Warmup is best-effort and must never block voice handling.
      } finally {
        lastWarmupAt = Date.now();
        warmupInFlight = null;
      }
    })();
  }

  return warmupInFlight;
}

export async function generateElevenLabsTelephonyStream(text: string): Promise<Response> {
  const response = await requestElevenLabsAudio({
    text,
    outputFormat: "ulaw_8000",
    accept: "audio/basic",
    stream: true,
  });

  if (!response.ok || !response.body) {
    const details = await response.text().catch(() => "");
    throw new Error(`ElevenLabs Fehler: ${response.status} ${details}`.trim());
  }

  return response;
}

export async function generateElevenLabsPreview(text: string): Promise<ElevenLabsResult> {
  if (!isElevenLabsConfigured()) {
    return {
      provider: "browser",
      error: "ElevenLabs ist noch nicht konfiguriert.",
    };
  }

  try {
    const response = await requestElevenLabsAudio({
      text,
      outputFormat: "mp3_44100_128",
      accept: "audio/mpeg",
      stream: false,
    });

    if (!response.ok) {
      const details = await response.text();

      return {
        provider: "browser",
        error: `ElevenLabs Fehler: ${response.status} ${details}`,
      };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());

    return {
      provider: "elevenlabs",
      audioBase64: toBase64(bytes),
      audioMimeType: "audio/mpeg",
    };
  } catch (error) {
    return {
      provider: "browser",
      error:
        error instanceof Error
          ? `ElevenLabs ist momentan nicht erreichbar: ${error.message}`
          : "ElevenLabs ist momentan nicht erreichbar.",
    };
  }
}
