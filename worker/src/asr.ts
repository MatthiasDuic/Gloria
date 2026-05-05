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

  const model = process.env.DEEPGRAM_MODEL || "flux-general-multi";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";
  const isFlux = model.startsWith("flux");

  const params = new URLSearchParams({
    model,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    punctuate: "true",
  });

  if (isFlux) {
    // Flux uses /v2/listen with semantic turn detection — no silence-based
    // endpointing needed. language_hint biases flux-general-multi toward a
    // specific language without restricting detection.
    if (model === "flux-general-multi") {
      params.set("language_hint", language);
    }

    // Flux supports keyterm prompting (no boost scores — terms only).
    // Strip ":N" suffixes from DEEPGRAM_KEYWORDS if reused, or use DEEPGRAM_KEYTERMS.
    const defaultKeyterms = [
      "Barmer", "AOK", "TK", "DAK", "IKK", "Allianz", "Debeka", "AXA", "HUK",
      "Signal Iduna", "PKV", "GKV", "Beitragsrückerstattung", "Zusatzversicherung",
      "bAV", "Direktversicherung", "Pensionskasse", "Krankenversicherung",
      "Krankentagegeld", "Rentenversicherung", "Riester", "Rürup",
      "Betriebshaftpflicht", "Cyberversicherung", "Inhaltsversicherung",
      "Stromtarif", "Gastarif", "Kilowattstunde", "Gloria",
    ];
    const envKeyterms = (process.env.DEEPGRAM_KEYTERMS || process.env.DEEPGRAM_KEYWORDS)?.trim();
    const keyterms = envKeyterms
      ? envKeyterms.split(",").map((k) => k.trim().replace(/:[\d.]+$/, "")).filter(Boolean)
      : defaultKeyterms;
    for (const kt of keyterms) {
      params.append("keyterm", kt);
    }
  } else {
    // nova-3 / nova-2: silence-based endpointing + utterance end + keywords.
    const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "700";
    const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "1200";
    params.set("language", language);
    params.set("interim_results", "true");
    params.set("endpointing", endpointingMs);
    params.set("utterance_end_ms", utteranceEndMs);
    params.set("vad_events", "true");

    const defaultKeywords = [
      "Barmer:3", "AOK:3", "TK:3", "DAK:3", "IKK:3", "Allianz:3", "Debeka:3",
      "AXA:3", "HUK:3", "Signal Iduna:3", "PKV:3", "GKV:3",
      "Beitragsrückerstattung:1.5", "Zusatzversicherung:1.5", "bAV:2",
      "Direktversicherung:1.5", "Pensionskasse:1.5", "Krankenversicherung:1.5",
      "Krankentagegeld:1.5", "Rentenversicherung:1.5", "Riester:1.5", "Rürup:1.5",
      "Betriebshaftpflicht:1.5", "Cyberversicherung:1.5", "Inhaltsversicherung:1.5",
      "Stromtarif:1.5", "Gastarif:1.5", "Kilowattstunde:1.5", "Gloria:3",
    ];
    const envKeywords = process.env.DEEPGRAM_KEYWORDS?.trim();
    const keywords = envKeywords
      ? envKeywords.split(",").map((k) => k.trim()).filter(Boolean)
      : defaultKeywords;
    for (const kw of keywords) {
      params.append("keywords", kw);
    }

    if (language.toLowerCase().startsWith("en")) {
      params.set("smart_format", "true");
    }
  }

  const endpoint = isFlux ? "/v2/listen" : "/v1/listen";
  const ws = new WebSocket(`${DG_HOST}${endpoint}?${params.toString()}`, {
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
