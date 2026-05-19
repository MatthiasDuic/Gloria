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

const DG_HOST = "wss://api.deepgram.com";

export function openDeepgram(events: AsrEvents): AsrSession {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const configuredModel = process.env.DEEPGRAM_MODEL || "nova-3";
  const fallbackModel = process.env.DEEPGRAM_FALLBACK_MODEL || "nova-2";
  let model = configuredModel;
  const language = process.env.DEEPGRAM_LANGUAGE || "de";
  let isFlux = model.startsWith("flux");

  const buildUrl = (targetModel: string) => {
    const flux = targetModel.startsWith("flux");
    const params = new URLSearchParams({
      model: targetModel,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      punctuate: "true",
      language,
    });

    if (flux) {
      params.delete("language");
      if (targetModel === "flux-general-multi") {
        params.set("language_hint", language);
      }
    } else {
      const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "450";
      const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "700";
      params.set("interim_results", "true");
      params.set("endpointing", endpointingMs);
      params.set("utterance_end_ms", utteranceEndMs);
    }

    const endpoint = flux ? "/v2/listen" : "/v1/listen";
    return { url: `${DG_HOST}${endpoint}?${params.toString()}`, flux };
  };

  let ws: WebSocket;

  let opened = false;
  let retriedWithFallback = false;
  let fluxLastTranscript = "";
  let novaLastPartial = "";
  const queue: Buffer[] = [];

  const connect = (targetModel: string) => {
    const endpoint = buildUrl(targetModel);
    model = targetModel;
    isFlux = endpoint.flux;
    log.info("asr.connecting", { model: targetModel, url: endpoint.url });
    ws = new WebSocket(endpoint.url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    ws.on("open", () => {
      opened = true;
      for (const chunk of queue) ws.send(chunk);
      queue.length = 0;
      log.info("asr.connected", { model });
    });

    ws.on("message", (data: WebSocket.RawData) => {
      try {
        const text = typeof data === "string" ? data : data.toString();

        if (isFlux) {
          const msg = JSON.parse(text) as {
            event?: string;
            transcript?: string;
          };
          const transcript = msg.transcript?.trim() || "";
          if (transcript) {
            fluxLastTranscript = transcript;
          }
          switch (msg.event) {
            case "EndOfTurn":
              if (transcript || fluxLastTranscript) {
                events.onFinal(transcript || fluxLastTranscript);
                fluxLastTranscript = "";
              }
              events.onUtteranceEnd?.();
              break;
            case "Update":
            case "StartOfTurn":
              if (transcript) events.onPartial?.(transcript);
              break;
          }
        } else {
          const msg = JSON.parse(text) as {
            type?: string;
            is_final?: boolean;
            channel?: { alternatives?: Array<{ transcript?: string }> };
          };

          if (msg.type === "UtteranceEnd") {
            if (novaLastPartial) {
              events.onFinal(novaLastPartial);
              novaLastPartial = "";
            }
            events.onUtteranceEnd?.();
            return;
          }

          const transcript = msg.channel?.alternatives?.[0]?.transcript?.trim() || "";
          if (!transcript) return;

          if (msg.is_final) {
            events.onFinal(transcript);
            novaLastPartial = "";
          } else {
            novaLastPartial = transcript;
            events.onPartial?.(transcript);
          }
        }
      } catch (error) {
        log.warn("asr.parse_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    });

    ws.on("error", (error) => {
      const message = error.message || "";
      const looksLikeHandshake400 = !opened && /400/.test(message);
      if (
        looksLikeHandshake400 &&
        !retriedWithFallback &&
        model !== fallbackModel
      ) {
        retriedWithFallback = true;
        log.warn("asr.fallback_model", { from: model, to: fallbackModel, reason: message });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        connect(fallbackModel);
        return;
      }

      log.error("asr.error", { error: error.message, model });
      events.onError?.(error);
    });

    ws.on("close", (code, reason) => {
      log.info("asr.closed", { code, reason: reason.toString(), model });
    });
  };
  connect(configuredModel);

  return {
    send(audioChunk) {
      if (!opened) {
        queue.push(audioChunk);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(audioChunk);
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
