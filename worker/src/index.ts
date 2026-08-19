import http from "node:http";
import { fetch } from "undici";
import { WebSocketServer } from "ws";
import { handleOpenAiRealtimeTelnyxStream } from "./openai-realtime-call.js";
import { log } from "./log.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

async function checkHealthDependencies(): Promise<{
  openai: boolean;
  telnyx: boolean;
  elevenlabs: boolean;
}> {
  const checks = {
    openai: false,
    telnyx: false,
    elevenlabs: false,
  };

  // Check OpenAI connectivity (simple models list call with short timeout)
  if (process.env.OPENAI_API_KEY?.trim()) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      checks.openai = res.ok;
    } catch {
      checks.openai = false;
    }
  }

  // Check Telnyx connectivity (simple credential validation)
  if (process.env.TELNYX_API_KEY?.trim()) {
    try {
      const res = await fetch("https://api.telnyx.com/v2/phone_numbers", {
        method: "GET",
        headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      checks.telnyx = res.ok || res.status === 401;  // 401 means auth OK, just no resources
    } catch {
      checks.telnyx = false;
    }
  }

  // Check ElevenLabs connectivity
  if (process.env.ELEVENLABS_API_KEY?.trim()) {
    try {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        method: "GET",
        headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(5000),
      });
      checks.elevenlabs = res.ok;
    } catch {
      checks.elevenlabs = false;
    }
  }

  return checks;
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    const deps = await checkHealthDependencies();
    const healthy = Object.values(deps).every(v => v || !process.env[`${Object.keys(deps).find(k => !v)?.toUpperCase()}_API_KEY`]);
    
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: healthy,
      service: "gloria-stream-worker",
      revision: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local",
      dependencies: deps,
      timestamp: new Date().toISOString(),
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
    handleOpenAiRealtimeTelnyxStream(ws, req).catch((error) => {
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
