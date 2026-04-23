import { AI_CONFIG } from "./ai-config";
import { isElevenLabsConfigured } from "./elevenlabs";
import { isTwilioConfigured } from "./twilio";

export interface PreflightCheck {
  service: "openai" | "elevenlabs" | "twilio";
  ok: boolean;
  latencyMs: number;
  status?: number;
  reason?: string;
  skipped?: boolean;
}

export interface PreflightResult {
  ok: boolean;
  durationMs: number;
  checks: PreflightCheck[];
}

const DEFAULT_TIMEOUT_MS = 2500;

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response?: Response; error?: unknown; latencyMs: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    return { response, latencyMs: Date.now() - started };
  } catch (error) {
    return { error, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function checkOpenAI(timeoutMs: number): Promise<PreflightCheck> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      service: "openai",
      ok: false,
      latencyMs: 0,
      reason: "OPENAI_API_KEY fehlt.",
    };
  }

  const { response, error, latencyMs } = await timedFetch(
    "https://api.openai.com/v1/models",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
    timeoutMs,
  );

  if (error) {
    return {
      service: "openai",
      ok: false,
      latencyMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "";
    return {
      service: "openai",
      ok: false,
      status: response?.status,
      latencyMs,
      reason: `OpenAI /v1/models antwortete ${response?.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    };
  }

  return {
    service: "openai",
    ok: true,
    status: response.status,
    latencyMs,
  };
}

async function checkElevenLabs(timeoutMs: number): Promise<PreflightCheck> {
  if (!isElevenLabsConfigured()) {
    return {
      service: "elevenlabs",
      ok: false,
      latencyMs: 0,
      reason: "ELEVENLABS_API_KEY oder ELEVENLABS_VOICE_ID fehlt.",
    };
  }

  const apiKey = process.env.ELEVENLABS_API_KEY!.trim();
  const voiceId = process.env.ELEVENLABS_VOICE_ID!.trim();

  const { response, error, latencyMs } = await timedFetch(
    `https://api.elevenlabs.io/v1/voices/${voiceId}`,
    {
      method: "GET",
      headers: { "xi-api-key": apiKey },
    },
    timeoutMs,
  );

  if (error) {
    return {
      service: "elevenlabs",
      ok: false,
      latencyMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "";
    return {
      service: "elevenlabs",
      ok: false,
      status: response?.status,
      latencyMs,
      reason: `ElevenLabs /voices/{id} antwortete ${response?.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    };
  }

  return {
    service: "elevenlabs",
    ok: true,
    status: response.status,
    latencyMs,
  };
}

async function checkTwilio(timeoutMs: number): Promise<PreflightCheck> {
  if (!isTwilioConfigured()) {
    return {
      service: "twilio",
      ok: false,
      latencyMs: 0,
      reason: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN oder TWILIO_PHONE_NUMBER fehlt.",
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID!.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN!.trim();
  const authHeader = btoa(`${accountSid}:${authToken}`);

  const { response, error, latencyMs } = await timedFetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`,
    {
      method: "GET",
      headers: { Authorization: `Basic ${authHeader}` },
    },
    timeoutMs,
  );

  if (error) {
    return {
      service: "twilio",
      ok: false,
      latencyMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "";
    return {
      service: "twilio",
      ok: false,
      status: response?.status,
      latencyMs,
      reason: `Twilio Account-Lookup antwortete ${response?.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    };
  }

  // Konto-Status zusätzlich prüfen (muss "active" sein).
  try {
    const data = (await response.clone().json()) as { status?: string };
    if (data.status && data.status !== "active") {
      return {
        service: "twilio",
        ok: false,
        status: response.status,
        latencyMs,
        reason: `Twilio-Konto-Status = ${data.status}.`,
      };
    }
  } catch {
    // JSON-Parsing-Fehler sind kein Abbruchgrund, der 200er reicht.
  }

  return {
    service: "twilio",
    ok: true,
    status: response.status,
    latencyMs,
  };
}

export async function runPreflight(options?: {
  timeoutMs?: number;
  services?: ReadonlyArray<PreflightCheck["service"]>;
}): Promise<PreflightResult> {
  const timeoutMs = Math.max(500, Math.min(8000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const wanted = options?.services ?? (["openai", "elevenlabs", "twilio"] as const);
  const started = Date.now();

  const tasks: Array<Promise<PreflightCheck>> = [];
  if (wanted.includes("openai")) tasks.push(checkOpenAI(timeoutMs));
  if (wanted.includes("elevenlabs")) tasks.push(checkElevenLabs(timeoutMs));
  if (wanted.includes("twilio")) tasks.push(checkTwilio(timeoutMs));

  const checks = await Promise.all(tasks);
  return {
    ok: checks.every((check) => check.ok || check.skipped),
    durationMs: Date.now() - started,
    checks,
  };
}

export function describePreflightFailure(result: PreflightResult): string {
  const failed = result.checks.filter((check) => !check.ok && !check.skipped);
  if (failed.length === 0) return "";
  return failed
    .map((check) => `${check.service}: ${check.reason ?? "Fehler unbekannt"}`)
    .join(" | ");
}

// Minimal eingebundene Re-Exports erleichtern den Import in API-Routen.
export { AI_CONFIG };
