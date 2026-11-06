import { TOPICS } from "./types";
import type { ScriptConfig, Topic } from "./types";
import { buildInternalHeaders } from "@/lib/internal-auth";

interface DashboardScriptsPayload {
  topicPolicies?: ScriptConfig[];
}

interface TelephonyRuntimeState {
  initializedAt?: string;
  openAiReady: boolean;
  elevenLabsWarm: boolean;
  audioPipelineReady: boolean;
  roleMachineReady: boolean;
  scriptsReady: boolean;
  scriptProfiles: Partial<Record<Topic, ScriptConfig>>;
  lastScriptSyncAt?: string;
  lastOpenAiHeartbeatAt?: string;
  lastInitError?: string;
}

const runtimeState: TelephonyRuntimeState = {
  openAiReady: false,
  elevenLabsWarm: false,
  audioPipelineReady: false,
  roleMachineReady: false,
  scriptsReady: false,
  scriptProfiles: {},
  lastInitError: undefined,
};

const scriptProfilesByUser: Record<string, Partial<Record<Topic, ScriptConfig>>> = {};
const scriptsReadyByUser: Record<string, boolean> = {};

let runtimeInitPromise: Promise<void> | null = null;
let heartbeatInFlight = false;

function getRuntimeCacheKey(userId?: string): string {
  return userId || "global";
}


function resolveBaseUrl(baseUrl?: string, request?: Request): string {
  if (baseUrl) {
    return baseUrl.replace(/\/$/, "");
  }

  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (!request) {
    throw new Error("APP_BASE_URL fehlt für Telephony Runtime Initialisierung.");
  }

  const url = new URL(request.url);
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    url.host;
  const proto =
    request.headers.get("x-forwarded-proto") ||
    url.protocol.replace(":", "");

  return `${proto}://${host}`.replace(/\/$/, "");
}

function initOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();

  if (!apiKey) {
    runtimeState.openAiReady = false;
    return;
  }

  runtimeState.openAiReady = true;
}

async function initAudioPipeline() {
  // Minimal, static converter primitives used by edge handlers.
  void new TextEncoder();
  void new TextDecoder();
  runtimeState.audioPipelineReady = true;

  runtimeState.elevenLabsWarm = Boolean(
    process.env.ELEVENLABS_API_KEY?.trim() && process.env.ELEVENLABS_VOICE_ID?.trim(),
  );
}

function initRoleMachine() {
  runtimeState.roleMachineReady = true;
}

function buildTopicProfileKey(script: ScriptConfig): string {
  const base = [
    script.topic,
    script.opener,
    script.discovery,
    script.objectionHandling,
    script.close,
    script.aiKeyInfo || "",
    script.consentPrompt || "",
    script.receptionTopicReason || "",
    script.gatekeeperTask || "",
    script.gatekeeperBehavior || "",
    script.decisionMakerTask || "",
    script.decisionMakerBehavior || "",
    script.decisionMakerContext || "",
    script.appointmentGoal || "",
    script.problemBuildup || "",
    script.conceptTransition || "",
    script.appointmentConfirmation || "",
    script.availableAppointmentSlots || "",
    script.preparationQuestions || "",
    script.pkvHealthIntro || "",
    script.pkvHealthQuestions || "",
  ].join("|");

  let hash = 2166136261;
  for (let i = 0; i < base.length; i += 1) {
    hash ^= base.charCodeAt(i);
    hash +=
      (hash << 1) +
      (hash << 4) +
      (hash << 7) +
      (hash << 8) +
      (hash << 24);
  }

  return `p-${(hash >>> 0).toString(36)}`;
}

// Stub kept for compatibility with older call sites. Gloria never uses the
// OpenAI Realtime audio API — the voice output is always produced by the
// ElevenLabs is the only Gloria voice provider; OpenAI supplies text only.
async function ensureOpenAiRealtimeSessions(
  _baseUrl: string,
  _topics: readonly Topic[] = TOPICS,
  _userId?: string,
) {
  return;
}

async function syncScripts(baseUrl: string, userId?: string) {
  const cacheKey = getRuntimeCacheKey(userId);
  const internalHeaders = buildInternalHeaders();

  const scriptsUrl = new URL(`${baseUrl}/api/telnyx/topic-policies`);
  if (userId) {
    scriptsUrl.searchParams.set("userId", userId);
  }

  // Prefer dedicated telephony playbooks endpoint to avoid admin-auth middleware paths.
  let response = await fetch(scriptsUrl.toString(), {
    method: "GET",
    headers: internalHeaders,
    cache: "no-store",
  });

  if (!response.ok) {
    // Backward-compatible fallback for older deployments.
    response = await fetch(`${baseUrl}/api/reports`, {
      method: "GET",
      headers: internalHeaders,
      cache: "no-store",
    });
  }

  if (!response.ok) {
    throw new Error(`Script-Sync fehlgeschlagen (${response.status}).`);
  }

  const payload = (await response.json()) as DashboardScriptsPayload;
  const byTopic: Partial<Record<Topic, ScriptConfig>> = {};

  for (const script of payload.topicPolicies || []) {
    byTopic[script.topic] = script;
  }

  for (const [topic, profile] of Object.entries(runtimeState.scriptProfiles)) {
    if (!userId && !byTopic[topic] && profile) byTopic[topic] = profile;
  }

  scriptProfilesByUser[cacheKey] = byTopic;
  scriptsReadyByUser[cacheKey] = Object.keys(byTopic).length > 0;
  runtimeState.scriptProfiles = byTopic;
  runtimeState.scriptsReady = scriptsReadyByUser[cacheKey];
  runtimeState.lastScriptSyncAt = new Date().toISOString();
}

