import { fetch } from "undici";
import WebSocket from "ws";
import type { VoiceProfile } from "./topic-policy.js";

export type ElevenLabsOutputFormat = "alaw_8000" | "ulaw_8000";

const DEFAULT_VOICE_ID = "Ywa4Py8gVz5ugeNVy6iC";
const DEFAULT_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_FALLBACK_MODEL_ID = "eleven_multilingual_v2";

type DialogueStreamOptions = {
  outputFormat: ElevenLabsOutputFormat;
  signal: AbortSignal;
  onChunk: (chunk: Buffer) => void;
  voiceProfile?: Pick<VoiceProfile, "stability" | "similarity" | "style" | "speed" | "speakerBoost">;
  socketFactory?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
};

export type DialogueStreamResult = {
  audioBytes: number;
  model: string;
  usedFallback: boolean;
  error?: string;
};

type DialogueServerMessage = {
  audio?: string;
  error?: string | { message?: string };
  is_final?: boolean;
};

export function getElevenLabsModel(): string {
  return process.env.ELEVENLABS_MODEL?.trim() || DEFAULT_MODEL_ID;
}

export function isElevenLabsDialogueModel(modelId = getElevenLabsModel()): boolean {
  return modelId.startsWith("eleven_v4");
}

function getApiKey(): string {
  return process.env.ELEVENLABS_API_KEY?.trim() || "";
}

function getVoiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
}

export function isElevenLabsConfigured(): boolean {
  return Boolean(getApiKey() && getVoiceId());
}

export function shouldRetryElevenLabsStream(error: unknown, streamedAudioBytes: number, retryCount: number): boolean {
  if (streamedAudioBytes > 0 || retryCount > 0) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|stalled after/i.test(message)) return false;
  return /\b429\b|\b5\d\d\b|fetch failed|econnreset|econnrefused|eai_again|etimedout|socket hang up|network/i.test(message);
}

