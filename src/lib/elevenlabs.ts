interface ElevenLabsResult {
  provider: "elevenlabs" | "browser";
  audioBase64?: string;
  audioMimeType?: string;
  error?: string;
}

export interface ElevenLabsVoiceOption {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

const CURATED_PROJECT_VOICES: ElevenLabsVoiceOption[] = [
  { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
  { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli" },
  { id: "AZnzlk1XvdvUeBnXmlld", name: "Domi" },
  { id: "ThT5KcBeYPX3keUQqHPh", name: "Dorothy" },
  { id: "TxGEqnHWrfWFTfGW9XjX", name: "Josh" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam" },
  { id: "yoZ06aMxZJJ28mfd3POQ", name: "Sam" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold" },
  { id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
];

export function getProjectVoicePresets(): ElevenLabsVoiceOption[] {
  return CURATED_PROJECT_VOICES.map((voice) => ({ ...voice }));
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
  languageCode: string;
}

// Defaults sind darauf ausgelegt, dass Gloria am Telefon natuerlich klingt
// und die Antwortlatenz fuer den Anrufer kurz bleibt:
//   - modelId eleven_multilingual_v2: hoechste Natuerlichkeit fuer Deutsch
//   - latencyMode 3: deutlich schnelleres First-Byte beim Streaming, ohne
//     dass die Stimme spuerbar blechern wird (Level 4 reduziert Qualitaet
//     bemerkbar). Wer die maximale Audioqualitaet bevorzugt, kann via
//     ELEVENLABS_LATENCY_MODE=0 zurueckschalten.
//   - stability 0.5: ruhig und konsistent, aber nicht monoton
//   - style 0.3: natuerliche Betonung ohne ueberdrehten Schauspieler-Ton
//   - speed 0.88: klar hoerbar entschleunigt fuer Telefonie
//   - languageCode "de": saubere deutsche Aussprache
const ELEVENLABS_CONFIG: ElevenLabsConfig = {
  apiKey: process.env.ELEVENLABS_API_KEY?.trim() || "",
  voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || "",
  modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2",
  latencyMode: process.env.ELEVENLABS_LATENCY_MODE?.trim() || "3",
  stability: Number(process.env.ELEVENLABS_STABILITY || 0.5),
  similarityBoost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.85),
  style: Number(process.env.ELEVENLABS_STYLE || 0.3),
  speed: Number(process.env.ELEVENLABS_SPEED || 0.88),
  useSpeakerBoost: (process.env.ELEVENLABS_USE_SPEAKER_BOOST || "true") === "true",
  languageCode: process.env.ELEVENLABS_LANGUAGE_CODE?.trim() || "de",
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
    // Gedankenstriche zu echten kurzen Pausen machen (Komma statt Bindestrich-Sound).
    .replace(/\s+-\s+/g, ", ")
    .replace(/[–—]/g, ", ")
    // Eckige Regie-Klammern wie "[kurze Pause für Zustimmung]" oder
    // "[Antwort abwarten]" wuerde ElevenLabs sonst woertlich vorlesen.
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/([.!?])\1+/g, "$1")
    .trim();
}

function buildSpeechBody(text: string) {
  return {
    text: buildSpeechText(text),
    model_id: ELEVENLABS_CONFIG.modelId,
    language_code: ELEVENLABS_CONFIG.languageCode,
    apply_text_normalization: "auto" as const,
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
  voiceId?: string;
}): Promise<Response> {
  const selectedVoiceId = (params.voiceId || ELEVENLABS_CONFIG.voiceId || "").trim();
  if (!selectedVoiceId) {
    throw new Error("Keine ElevenLabs-Stimme konfiguriert.");
  }

  const modePath = params.stream ? "stream" : "";
  const basePath = `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`;
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

export function getDefaultElevenLabsVoiceId(): string {
  return ELEVENLABS_CONFIG.voiceId;
}

export async function listElevenLabsVoices(): Promise<ElevenLabsVoiceOption[]> {
  if (!ELEVENLABS_CONFIG.apiKey) {
    return [];
  }

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      method: "GET",
      headers: {
        "xi-api-key": ELEVENLABS_CONFIG.apiKey,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as {
      voices?: Array<{
        voice_id?: string;
        name?: string;
        category?: string;
        labels?: Record<string, string>;
      }>;
    };

    const voices = Array.isArray(payload.voices) ? payload.voices : [];
    return voices
      .map((entry) => ({
        id: String(entry.voice_id || "").trim(),
        name: String(entry.name || "").trim() || "Unbenannte Stimme",
        category: entry.category ? String(entry.category) : undefined,
        labels: entry.labels || undefined,
      }))
      .filter((entry) => Boolean(entry.id));
  } catch {
    return [];
  }
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
          voiceId: ELEVENLABS_CONFIG.voiceId,
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
    voiceId: ELEVENLABS_CONFIG.voiceId,
  });

  if (!response.ok || !response.body) {
    const details = await response.text().catch(() => "");
    throw new Error(`ElevenLabs Fehler: ${response.status} ${details}`.trim());
  }

  return response;
}

export async function generateElevenLabsPreview(
  text: string,
  overrideVoiceId?: string,
): Promise<ElevenLabsResult> {
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
      voiceId: overrideVoiceId,
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
