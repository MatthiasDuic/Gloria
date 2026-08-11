// Deepgram Aura TTS – ersetzt ElevenLabs vollständig.
// Verwendet aura-helios-en als Standardstimme (warm, klarer Männerton).

export interface DeepgramVoiceOption {
  id: string;
  name: string;
  category?: string;
  labels?: Record<string, string>;
}

// Alle verfügbaren Deepgram Aura-Stimmen als statische Liste.
const AURA_VOICES: DeepgramVoiceOption[] = [
  { id: "aura-helios-en",   name: "Helios",   category: "male" },
  { id: "aura-zeus-en",     name: "Zeus",     category: "male" },
  { id: "aura-orion-en",    name: "Orion",    category: "male" },
  { id: "aura-arcas-en",    name: "Arcas",    category: "male" },
  { id: "aura-perseus-en",  name: "Perseus",  category: "male" },
  { id: "aura-angus-en",    name: "Angus",    category: "male" },
  { id: "aura-orpheus-en",  name: "Orpheus",  category: "male" },
  { id: "aura-asteria-en",  name: "Asteria",  category: "female" },
  { id: "aura-luna-en",     name: "Luna",     category: "female" },
  { id: "aura-stella-en",   name: "Stella",   category: "female" },
  { id: "aura-athena-en",   name: "Athena",   category: "female" },
  { id: "aura-hera-en",     name: "Hera",     category: "female" },
];

export function getProjectVoicePresets(): DeepgramVoiceOption[] {
  return AURA_VOICES.map((v) => ({ ...v }));
}

export function getDefaultDeepgramVoiceId(): string {
  return process.env.DEEPGRAM_VOICE_MODEL?.trim() || "aura-helios-en";
}

export function isDeepgramConfigured(): boolean {
  return Boolean(process.env.DEEPGRAM_API_KEY?.trim());
}

function getApiKey(): string {
  return process.env.DEEPGRAM_API_KEY?.trim() || "";
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
    .replace(/\s+-\s+/g, ", ")
    .replace(/[–—]/g, ", ")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/([.!?])\1+/g, "$1")
    .trim();
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function requestDeepgramAudio(params: {
  text: string;
  encoding: "mulaw" | "linear16";
  sampleRate: number;
  container?: string;
  voiceId?: string;
}): Promise<Response> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY fehlt.");

  const model = (params.voiceId || getDefaultDeepgramVoiceId()).trim();
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", params.encoding);
  url.searchParams.set("sample_rate", String(params.sampleRate));
  if (params.container) {
    url.searchParams.set("container", params.container);
  }

  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: buildSpeechText(params.text) }),
    cache: "no-store",
  });
}

// Warmup für den WARMUP_INTERVAL, damit der erste Anruf keine TLS-Latenz hat.
const WARMUP_INTERVAL_MS = 60_000;
let lastWarmupAt = 0;
let warmupInFlight: Promise<void> | null = null;

export function maybeWarmupDeepgram(force = false): Promise<void> {
  if (!isDeepgramConfigured()) return Promise.resolve();

  const now = Date.now();
  if (!force && now - lastWarmupAt < WARMUP_INTERVAL_MS) return Promise.resolve();

  if (!warmupInFlight) {
    warmupInFlight = (async () => {
      try {
        const res = await requestDeepgramAudio({
          text: "Hi.",
          encoding: "mulaw",
          sampleRate: 8000,
        });
        await res.body?.cancel().catch(() => undefined);
      } catch {
        // best-effort
      } finally {
        lastWarmupAt = Date.now();
        warmupInFlight = null;
      }
    })();
  }
  return warmupInFlight;
}

export async function generateDeepgramTelephonyStream(text: string, voiceId?: string): Promise<Response> {
  const response = await requestDeepgramAudio({
    text,
    encoding: "mulaw",
    sampleRate: 8000,
    voiceId,
  });

  if (!response.ok || !response.body) {
    const details = await response.text().catch(() => "");
    throw new Error(`Deepgram TTS Fehler: ${response.status} ${details}`.trim());
  }

  return response;
}

interface DeepgramTtsResult {
  provider: "deepgram" | "browser";
  audioBase64?: string;
  audioMimeType?: string;
  error?: string;
}

export async function generateDeepgramPreview(
  text: string,
  overrideVoiceId?: string,
): Promise<DeepgramTtsResult> {
  if (!isDeepgramConfigured()) {
    return { provider: "browser", error: "DEEPGRAM_API_KEY ist nicht konfiguriert." };
  }

  try {
    const response = await requestDeepgramAudio({
      text,
      encoding: "linear16",
      sampleRate: 24000,
      container: "wav",
      voiceId: overrideVoiceId,
    });

    if (!response.ok) {
      const details = await response.text();
      return { provider: "browser", error: `Deepgram TTS Fehler: ${response.status} ${details}` };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      provider: "deepgram",
      audioBase64: toBase64(bytes),
      audioMimeType: "audio/wav",
    };
  } catch (error) {
    return {
      provider: "browser",
      error:
        error instanceof Error
          ? `Deepgram ist momentan nicht erreichbar: ${error.message}`
          : "Deepgram ist momentan nicht erreichbar.",
    };
  }
}
