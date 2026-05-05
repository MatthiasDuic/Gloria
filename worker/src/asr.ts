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

  const model = process.env.DEEPGRAM_MODEL || "nova-3";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";
  const isFlux = model.startsWith("flux");

  const params = new URLSearchParams({
    model,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
    language,
  });

  if (isFlux) {
    // Flux uses /v2/listen with semantic turn detection.
    // language_hint biases flux-general-multi without restricting detection.
    params.delete("language");
    if (model === "flux-general-multi") {
      params.set("language_hint", language);
    }
  } else {
    // nova-2 / nova-3: silence-based endpointing + utterance end.
    const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "700";
    const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "1200";
    params.set("interim_results", "true");
    params.set("endpointing", endpointingMs);
    params.set("utterance_end_ms", utteranceEndMs);
  }

  const endpoint = isFlux ? "/v2/listen" : "/v1/listen";
  const url = `${DG_HOST}${endpoint}?${params.toString()}`;
  log.info("asr.connecting", { model, url });
  const ws = new WebSocket(url, {
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

      if (isFlux) {
        // Flux v2 message format: top-level "event" field, top-level "transcript".
        const msg = JSON.parse(text) as {
          event?: string;
          transcript?: string;
        };
        const transcript = msg.transcript?.trim() || "";
        switch (msg.event) {
          case "EndOfTurn":
            // Semantic turn end — fire onFinal with the complete turn transcript.
            if (transcript) events.onFinal(transcript);
            events.onUtteranceEnd?.();
            break;
          case "Update":
          case "StartOfTurn":
            // Interim updates — used for barge-in detection.
            if (transcript) events.onPartial?.(transcript);
            break;
          // EagerEndOfTurn / TurnResumed / Connected / etc. — ignore for now.
        }
      } else {
        // nova-3 / v1 message format: nested channel.alternatives[0].transcript.
        const msg = JSON.parse(text) as {
          type?: string;
          is_final?: boolean;
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
