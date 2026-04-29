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

  const model = process.env.DEEPGRAM_MODEL || "nova-2-general";
  const language = process.env.DEEPGRAM_LANGUAGE || "de";

  // Endpointing-Pause, nach der Deepgram als "Satzende" interpretiert.
  // 1400/2400 ms ist der Kompromiss zwischen "Anrufer ausreden lassen" und
  // "noch nicht zäh wirken". Werte überschreibbar via env, falls Live-Daten
  // einen anderen Sweet Spot zeigen.
  const endpointingMs = process.env.DEEPGRAM_ENDPOINTING_MS?.trim() || "1400";
  const utteranceEndMs = process.env.DEEPGRAM_UTTERANCE_END_MS?.trim() || "2400";

  const params = new URLSearchParams({
    model,
    language,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: endpointingMs,
    utterance_end_ms: utteranceEndMs,
    vad_events: "true",
    punctuate: "true",
  });

  // Keyword-Boost: Versicherungs-Vokabular, das Deepgram sonst gerne falsch
  // transkribiert (Marken, Tarif-Begriffe). Pro Eintrag optional ":boost"-Suffix
  // (Standard 1.5). Liste überschreibbar via env DEEPGRAM_KEYWORDS (komma-getrennt).
  const defaultKeywords = [
    "Barmer:2",
    "AOK:2",
    "TK:2",
    "DAK:2",
    "IKK:2",
    "Allianz:2",
    "Debeka:2",
    "AXA:2",
    "HUK:2",
    "Signal Iduna:2",
    "PKV:2",
    "GKV:2",
    "Beitragsrückerstattung:1.5",
    "Zusatzversicherung:1.5",
    "bAV:2",
    "Direktversicherung:1.5",
    "Pensionskasse:1.5",
    "Krankenversicherung:1.5",
    "Krankentagegeld:1.5",
    "Rentenversicherung:1.5",
    "Riester:1.5",
    "Rürup:1.5",
    "Betriebshaftpflicht:1.5",
    "Cyberversicherung:1.5",
    "Inhaltsversicherung:1.5",
    "Stromtarif:1.5",
    "Gastarif:1.5",
    "Kilowattstunde:1.5",
    "Gloria:2",
    "Duic:2",
    "Sprockhövel:2",
  ];
  const envKeywords = process.env.DEEPGRAM_KEYWORDS?.trim();
  const keywords = envKeywords
    ? envKeywords.split(",").map((k) => k.trim()).filter(Boolean)
    : defaultKeywords;
  for (const kw of keywords) {
    params.append("keywords", kw);
  }

  // smart_format is English-only on Deepgram; enable only for en* languages.
  if (language.toLowerCase().startsWith("en")) {
    params.set("smart_format", "true");
  }

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
