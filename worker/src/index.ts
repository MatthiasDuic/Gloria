import http from "node:http";
import { WebSocketServer } from "ws";
import { handleTelnyxStream } from "./telnyx-stream.js";
import { handleOpenAiRealtimeTelnyxStream } from "./openai-realtime-call.js";
import { log } from "./log.js";

// IMPORTANT: The following env vars MUST be set in Render dashboard:
// - APP_INTERNAL_TOKEN
// - STREAM_SHARED_SECRET
// - OPENAI_REALTIME_ASR_MODEL (optional, defaults to gpt-4o-realtime-preview)
// - OPENAI_TRANSCRIBE_LANGUAGE (optional, defaults to de)
// - ELEVENLABS_API_KEY
// - ELEVENLABS_VOICE_ID
// Otherwise, worker will not authenticate with Vercel APIs

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "gloria-stream-worker",
      revision: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local",
    }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/telnyx-stream")) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const useAudioRealtime = !/^(?:0|false|no|off)$/i.test(process.env.OPENAI_AUDIO_REALTIME || "true");
    const handler = useAudioRealtime ? handleOpenAiRealtimeTelnyxStream : handleTelnyxStream;
    handler(ws, req).catch((error) => {
      log.error("ws.handler_failed", { error: error instanceof Error ? error.message : String(error) });
      try {
        ws.close(1011, "internal_error");
      } catch {
        /* ignore */
      }
    });
  });
});

server.listen(PORT, () => {
  log.info("server.listening", { port: PORT });
});

function shutdown(signal: string) {
  log.info("server.shutdown", { signal });
  wss.clients.forEach((client) => {
    try {
      client.close(1001, "shutdown");
    } catch {
      /* ignore */
    }
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
