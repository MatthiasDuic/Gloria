import { fetch } from "undici";
import { log } from "./log.js";

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

/** Pre-warmt die TLS/HTTP-Verbindung zu Deepgram für die erste TTS-Anfrage. */
export function prewarmDeepgram(): void {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    log.error("tts.missing_config", { keyPresent: false });
    return;
  }
  void fetch("https://api.deepgram.com/v1/auth/token", {
    method: "GET",
    headers: { Authorization: `Token ${apiKey}` },
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
 * Streams Deepgram Aura TTS as μ-law 8000 Hz audio and invokes `onChunk`
 * with raw μ-law buffers (typically ~160-640 bytes).
 */
export function streamDeepgramToMulaw(
  text: string,
  onChunk: (mulaw: Buffer) => void,
  selectedVoiceId?: string,
): TtsStreamHandle {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const model = (selectedVoiceId || process.env.DEEPGRAM_VOICE_MODEL || "aura-helios-en").trim();

  const controller = new AbortController();
  const done = (async () => {
    try {
      if (!apiKey) {
        log.error("tts.missing_config", {
          keyPresent: false,
          keyFingerprint: keyFingerprint(apiKey),
        });
        throw new Error("deepgram unavailable");
      }

      const url = new URL("https://api.deepgram.com/v1/speak");
      url.searchParams.set("model", model);
      url.searchParams.set("encoding", "mulaw");
      url.searchParams.set("sample_rate", "8000");

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text: applyPronunciationFixes(text) }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const body = res.body ? await res.text() : "";
        log.error("tts.http_error", {
          status: res.status,
          body: body.slice(0, 200),
          keyFingerprint: keyFingerprint(apiKey),
          model,
        });
        throw new Error(`deepgram ${res.status}`);
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
      // Note: OpenAI TTS is fallback only; Deepgram Aura is the primary TTS.
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
  const pcm = Math.max(-32768, Math.min(32767, sample));
  const sign = pcm < 0 ? 0x80 : 0x00;
  const abs = Math.abs(pcm);
  const magnitude = Math.min(32767, abs);
  const normalized = magnitude / 32768;
  const exp = Math.max(0, Math.min(7, Math.floor(Math.log2(normalized * 255))));
  const mantissa = Math.floor((normalized * 255) / (2 ** exp));
  return sign | (exp << 4) | mantissa;
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
  out = out.replace(/\bDuic\b/g, "Du-itsch");
  // "Sprockhövel" kann von TTS-Modellen verschluckt werden.
  out = out.replace(/\bSprockhövel\b/g, "Sprockhövel");
  // Wortwahl: "private/privaten Krankenversicherung(sbeiträge)" -> "Krankenversicherung(sbeiträge)"
  out = out.replace(/\b(privaten|private|privater|privates|privat)\s+Krankenversicherung/gi, "Krankenversicherung");
  // Dezimalzahlen fuer TTS robuster machen: "2,5" -> "2 komma 5"
  out = out.replace(/(\d)\s*,\s*(\d)/g, "$1 komma $2");
  // Tausenderpunkte vermeiden, damit TTS keine "Punkt"-Pause spricht.
  out = out.replace(/\b(\d)\.(\d{3})\b/g, "$1$2");
  // Saubere Endungen: ein TTS-Segment ohne abschließendes Satzzeichen wird
  // intonatorisch offen gelassen. Punkt anhängen für satzweises Pipelining.
  const trimmed = out.trim();
  if (trimmed.length > 0 && !/[.!?;:,…”"')\]]$/.test(trimmed)) {
    out = `${trimmed}.`;
  }
  return out;
}
