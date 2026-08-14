import { fetch } from "undici";
import { log } from "./log.js";
import type { VoiceProfile } from "./topic-policy.js";

export type ParsedWav = {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  samples: Int16Array;
};

export type TtsStreamHandle = {
  /** Resolves when streaming finished or aborted. */
  done: Promise<void>;
  /** Stop downloading and discard remaining audio (used for barge-in). */
  abort: () => void;
  /** True if abort() wurde aufgerufen (Barge-in). */
  readonly aborted: boolean;
};

/**
 * Pre-warmt die TLS/HTTP-Verbindung zu ElevenLabs, damit die ALLERERSTE TTS-
 * Anfrage (Glorias Begrüßung) nicht durch einen frischen TLS-Handshake
 * verzögert wird. Wird beim "start"-Event eines Calls aufgerufen.
 */
export function prewarmElevenLabs(): void {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    log.error("tts.missing_config", { keyPresent: false, voicePresent: Boolean(process.env.ELEVENLABS_VOICE_ID) });
    return;
  }
  void fetch("https://api.elevenlabs.io/v1/user", {
    method: "GET",
    headers: { "xi-api-key": apiKey },
  })
    .then((res) => {
      void res.text().catch(() => undefined);
      log.info("tts.prewarm_ok", { status: res.status });
      if (res.status >= 400) {
        log.warn("tts.auth_probe_failed", {
          status: res.status,
          keyFingerprint: keyFingerprint(apiKey),
        });
      }
    })
    .catch(() => {
      /* ignore – best effort */
    });
}

/**
 * Streams ElevenLabs TTS as μ-law 8000 Hz audio and invokes `onChunk`
 * with raw μ-law buffers (typically ~160-640 bytes).
 */
export function streamElevenLabsToMulaw(
  text: string,
  onChunk: (mulaw: Buffer) => void,
  selectedVoiceId?: string,
  voiceProfile?: VoiceProfile,
): TtsStreamHandle {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = (selectedVoiceId || process.env.ELEVENLABS_VOICE_ID || "").trim();
  const modelId = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

  const controller = new AbortController();
  const done = (async () => {
    try {
      if (!apiKey || !voiceId) {
        log.error("tts.missing_config", {
          keyPresent: Boolean(apiKey),
          voicePresent: Boolean(voiceId),
          keyFingerprint: keyFingerprint(apiKey),
        });
        throw new Error("elevenlabs unavailable");
      }

      const manualVoiceSettings = boolEnv("ELEVENLABS_MANUAL_VOICE_SETTINGS", false);
      const stability = manualVoiceSettings
        ? numEnv("ELEVENLABS_STABILITY", voiceProfile?.stability ?? 0.27)
        : (voiceProfile?.stability ?? 0.27);
      const similarity = manualVoiceSettings
        ? numEnv("ELEVENLABS_SIMILARITY", voiceProfile?.similarity ?? 0.86)
        : (voiceProfile?.similarity ?? 0.86);
      const style = manualVoiceSettings
        ? numEnv("ELEVENLABS_STYLE", voiceProfile?.style ?? 0.62)
        : (voiceProfile?.style ?? 0.62);
      const speed = manualVoiceSettings
        ? numEnv("ELEVENLABS_SPEED", voiceProfile?.speed ?? 0.9)
        : (voiceProfile?.speed ?? 0.9);
      const speakerBoost = manualVoiceSettings
        ? boolEnv("ELEVENLABS_SPEAKER_BOOST", voiceProfile?.speakerBoost ?? false)
        : (voiceProfile?.speakerBoost ?? false);
      const latencyMode = intEnv("ELEVENLABS_LATENCY_MODE", 1, 0, 4);
      const url = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
      url.searchParams.set("output_format", "ulaw_8000");
      url.searchParams.set("optimize_streaming_latency", String(latencyMode));

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "content-type": "application/json",
          accept: "audio/basic",
        },
        body: JSON.stringify({
          text: applyPronunciationFixes(text),
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarity,
            style,
            use_speaker_boost: speakerBoost,
            speed,
          },
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = res.body ? await res.text() : "";
        log.error("tts.http_error", {
          status: res.status,
          body: body.slice(0, 200),
          keyFingerprint: keyFingerprint(apiKey),
          voiceId,
          modelId,
          voiceProfile: voiceProfile?.profileName,
        });
        throw new Error(`elevenlabs ${res.status}`);
      }

      const reader = res.body.getReader();
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        if (controller.signal.aborted) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
        if (value && value.byteLength > 0) {
          onChunk(Buffer.from(value));
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      log.error("tts.stream_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (process.env.OPENAI_API_KEY) {
        log.warn("tts.falling_back_to_openai", { text: text.slice(0, 80) });
        const fallback = streamOpenAiTtsToMulaw(text, onChunk);
        await fallback.done;
      }
    }
  })();

  return {
    done: done.catch(() => undefined).then(() => undefined),
    abort: () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    },
    get aborted() {
      return controller.signal.aborted;
    },
  };
}

