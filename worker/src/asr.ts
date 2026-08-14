import WebSocket from "ws";
import { log } from "./log.js";

export type AsrEvents = {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onUtteranceEnd?: () => void;
  onError?: (error: Error) => void;
};

export type AsrSession = {
  send: (audioChunk: Buffer) => void;
  finish: () => Promise<void>;
};

export type AsrProvider = "openai";

export function resolveAsrProvider(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  if (!env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is not configured for OpenAI Realtime ASR");
  }
  return "openai";
}

export function openAsr(events: AsrEvents): AsrSession {
  return openOpenAIAsr(events);
}

function openOpenAIAsr(events: AsrEvents): AsrSession {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured for OpenAI Realtime ASR");
  }

  const model = process.env.OPENAI_REALTIME_ASR_MODEL?.trim() || "gpt-4o-realtime-preview";
  const language = process.env.OPENAI_TRANSCRIBE_LANGUAGE?.trim() || "de";
  const silenceDurationMs = Math.max(
    250,
    Number.parseInt(process.env.OPENAI_ASR_SILENCE_MS || "520", 10),
  );

  let ws: WebSocket | undefined;
  let opened = false;
  let closed = false;
  let speechActive = false;
  let lastPartial = "";
  const queue: Buffer[] = [];

  const sendEvent = (event: Record<string, unknown>): boolean => {
    if (closed || !ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(event));
    return true;
  };

  ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    opened = true;
    sendEvent({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm16",
        input_audio_transcription: { model: "gpt-4o-mini-transcribe", language },
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: silenceDurationMs,
          prefix_padding_ms: 300,
        },
      },
    });
    for (const chunk of queue) {
      sendEvent({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
    }
    queue.length = 0;
    log.info("asr.connected", { provider: "openai", model, language });
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const message = JSON.parse(typeof data === "string" ? data : data.toString()) as {
        type?: string;
        delta?: string;
        transcript?: string;
        error?: { message?: string };
      };

      if (message.type === "error") {
        const error = new Error(message.error?.message || "OpenAI Realtime ASR error");
        log.error("asr.session_error", { provider: "openai", error: error.message });
        events.onError?.(error);
        return;
      }

      if (message.type === "input_audio_buffer.speech_started") {
        speechActive = true;
        lastPartial = "";
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.delta") {
        const partial = message.delta?.trim() || "";
        if (partial) {
          lastPartial = `${lastPartial} ${partial}`.replace(/\s+/g, " ").trim();
          events.onPartial?.(lastPartial);
        }
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        const finalText = (message.transcript || lastPartial).trim();
        if (finalText) events.onFinal(finalText);
        lastPartial = "";
        speechActive = false;
        events.onUtteranceEnd?.();
        return;
      }

      if (message.type === "input_audio_buffer.speech_stopped") {
        speechActive = false;
      }
    } catch (error) {
      log.warn("asr.parse_failed", {
        provider: "openai",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  ws.on("unexpected-response", (_request, response) => {
    const error = new Error(`OpenAI Realtime ASR handshake failed: HTTP ${response.statusCode ?? 0}`);
    log.error("asr.session_error", { provider: "openai", error: error.message });
    events.onError?.(error);
  });

  ws.on("error", (error) => {
    if (closed) return;
    log.error("asr.error", { provider: "openai", error: error.message });
    events.onError?.(error);
  });

  ws.on("close", (code, reason) => {
    opened = false;
    log.info("asr.closed", { provider: "openai", code, reason: reason.toString() });
  });

  return {
    send(audioChunk) {
      if (closed) return;
      if (!opened) {
        queue.push(Buffer.from(audioChunk));
        return;
      }
      sendEvent({ type: "input_audio_buffer.append", audio: audioChunk.toString("base64") });
    },
    async finish() {
      if (closed) return;
      if (ws?.readyState === WebSocket.OPEN) {
        if (speechActive || lastPartial) {
          sendEvent({ type: "input_audio_buffer.commit" });
        }
        ws.close(1000, "call_finished");
      }
      closed = true;
      queue.length = 0;
    },
  };
}
