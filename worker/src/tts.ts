import { fetch } from "undici";
import { log } from "./log.js";

export type TtsStreamHandle = {
  /** Resolves when streaming finished or aborted. */
  done: Promise<void>;
  /** Stop downloading and discard remaining audio (used for barge-in). */
  abort: () => void;
};

/**
 * Streams ElevenLabs TTS as μ-law 8000 Hz audio (Twilio-ready) and
 * invokes `onChunk` with raw μ-law buffers (typically ~160-640 bytes).
 */
export function streamElevenLabsToMulaw(
  text: string,
  onChunk: (mulaw: Buffer) => void,
): TtsStreamHandle {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const modelId = process.env.ELEVENLABS_MODEL || "eleven_turbo_v2_5";

  if (!apiKey || !voiceId) {
    log.error("tts.missing_config");
    return { done: Promise.resolve(), abort: () => undefined };
  }

  const controller = new AbortController();

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
    `?optimize_streaming_latency=1&output_format=ulaw_8000`;

  const stability = numEnv("ELEVENLABS_STABILITY", 0.65);
  const similarity = numEnv("ELEVENLABS_SIMILARITY", 0.85);
  const style = numEnv("ELEVENLABS_STYLE", 0.25);
  const speed = numEnv("ELEVENLABS_SPEED", 1.0);
  const speakerBoost = boolEnv("ELEVENLABS_SPEAKER_BOOST", true);

  const done = (async () => {
    try {
      const res = await fetch(url, {
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
        log.error("tts.http_error", { status: res.status, body: body.slice(0, 200) });
        return;
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
      if (!controller.signal.aborted) {
        log.error("tts.stream_failed", {
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
  };
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Ersetzt Eigennamen, die das TTS-Modell falsch ausspricht, durch
 * eine phonetisch passendere Schreibweise. Die LLM-Logik und das Log
 * bleiben unverändert – nur die hörbare Ausgabe wird korrigiert.
 */
function applyPronunciationFixes(text: string): string {
  let out = text;
  // "Duic" -> klingt im Deutschen wie "Duitsch"
  out = out.replace(/\bDuic\b/g, "Duitsch");
  // "Sprockhövel" wird gelegentlich verschluckt – Bindestrich hilft beim Tempo
  out = out.replace(/\bSprockhövel\b/g, "Sprock-Hövel");
  return out;
}