export function parseWavToPcm16(buffer: Buffer): ParsedWav {
  const header = buffer.subarray(0, 44);
  const riff = header.toString("ascii", 0, 4);
  const wave = header.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Unsupported WAV header");
  }

  const audioFormat = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bitsPerSample = header.readUInt16LE(34);
  const dataOffset = 44;
  const dataSize = header.readUInt32LE(40);
  const payload = buffer.subarray(dataOffset, dataOffset + dataSize);

  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV format ${audioFormat}`);
  }

  const sampleBytes = bitsPerSample / 8;
  const sampleCount = payload.length / sampleBytes;
  const samples = new Int16Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const start = index * sampleBytes;
    samples[index] = payload.readInt16LE(start);
  }

  return {
    sampleRate,
    channels,
    bitDepth: bitsPerSample,
    samples,
  };
}

export function buildOpenAiTtsRequest(text: string): {
  model: string;
  input: string;
  voice: string;
  response_format: string;
} {
  return {
    model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
    input: applyPronunciationFixes(text),
    voice: process.env.OPENAI_TTS_VOICE || "alloy",
    response_format: "wav",
  };
}

export function streamOpenAiTtsToMulaw(text: string, onChunk: (mulaw: Buffer) => void): TtsStreamHandle {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("tts.openai_missing_config", { keyPresent: false });
    return { done: Promise.resolve(), abort: () => undefined, aborted: false };
  }

  const controller = new AbortController();
  const done = (async () => {
    try {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildOpenAiTtsRequest(text)),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = res.body ? await res.text() : "";
        log.error("tts.openai_http_error", {
          status: res.status,
          body: body.slice(0, 200),
        });
        return;
      }

      const audioBytes = Buffer.from(await res.arrayBuffer());
      const parsed = parseWavToPcm16(audioBytes);
      const pcm = parsed.samples;
      const mulaw = Buffer.alloc(pcm.length);
      for (let i = 0; i < pcm.length; i += 1) {
        mulaw[i] = pcmToMulaw(pcm[i]);
      }
      onChunk(mulaw);
    } catch (error) {
      if (!controller.signal.aborted) {
        log.error("tts.openai_stream_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  })();

  return {
    done,
    abort: () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    },
    get aborted() {
      return controller.signal.aborted;
    },
  };
}

function pcmToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;

  let pcm = Math.max(-32768, Math.min(32767, sample));
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > CLIP) pcm = CLIP;

  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function keyFingerprint(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

/**
 * Ersetzt Eigennamen, die das TTS-Modell falsch ausspricht, durch
 * eine phonetisch passendere Schreibweise. Die LLM-Logik und das Log
 * bleiben unverändert – nur die hörbare Ausgabe wird korrigiert.
 */
function applyPronunciationFixes(text: string): string {
  let out = text;
  // "Duic" -> klingt im Deutschen wie "Du-itsch" (Bindestrich erzwingt
  // bei ElevenLabs eine deutliche Trennung der Silben, sonst wird das
  // "i" verschluckt und es klingt wie "Duc").
  out = out.replace(/\bDuic\b/g, "Du-itsch");
  // "Sprockhövel" wird gelegentlich verschluckt – Bindestrich hilft beim Tempo.
  out = out.replace(/\bSprockhövel\b/g, "Sprock-Hövel");
  // Wortwahl: "private/privaten Krankenversicherung(sbeiträge)" -> "Krankenversicherung(sbeiträge)"
  out = out.replace(/\b(privaten|private|privater|privates|privat)\s+Krankenversicherung/gi, "Krankenversicherung");
  // Dezimalzahlen fuer TTS robuster machen: "2,5" -> "2 komma 5"
  out = out.replace(/(\d)\s*,\s*(\d)/g, "$1 komma $2");
  // Tausenderpunkte vermeiden, damit TTS keine "Punkt"-Pause spricht.
  out = out.replace(/\b(\d)\.(\d{3})\b/g, "$1$2");
  // Saubere Endungen: ein TTS-Segment ohne abschließendes Satzzeichen wird
  // von ElevenLabs intonatorisch "in der Schwebe" gelassen – der letzte
  // Vokal klingt dann verschluckt. Wir hängen einen Punkt an, falls keiner
  // vorhanden ist. Das ist beim satzweisen Pipelining besonders wichtig.
  const trimmed = out.trim();
  if (trimmed.length > 0 && !/[.!?;:,…”"')\]]$/.test(trimmed)) {
    out = `${trimmed}.`;
  }
  return out;
}
