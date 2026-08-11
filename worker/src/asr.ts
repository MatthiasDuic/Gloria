import { fetch } from "undici";
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

export type AsrProvider = "deepgram" | "openai";

export function resolveAsrProvider(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  const explicit = env.ASR_PROVIDER?.trim().toLowerCase();
  if (explicit === "openai") return "openai";
  if (explicit === "deepgram") return "deepgram";
  if (env.DEEPGRAM_API_KEY?.trim()) return "deepgram";
  if (env.OPENAI_API_KEY?.trim()) return "openai";
  return "deepgram";
}

type ConnectVariant = {
  model: string;
  minimalParams: boolean;
  label: string;
};

export function openAsr(events: AsrEvents): AsrSession {
  const provider = resolveAsrProvider();
  if (provider === "openai") return openOpenAIAsr(events);
  return openDeepgram(events);
}

export function openDeepgram(events: AsrEvents): AsrSession {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY is not configured");
  }

  const configuredModel = process.env.DEEPGRAM_MODEL || "nova-3";
  const fallbackModel = process.env.DEEPGRAM_FALLBACK_MODEL || "nova-2-general";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";

  const connectPlan: ConnectVariant[] = [
    { model: configuredModel, minimalParams: false, label: "primary/header/full" },
    { model: configuredModel, minimalParams: true, label: "primary/header/minimal" },
  ];

  if (fallbackModel !== configuredModel) {
    connectPlan.push(
      { model: fallbackModel, minimalParams: false, label: "fallback/header/full" },
      { model: fallbackModel, minimalParams: true, label: "fallback/header/minimal" },
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
        const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "420";
        // utterance_end_ms removed — causes HTTP 400 with nova-3 + language=de.
        params.set("endpointing", endpointingMs);
      }
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
      headers: { Authorization: `Token ${apiKey}` },
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

    ws.on("unexpected-response", (_req, res) => {
      const status = res.statusCode ?? 0;
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8").slice(0, 500);
        log.warn("asr.handshake_rejected", { status, body, label: variant.label });
      });

      if (!opened) {
        const nextIndex = activeVariantIndex + 1;
        if (nextIndex < connectPlan.length) {
          const next = connectPlan[nextIndex];
          log.warn("asr.fallback_connect", {
            reason: `HTTP ${status}`,
            from: variant.label,
            to: next.label,
            fromModel: variant.model,
            toModel: next.model,
          });
          connectByIndex(nextIndex);
          return;
        }
      }

      const err = new Error(`Deepgram handshake failed: HTTP ${status}`);
      log.error("asr.session_error", { error: err.message });
      events.onError?.(err);
    });

    ws.on("error", (error) => {
      const message = error.message || "";
      const looksLikeHandshake = !opened && /40[01]/.test(message);

      if (looksLikeHandshake) {
        // unexpected-response handler will manage the fallback
        return;
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

function openOpenAIAsr(events: AsrEvents): AsrSession {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured for ASR fallback");
  }

  const bufferQueue: Buffer[] = [];
  let ready = false;
  let closed = false;

  const transcribeBuffer = async (audioChunk: Buffer) => {
    if (closed) return;
    if (!ready) {
      bufferQueue.push(Buffer.from(audioChunk));
      return;
    }

    const payload = new Uint8Array(audioChunk);
    const formData = new FormData();
    formData.append("file", new Blob([payload], { type: "audio/wav" }) as unknown as Blob, "audio.wav");
    formData.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe");
    formData.append("language", process.env.DEEPGRAM_LANGUAGE || "de");
    formData.append("response_format", "json");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData as never,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI transcription failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const json = await res.json() as { text?: string };
    const text = json.text?.trim() || "";
    if (text) {
      events.onPartial?.(text);
      events.onFinal(text);
    }
  };

  ready = true;
  queueMicrotask(() => {
    for (const chunk of bufferQueue) {
      void transcribeBuffer(chunk).catch((error) => {
        log.error("asr.openai_failed", { error: error instanceof Error ? error.message : String(error) });
        events.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }
    bufferQueue.length = 0;
  });

  return {
    send(audioChunk) {
      void transcribeBuffer(audioChunk).catch((error) => {
        log.error("asr.openai_failed", { error: error instanceof Error ? error.message : String(error) });
        events.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async finish() {
      closed = true;
      events.onUtteranceEnd?.();
    },
  };
}