export async function streamElevenLabsAudio(
  text: string,
  outputFormat: ElevenLabsOutputFormat,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void,
  voiceProfile?: Pick<VoiceProfile, "stability" | "similarity" | "style" | "speed" | "speakerBoost">,
  modelId = getElevenLabsModel(),
): Promise<void> {
  const apiKey = getApiKey();
  const voiceId = getVoiceId();
  if (!apiKey || !voiceId) throw new Error("ELEVENLABS_API_KEY oder ELEVENLABS_VOICE_ID fehlt");

  const streamingLatency = Number.parseInt(process.env.ELEVENLABS_STREAMING_LATENCY?.trim() || "2", 10);
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${outputFormat}&optimize_streaming_latency=${streamingLatency}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/basic",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
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
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    },
  );
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`ElevenLabs TTS antwortete ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}`);
  }
  if (!response.body) throw new Error("ElevenLabs TTS lieferte keinen Audiostream");

  // Dynamic timeout: allow longer initial latency (connection setup) but stricter on subsequent chunks
  const INITIAL_STALL_TIMEOUT_MS = 6_000;   // reduced from 10s — fail faster on real outages
  const CHUNK_STALL_TIMEOUT_MS = 4_000;
  const MAX_STREAM_TIME_MS = 30_000;        // 30s max total stream time
  
  const streamStartTime = Date.now();
  
  const readWithTimeout = (isFirstChunk: boolean): Promise<{ done: boolean; value?: Uint8Array }> =>
    new Promise((resolve, reject) => {
      const timeoutMs = isFirstChunk ? INITIAL_STALL_TIMEOUT_MS : CHUNK_STALL_TIMEOUT_MS;
      const remainingTime = Math.max(100, MAX_STREAM_TIME_MS - (Date.now() - streamStartTime));
      const effectiveTimeout = Math.min(timeoutMs, remainingTime);
      
      const id = setTimeout(
        () => reject(new Error(`ElevenLabs stream stalled after ${effectiveTimeout / 1000}s`)),
        effectiveTimeout,
      );
      reader.read().then(
        (v) => { clearTimeout(id); resolve(v); },
        (e) => { clearTimeout(id); reject(e as Error); },
      );
    });

  const reader = response.body.getReader();
  try {
    let chunkCount = 0;
    while (true) {
      const result = await readWithTimeout(chunkCount === 0);
      chunkCount += 1;
      if (result.done) return;
      if (result.value?.length) onChunk(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
}

export class ElevenLabsDialogueStream {
  private readonly apiKey = getApiKey();
  private readonly voiceId = getVoiceId();
  private readonly modelId = getElevenLabsModel();
  private readonly textParts: string[] = [];
  private socket: WebSocket | null = null;
  private opened: Promise<void> | null = null;
  private resolveOpened: (() => void) | null = null;
  private resolveFinal: (() => void) | null = null;
  private readonly finalReceived = new Promise<void>((resolve) => { this.resolveFinal = resolve; });
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private audioBytes = 0;
  private failure: Error | null = null;
  private finalSeen = false;
  private finished = false;
  private cancelled = false;

  constructor(private readonly options: DialogueStreamOptions) {
    options.signal.addEventListener("abort", this.onAbort, { once: true });
  }

  async append(text: string): Promise<void> {
    const segment = text.trim();
    if (!segment || this.cancelled || this.options.signal.aborted) return;
    if (this.finished) throw new Error("ElevenLabs-Dialogstream ist bereits beendet");
    this.textParts.push(segment);
    this.connect();
    await this.opened;
    if (this.failure || this.options.signal.aborted || !this.socket) return;

    this.send({
      inputs: [{ text: segment, voice_id: this.voiceId, new_turn: false }],
    });
    this.send({ flush: true });
  }

  async finish(): Promise<DialogueStreamResult> {
    if (this.finished) return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false };
    this.finished = true;
    this.clearTimers();
    try {
      if (this.cancelled || this.options.signal.aborted) {
        return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false };
      }

      if (!this.socket || !this.opened) return await this.runFallback();
      await this.opened;
      if (!this.failure && !this.options.signal.aborted) {
        this.send({ close_socket: true });
        if (!this.failure) {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            this.finalReceived,
            new Promise<void>((resolve) => {
              timeout = setTimeout(() => {
                this.recordFailure(new Error("ElevenLabs-Dialogstream wurde nicht final abgeschlossen"));
                resolve();
              }, 12_000);
            }),
          ]);
          if (timeout) clearTimeout(timeout);
        }
      }

      if (this.cancelled || this.options.signal.aborted) {
        return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false };
      }
      if (this.failure && this.audioBytes > 0) {
        return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false, error: this.failure.message };
      }
      if (this.audioBytes === 0) return await this.runFallback(this.failure?.message);
      return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false };
    } finally {
      this.cleanup();
    }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cleanup();
    this.resolveOpened?.();
    this.resolveFinal?.();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1000, "cancelled");
  }

  private readonly onAbort = () => this.cancel();

  private connect(): void {
    if (this.opened) return;
    const socketFactory = this.options.socketFactory
      ?? ((url, options) => new WebSocket(url, options));
    const query = new URLSearchParams({
      model_id: this.modelId,
      output_format: this.options.outputFormat,
      language_code: "de",
    });
    const socket = socketFactory(
      `wss://api.elevenlabs.io/v1/text-to-dialogue/stream-input?${query.toString()}`,
      { headers: { "xi-api-key": this.apiKey } },
    );
    this.socket = socket;
    this.opened = new Promise<void>((resolve) => { this.resolveOpened = resolve; });
    this.connectTimeout = setTimeout(() => {
      this.recordFailure(new Error("Verbindung zum ElevenLabs-Dialogstream hat das Zeitlimit überschritten"));
    }, 6_000);
    socket.once("open", () => {
      this.clearConnectTimeout();
      if (this.cancelled || this.options.signal.aborted) {
        this.resolveOpened?.();
        return;
      }
      this.send({
        voices: [this.voiceId],
        voice_settings: {
          stability: Number.parseFloat(process.env.ELEVENLABS_STABILITY?.trim() || String(this.options.voiceProfile?.stability ?? 0.38)),
          similarity_boost: Number.parseFloat(process.env.ELEVENLABS_SIMILARITY?.trim() || String(this.options.voiceProfile?.similarity ?? 0.84)),
        },
      });
      this.resolveOpened?.();
      this.keepAliveTimer = setInterval(() => {
        if (!this.finished && !this.failure) this.send({ keep_alive: true });
      }, 15_000);
    });
    socket.on("message", (raw) => this.handleMessage(raw.toString()));
    socket.once("error", (error) => {
      this.clearConnectTimeout();
      this.recordFailure(error);
      this.resolveOpened?.();
    });
    socket.once("close", (code, reason) => {
      this.clearTimers();
      if (!this.cancelled && !this.options.signal.aborted && !this.failure && !this.finalSeen) {
        this.recordFailure(new Error(`ElevenLabs-Dialogstream geschlossen (${code}): ${reason.toString()}`));
      }
      this.resolveOpened?.();
      this.resolveFinal?.();
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.recordFailure(new Error("ElevenLabs-Dialogstream ist nicht verbunden"));
      return;
    }
    this.socket.send(JSON.stringify(message), (error) => {
      if (error) this.recordFailure(error);
    });
  }

  private handleMessage(raw: string): void {
    let message: DialogueServerMessage;
    try {
      message = JSON.parse(raw) as DialogueServerMessage;
    } catch (error) {
      this.recordFailure(new Error(`ElevenLabs-Dialogstream lieferte eine ungültige Nachricht: ${String(error)}`));
      return;
    }

    if (message.error) {
      const error = typeof message.error === "string" ? message.error : message.error.message || "unbekannter Fehler";
      this.recordFailure(new Error(`ElevenLabs-Dialogstream: ${error}`));
    }
    if (message.audio) {
      const chunk = Buffer.from(message.audio, "base64");
      if (chunk.length) {
        this.audioBytes += chunk.length;
        this.options.onChunk(chunk);
      }
    }
    if (message.is_final) {
      this.finalSeen = true;
      this.resolveFinal?.();
    }
  }

  private recordFailure(error: Error): void {
    this.failure ??= error;
    this.clearTimers();
    this.resolveOpened?.();
    this.resolveFinal?.();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) this.socket.close(1011, "generation_failed");
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) clearTimeout(this.connectTimeout);
    this.connectTimeout = null;
  }

  private clearTimers(): void {
    this.clearConnectTimeout();
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private cleanup(): void {
    this.clearTimers();
    this.options.signal.removeEventListener("abort", this.onAbort);
  }

  private async runFallback(error?: string): Promise<DialogueStreamResult> {
    if (!this.textParts.length || this.options.signal.aborted) {
      return { audioBytes: this.audioBytes, model: this.modelId, usedFallback: false, ...(error ? { error } : {}) };
    }
    const fallbackModel = process.env.ELEVENLABS_FALLBACK_MODEL?.trim() || DEFAULT_FALLBACK_MODEL_ID;
    const safeFallbackModel = isElevenLabsDialogueModel(fallbackModel) ? DEFAULT_FALLBACK_MODEL_ID : fallbackModel;
    await streamElevenLabsAudio(
      this.textParts.join(" "),
      this.options.outputFormat,
      this.options.signal,
      (chunk) => {
        this.audioBytes += chunk.length;
        this.options.onChunk(chunk);
      },
      this.options.voiceProfile,
      safeFallbackModel,
    );
    return {
      audioBytes: this.audioBytes,
      model: safeFallbackModel,
      usedFallback: true,
      ...(error ? { error } : {}),
    };
  }
}
