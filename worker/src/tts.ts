import { fetch } from "undici";
import { log } from "./log.js";

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
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return;
  void fetch(`https://api.elevenlabs.io/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "GET",
    headers: { "xi-api-key": apiKey },
  })
    .then((res) => {
      void res.text().catch(() => undefined);
      log.info("tts.prewarm_ok", { status: res.status });
    })
    .catch(() => {
      /* ignore – best effort */
    });
}

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
    return { done: Promise.resolve(), abort: () => undefined, aborted: false };
  }

  const controller = new AbortController();

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
    `?optimize_streaming_latency=3&output_format=ulaw_8000`;

  const stability = numEnv("ELEVENLABS_STABILITY", 0.7);
  const similarity = numEnv("ELEVENLABS_SIMILARITY", 0.85);
  const style = numEnv("ELEVENLABS_STYLE", 0.2);
  // 0.88 = ca. 12% langsamer als Standard, klingt deutlich ruhiger und gibt dem
  // Angerufenen mehr Zeit zum Mitdenken.
  const speed = numEnv("ELEVENLABS_SPEED", 0.88);
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
    get aborted() {
      return controller.signal.aborted;
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
  // "Duic" -> klingt im Deutschen wie "Du-itsch" (Bindestrich erzwingt
  // bei ElevenLabs eine deutliche Trennung der Silben, sonst wird das
  // "i" verschluckt und es klingt wie "Duc").
  out = out.replace(/\bDuic\b/g, "Du-itsch");
  // "Sprockhövel" wird gelegentlich verschluckt – Bindestrich hilft beim Tempo
  out = out.replace(/\bSprockhövel\b/g, "Sprock-Hövel");
  // Wortwahl: "private/privaten Krankenversicherung(sbeiträge)" -> "Krankenversicherung(sbeiträge)"
  // Das Wort "privat" soll in der Audio-Ausgabe nie zur Krankenversicherung
  // dazugesagt werden – auch nicht als Themen-Anker.
  out = out.replace(/\b(privaten|private|privater|privates|privat)\s+Krankenversicherung/gi, "Krankenversicherung");
  return out;
}