export async function ensureTelephonyRuntimeInitialized(params?: {
  baseUrl?: string;
  request?: Request;
  force?: boolean;
}): Promise<void> {
  if (runtimeInitPromise && !params?.force) {
    try {
      await runtimeInitPromise;
      return;
    } catch {
      // Recover from a failed preload attempt and retry with current context.
      runtimeInitPromise = null;
    }
  }

  runtimeInitPromise = (async () => {
    const baseUrl = resolveBaseUrl(params?.baseUrl, params?.request);

    initOpenAiClient();
    initRoleMachine();
    await initAudioPipeline();
    await syncScripts(baseUrl);
    runtimeState.initializedAt = new Date().toISOString();
    runtimeState.lastInitError = undefined;
  })();

  try {
    await runtimeInitPromise;
  } catch (error) {
    runtimeState.lastInitError =
      error instanceof Error ? error.message : "Telephony Runtime Initialisierung fehlgeschlagen.";
    runtimeInitPromise = null;
    throw new Error("Telephony Runtime konnte nicht initialisiert werden.");
  }
}

export async function heartbeatOpenAi() {
  if (heartbeatInFlight || !runtimeState.openAiReady) {
    return;
  }

  const last = runtimeState.lastOpenAiHeartbeatAt
    ? Date.parse(runtimeState.lastOpenAiHeartbeatAt)
    : 0;

  if (Date.now() - last < 120_000) {
    return;
  }

  heartbeatInFlight = true;

  try {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);

    try {
      await fetch("https://api.openai.com/v1/models", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        cache: "no-store",
        signal: controller.signal,
      });
      runtimeState.lastOpenAiHeartbeatAt = new Date().toISOString();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Heartbeat is best-effort.
  } finally {
    heartbeatInFlight = false;
  }
}

function getWorkerPreflightUrl(pathname: string): string | undefined {
  const healthUrl = process.env.WORKER_HEALTHCHECK_URL?.trim();
  const explicitStreamUrl = process.env.TELNYX_MEDIA_STREAM_URL?.trim();
  const raw = healthUrl
    || (explicitStreamUrl && !/gloria-stream-worker\.onrender\.com/i.test(explicitStreamUrl) ? explicitStreamUrl : undefined)
    || process.env.MEDIA_STREAM_WSS_URL?.trim()
    || "wss://gloria-tebr.onrender.com/telnyx-stream";
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

async function preflightWorkerAndCalendar(baseUrl: string, userId: string | undefined, topic: Topic, preloadId?: string): Promise<void> {
  const headers = buildInternalHeaders();
  const preloadUrl = getWorkerPreflightUrl(preloadId ? "/prepare-call" : "/health");
  if (preloadUrl) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const requestHeaders = new Headers(headers);
      const init: RequestInit = { method: "GET", headers: requestHeaders, cache: "no-store", signal: controller.signal };
      if (preloadId && userId) {
        requestHeaders.set("content-type", "application/json");
        init.method = "POST";
        init.body = JSON.stringify({ preloadId, userId, topic });
      }
      const response = await fetch(preloadUrl, init);
      const payload = preloadId ? await response.json().catch(() => null) as { ok?: boolean } | null : null;
      if (!response.ok || (preloadId && payload?.ok !== true)) {
        throw new Error(`worker_prepare_failed_${response.status}`);
      }
      console.info("[preflight] worker.prepared", { ms: Date.now() - start, assignmentLoaded: Boolean(payload?.ok) });
    } catch (error) {
      console.warn("[preflight] worker.prepare_failed", {
        ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  // Calendar warmup stays best-effort so it does not delay the outbound call.
  if (userId) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    void fetch(`${baseUrl}/api/calendar/busy?userId=${encodeURIComponent(userId)}`, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal,
    }).then(() => {
      console.info("[preflight] calendar.warm", { ms: Date.now() - start });
    }).catch((error: unknown) => {
      console.warn("[preflight] calendar.failed", {
        ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => clearTimeout(timeout));
  }
}

export async function prepareCall(params: {
  topic: Topic;
  userId?: string;
  preloadId?: string;
  baseUrl?: string;
  request?: Request;
}): Promise<{
  ready: boolean;
  topicProfileLoaded: boolean;
  preparedAt: string;
  topicProfileKey?: string;
}> {
  const baseUrl = resolveBaseUrl(params.baseUrl, params.request);
  const cacheKey = getRuntimeCacheKey(params.userId);

  await ensureTelephonyRuntimeInitialized({ baseUrl, request: params.request });

  const scopedScripts = scriptProfilesByUser[cacheKey] || {};
  if (!scopedScripts[params.topic]) {
    await syncScripts(baseUrl, params.userId);
  }

  void heartbeatOpenAi();

  await preflightWorkerAndCalendar(baseUrl, params.userId, params.topic, params.preloadId);

  const activeScripts = scriptProfilesByUser[cacheKey] || {};
  const topicProfileLoaded = Boolean(activeScripts[params.topic]);
  const topicScript = activeScripts[params.topic];

  runtimeState.scriptProfiles = activeScripts;
  runtimeState.scriptsReady = scriptsReadyByUser[cacheKey] || false;

  return {
    ready:
      runtimeState.openAiReady &&
      runtimeState.audioPipelineReady &&
      runtimeState.roleMachineReady &&
      topicProfileLoaded,
    topicProfileLoaded,
    preparedAt: new Date().toISOString(),
    topicProfileKey: topicScript ? buildTopicProfileKey(topicScript) : undefined,
  };
}

export function getTelephonyRuntimeSnapshot() {
  return {
    ...runtimeState,
  };
}

void ensureTelephonyRuntimeInitialized().catch(() => {
  // Best-effort preload on cold start. prepareCall retries with request/baseUrl context.
});
