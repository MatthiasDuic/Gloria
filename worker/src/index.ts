import http from "node:http";
import { WebSocketServer } from "ws";
import { handleTwilioStream } from "./twilio-stream.js";
import { log } from "./log.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "gloria-stream-worker" }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/twilio-stream")) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    handleTwilioStream(ws, req).catch((error) => {
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
