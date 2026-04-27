import WebSocket from "ws";
import { log } from "./log.js";

export type AsrEvents = {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onUtteranceEnd?: () => void;
  onError?: (error: Error) => void;
};

export type AsrSession = {
  send: (mulawChunk: Buffer) => void;
  finish: () => Promise<void>;
};

const DG_HOST = "wss://api.deepgram.com";

export function openDeepgram(events: AsrEvents): AsrSession {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const model = process.env.DEEPGRAM_MODEL || "nova-2-phonecall";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";

  const params = new URLSearchParams({
    model,
    language,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    endpointing: "300",
    utterance_end_ms: "1200",
    vad_events: "true",
    punctuate: "true",
  });

  const ws = new WebSocket(`${DG_HOST}/v1/listen?${params.toString()}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  let opened = false;
  const queue: Buffer[] = [];

  ws.on("open", () => {
    opened = true;
    for (const chunk of queue) ws.send(chunk);
    queue.length = 0;
  });

  ws.on("message", (data: WebSocket.RawData) => {
    try {
      const text = typeof data === "string" ? data : data.toString();
      const msg = JSON.parse(text) as {
        type?: string;
        is_final?: boolean;
        speech_final?: boolean;
        channel?: { alternatives?: Array<{ transcript?: string }> };
      };

      if (msg.type === "UtteranceEnd") {
        events.onUtteranceEnd?.();
        return;
      }

      const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() || "";
      if (!transcript) return;

      if (msg.is_final) {
        events.onFinal(transcript);
      } else {
        events.onPartial?.(transcript);
      }
    } catch (error) {
      log.warn("asr.parse_failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });

  ws.on("error", (error) => {
    log.error("asr.error", { error: error.message });
    events.onError?.(error);
  });

  ws.on("close", (code, reason) => {
    log.info("asr.closed", { code, reason: reason.toString() });
  });

  return {
    send(mulawChunk) {
      if (!opened) {
        queue.push(mulawChunk);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(mulawChunk);
      }
    },
    async finish() {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          await new Promise((resolve) => setTimeout(resolve, 200));
          ws.close();
        }
      } catch {
        /* ignore */
      }
    },
  };
}
