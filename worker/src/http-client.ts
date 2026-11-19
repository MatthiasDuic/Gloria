import { Agent, fetch, setGlobalDispatcher } from "undici";
import { log } from "./log.js";

// undici closes idle sockets after 4 s by default. Gloria's turns are further apart than that,
// so every TTS or API request paid for a fresh TCP+TLS handshake (~100-300 ms).
const KEEP_ALIVE_TIMEOUT_MS = 60_000;

export function configureHttpClient(): void {
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: 10 * 60_000,
    connect: { timeout: 5_000 },
  }));
}

function warmOrigins(): string[] {
  const origins = ["https://api.elevenlabs.io", "https://api.openai.com"];
  const appBase = process.env.APP_BASE_URL?.trim();
  if (appBase) {
    try {
      origins.push(new URL(appBase).origin);
    } catch {
      /* invalid URL is reported elsewhere */
    }
  }
  return origins;
}

// Opens (and parks) TLS connections so the first real request of a call reuses them.
export function warmConnections(): void {
  if (process.env.NODE_TEST_CONTEXT) return;
  for (const origin of warmOrigins()) {
    fetch(origin, { method: "HEAD", signal: AbortSignal.timeout(4_000) })
      .then((response) => response.body?.cancel())
      .catch((error: unknown) => log.debug("http.warm_failed", { origin, error: String(error) }));
  }
}
