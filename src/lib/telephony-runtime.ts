import { isElevenLabsConfigured, maybeWarmupElevenLabsVoice } from "./elevenlabs";
import { TOPICS } from "./types";
import type { ScriptConfig, Topic } from "./types";
import type { ContactRole } from "@/lib/call-state-token";

export type RoleState = "reception" | "transfer" | "decision_maker";

interface DashboardScriptsPayload {
  playbooks?: ScriptConfig[];
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

function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();
  const token = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (username && password) {
    headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  if (token) {
    headers["x-gloria-internal-token"] = token;
  }

  return headers;
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

  if (!isElevenLabsConfigured()) {
    runtimeState.elevenLabsWarm = true;
    return;
  }

  // Warmup must never block call setup path.
  void maybeWarmupElevenLabsVoice(true)
    .then(() => {
      runtimeState.elevenLabsWarm = true;
    })
    .catch(() => {
      runtimeState.elevenLabsWarm = false;
    });
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
    script.gatekeeperExample || "",
    script.decisionMakerTask || "",
    script.decisionMakerBehavior || "",
    script.decisionMakerExample || "",
    script.decisionMakerContext || "",
    script.appointmentGoal || "",
    script.problemBuildup || "",
    script.conceptTransition || "",
    script.appointmentConfirmation || "",
    script.availableAppointmentSlots || "",
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
// ElevenLabs TTS service through /api/twilio/audio.
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

  const scriptsUrl = new URL(`${baseUrl}/api/twilio/playbooks`);
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

  for (const script of payload.playbooks || []) {
    byTopic[script.topic] = script;
  }

  for (const topic of TOPICS) {
    if (!byTopic[topic] && runtimeState.scriptProfiles[topic]) {
      byTopic[topic] = runtimeState.scriptProfiles[topic] as ScriptConfig;
    }
  }

  scriptProfilesByUser[cacheKey] = byTopic;
  scriptsReadyByUser[cacheKey] = TOPICS.every((topic) => Boolean(byTopic[topic]));
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

export async function prepareCall(params: {
  topic: Topic;
  userId?: string;
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

export async function getTopicScriptProfile(
  topic: Topic,
  baseUrl?: string,
  request?: Request,
  userId?: string,
): Promise<ScriptConfig> {
  await ensureTelephonyRuntimeInitialized({ baseUrl, request });
  const cacheKey = getRuntimeCacheKey(userId);

  const scopedScripts = scriptProfilesByUser[cacheKey] || {};
  const profile = scopedScripts[topic];
  if (profile) {
    return profile;
  }

  const resolvedBaseUrl = resolveBaseUrl(baseUrl, request);
  await syncScripts(resolvedBaseUrl, userId);

  const afterSync = (scriptProfilesByUser[cacheKey] || {})[topic];
  if (!afterSync) {
    throw new Error(`Kein Skriptprofil für Thema ${topic} gefunden.`);
  }

  return afterSync;
}

export function resolveRoleState(params: {
  currentRole: ContactRole;
  inferredRole?: ContactRole;
  modelDetectedRole: "gatekeeper" | "decision-maker" | "unknown";
  heardText: string;
}): { contactRole: ContactRole; roleState: RoleState } {
  const lower = params.heardText.toLowerCase();

  if (
    params.currentRole === "decision-maker" ||
    params.inferredRole === "decision-maker" ||
    params.modelDetectedRole === "decision-maker"
  ) {
    return { contactRole: "decision-maker", roleState: "decision_maker" };
  }

  if (/\b(verbinde|einen\s+moment|ich\s+stell\s+durch|ich\s+verbinde)\b/.test(lower)) {
    return { contactRole: "gatekeeper", roleState: "transfer" };
  }

  return { contactRole: "gatekeeper", roleState: "reception" };
}

export function getTelephonyRuntimeSnapshot() {
  return {
    ...runtimeState,
  };
}

void ensureTelephonyRuntimeInitialized().catch(() => {
  // Best-effort preload on cold start. prepareCall retries with request/baseUrl context.
});
