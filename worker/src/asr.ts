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

type ConnectVariant = {
  model: string;
  authInQuery: boolean;
  minimalParams: boolean;
  label: string;
};

export function openDeepgram(events: AsrEvents): AsrSession {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const configuredModel = process.env.DEEPGRAM_MODEL || "flux-general-multi";
  const fallbackModel = process.env.DEEPGRAM_FALLBACK_MODEL || "nova-3";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";

  const connectPlan: ConnectVariant[] = [
    { model: configuredModel, authInQuery: false, minimalParams: false, label: "primary/header/full" },
    { model: configuredModel, authInQuery: true, minimalParams: false, label: "primary/query/full" },
    { model: configuredModel, authInQuery: true, minimalParams: true, label: "primary/query/minimal" },
  ];

  if (fallbackModel !== configuredModel) {
    connectPlan.push(
      { model: fallbackModel, authInQuery: false, minimalParams: false, label: "fallback/header/full" },
      { model: fallbackModel, authInQuery: true, minimalParams: false, label: "fallback/query/full" },
      { model: fallbackModel, authInQuery: true, minimalParams: true, label: "fallback/query/minimal" },
    );
  }

  const buildUrl = (variant: ConnectVariant): { url: string; flux: boolean } => {
    const flux = variant.model.startsWith("flux");
    const params = new URLSearchParams({
      model: variant.model,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      punctuate: "true",
      language,
    });

    if (flux) {
      params.delete("language");
      if (variant.model === "flux-general-multi") {
        params.set("language_hint", language);
      }
    } else {
      params.set("interim_results", "true");
      if (!variant.minimalParams) {
        const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "450";
        const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "700";
        params.set("endpointing", endpointingMs);
        params.set("utterance_end_ms", utteranceEndMs);
      }
    }

    if (variant.authInQuery) {
      params.set("token", apiKey);
    }

    const endpoint = flux ? "/v2/listen" : "/v1/listen";
    return { url: `${DG_HOST}${endpoint}?${params.toString()}`, flux };
  };

  let ws: WebSocket;
  let opened = false;
  let activeVariantIndex = 0;
  let activeModel = connectPlan[0]?.model || configuredModel;
  let isFlux = activeModel.startsWith("flux");
  let fluxLastTranscript = "";
  let novaLastPartial = "";
  const queue: Buffer[] = [];

  const connectByIndex = (index: number): void => {
    const variant = connectPlan[index];
    const endpoint = buildUrl(variant);
    activeVariantIndex = index;
    activeModel = variant.model;
    isFlux = endpoint.flux;
    opened = false;

    log.info("asr.connecting", {
      model: variant.model,
      label: variant.label,
      url: endpoint.url,
    });

    ws = new WebSocket(endpoint.url, {
      ...(variant.authInQuery ? {} : { headers: { Authorization: `Token ${apiKey}` } }),
    });

    ws.on("open", () => {
      opened = true;
      for (const chunk of queue) ws.send(chunk);
      queue.length = 0;
      log.info("asr.connected", { model: activeModel, label: variant.label });
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
          return;
        }

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
      } catch (error) {
        log.warn("asr.parse_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    });

    ws.on("error", (error) => {
      const message = error.message || "";
      const looksLikeHandshake400 = !opened && /400/.test(message);

      if (looksLikeHandshake400) {
        const nextIndex = activeVariantIndex + 1;
        if (nextIndex < connectPlan.length) {
          const next = connectPlan[nextIndex];
          log.warn("asr.fallback_connect", {
            reason: message,
            from: variant.label,
            to: next.label,
            fromModel: variant.model,
            toModel: next.model,
          });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          connectByIndex(nextIndex);
          return;
        }
      }

      log.error("asr.error", { error: error.message, model: activeModel, label: variant.label });
      events.onError?.(error);
    });

    ws.on("close", (code, reason) => {
      log.info("asr.closed", { code, reason: reason.toString(), model: activeModel, label: variant.label });
    });
  };

  connectByIndex(0);

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
