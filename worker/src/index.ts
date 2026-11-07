import http from "node:http";
import { WebSocketServer } from "ws";
import { dependenciesAreReady, getDependencyHealth } from "./health.js";
import { getElevenLabsModel } from "./elevenlabs-tts.js";
import { handleOpenAiRealtimeTelnyxStream } from "./openai-realtime-call.js";
import { log } from "./log.js";
import { flushPendingReports } from "./finalize.js";
import { checkReportStorage } from "./report-outbox.js";
import { preloadTopicPolicy } from "./topic-policy-prompt.js";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", "http://localhost");
  if (requestUrl.pathname === "/prepare-call") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }
    const token = process.env.APP_INTERNAL_TOKEN?.trim();
    const providedToken = req.headers["x-gloria-internal-token"];
    if (!token || typeof providedToken !== "string" || providedToken !== token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let bodyText = "";
    for await (const chunk of req) {
      bodyText += chunk.toString();
      if (bodyText.length > 4096) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }
    }
    let body: { preloadId?: unknown; userId?: unknown; topic?: unknown };
    try {
      body = JSON.parse(bodyText) as typeof body;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
      return;
    }
    if (typeof body.preloadId !== "string" || !/^[0-9a-f-]{36}$/i.test(body.preloadId)
      || typeof body.userId !== "string" || body.userId.length > 200
      || typeof body.topic !== "string" || !body.topic.trim() || body.topic.length > 120) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }
    const ready = await preloadTopicPolicy(body.preloadId, body.userId, body.topic);
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: ready }));
    return;
  }
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      service: "gloria-stream-worker",
      revision: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local",
      ttsModel: getElevenLabsModel(),
      timestamp: new Date().toISOString(),
    }));
    return;
  }
  if (req.url === "/readyz") {
    const [health, reportStorageReady] = await Promise.all([getDependencyHealth(90_000), checkReportStorage()]);
    const ready = dependenciesAreReady(health.dependencies) && reportStorageReady;
    res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: ready,
      service: "gloria-stream-worker",
      revision: process.env.RENDER_GIT_COMMIT?.slice(0, 7) || "local",
      dependencies: health.dependencies,
      reportStorageReady,
      issues: [...health.issues, ...(!reportStorageReady ? ["Berichtsspeicher nicht verfügbar"] : [])],
      blocking: !ready,
      checkedAt: new Date(health.checkedAt).toISOString(),
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
  flushPendingReports().catch((error) => log.error("outbox.flush_failed", { error: String(error) }));
});

const outboxTimer = setInterval(() => {
  flushPendingReports().catch((error) => log.error("outbox.flush_failed", { error: String(error) }));
}, 120_000);
outboxTimer.unref();

// Keeps provider status (credits, keys) fresh so the app's pre-call check gets an instant, current answer.
const refreshHealth = () => {
  getDependencyHealth(0).then((health) => {
    if (health.issues.length) log.warn("health.issues", { issues: health.issues, blocking: health.blocking });
  }).catch((error) => log.error("health.refresh_failed", { error: String(error) }));
};
setTimeout(refreshHealth, 5_000).unref();
setInterval(refreshHealth, 60_000).unref();

function shutdown(signal: string) {
  log.info("server.shutdown", { signal });
  server.close(() => {
    flushPendingReports()
      .catch((error) => log.error("outbox.flush_failed", { error: String(error) }))
      .finally(() => process.exit(0));
  });
  setTimeout(() => {
    wss.clients.forEach((client) => client.close(1001, "shutdown"));
    setTimeout(() => process.exit(0), 25_000).unref();
  }, 270_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
