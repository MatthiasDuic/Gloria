import { AI_CONFIG } from "./ai-config";
import { isDeepgramConfigured } from "./deepgram-tts";
import { diagnosePostgresConnection, isDatabaseUrlConfigured } from "./report-db";
import { getTelnyxApiBaseUrl, isTelnyxConfigured } from "./telnyx";

export interface PreflightCheck {
  service: "openai" | "deepgram" | "telnyx" | "postgres";
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

async function checkDeepgram(timeoutMs: number): Promise<PreflightCheck> {
  if (!isDeepgramConfigured()) {
    return {
      service: "deepgram",
      ok: false,
      latencyMs: 0,
      reason: "DEEPGRAM_API_KEY fehlt.",
    };
  }

  const apiKey = process.env.DEEPGRAM_API_KEY!.trim();
  const model = process.env.DEEPGRAM_VOICE_MODEL?.trim() || "aura-helios-en";

  const url = new URL("https://api.deepgram.com/v1/speak");
  url.searchParams.set("model", model);
  url.searchParams.set("encoding", "mulaw");
  url.searchParams.set("sample_rate", "8000");

  const { response, error, latencyMs } = await timedFetch(
    url.toString(),
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: "Hi." }),
    },
    timeoutMs,
  );

  if (error) {
    return {
      service: "deepgram",
      ok: false,
      latencyMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "";
    return {
      service: "deepgram",
      ok: false,
      status: response?.status,
      latencyMs,
      reason: `Deepgram TTS antwortete ${response?.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    };
  }

  try {
    await response.body?.cancel();
  } catch {
    // egal
  }

  return {
    service: "deepgram",
    ok: true,
    status: response.status,
    latencyMs,
  };
}

async function checkTelnyx(timeoutMs: number): Promise<PreflightCheck> {
  if (!isTelnyxConfigured()) {
    return {
      service: "telnyx",
      ok: false,
      latencyMs: 0,
      reason: "TELNYX_API_KEY, TELNYX_CONNECTION_ID oder TELNYX_PHONE_NUMBER fehlt.",
    };
  }

  const apiKey = process.env.TELNYX_API_KEY!.trim();
  const apiBaseUrl = getTelnyxApiBaseUrl();

  const { response, error, latencyMs } = await timedFetch(
    `${apiBaseUrl}/phone_numbers?page[size]=1`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    timeoutMs,
  );

  if (error) {
    return {
      service: "telnyx",
      ok: false,
      latencyMs,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!response || !response.ok) {
    const detail = response ? await response.text().catch(() => "") : "";
    return {
      service: "telnyx",
      ok: false,
      status: response?.status,
      latencyMs,
      reason: `Telnyx Phone-Number-Lookup antwortete ${response?.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
    };
  }

  return {
    service: "telnyx",
    ok: true,
    status: response.status,
    latencyMs,
  };
}

async function checkPostgres(): Promise<PreflightCheck> {
  if (!isDatabaseUrlConfigured()) {
    return {
      service: "postgres",
      ok: false,
      latencyMs: 0,
      reason: "DATABASE_URL fehlt.",
    };
  }

  const started = Date.now();
  const diagnosis = await diagnosePostgresConnection();
  const latencyMs = Date.now() - started;
  const ok = diagnosis.startsWith("Postgres reachable");

  return {
    service: "postgres",
    ok,
    latencyMs,
    reason: ok ? undefined : diagnosis,
  };
}

export async function runPreflight(options?: {
  timeoutMs?: number;
  services?: ReadonlyArray<PreflightCheck["service"]>;
}): Promise<PreflightResult> {
  const timeoutMs = Math.max(500, Math.min(8000, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const wanted = options?.services ?? (["openai", "deepgram", "telnyx", "postgres"] as const);
  const started = Date.now();

  const tasks: Array<Promise<PreflightCheck>> = [];
  if (wanted.includes("openai")) tasks.push(checkOpenAI(timeoutMs));
  if (wanted.includes("deepgram")) tasks.push(checkDeepgram(timeoutMs));
  if (wanted.includes("telnyx")) tasks.push(checkTelnyx(timeoutMs));
  if (wanted.includes("postgres")) tasks.push(checkPostgres());

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
