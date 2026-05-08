/**
 * sipgate integration helpers.
 *
 * Replaces Twilio/SignalWire for German phone numbers.
 * Uses:
 *  - sipgate REST API v2  (outbound calls via sessions/calls)
 *  - sipgate.io webhooks  (inbound voice flow: voice→record→respond loop)
 *
 * Required env vars:
 *  SIPGATE_TOKEN_ID   – e.g. token-CDU7RO
 *  SIPGATE_TOKEN      – Personal Access Token UUID
 *  SIPGATE_DEVICE_ID  – device to place outbound calls from, e.g. e0
 *  SIPGATE_CALLER_ID  – E.164 number shown to callee, e.g. +4921187973993032
 */

import type { TwilioCallRequest } from "./twilio";
import { prepareCall } from "./telephony-runtime";
import { getAppBaseUrl } from "./twilio";
import { log } from "./log";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export function isSipgateConfigured(): boolean {
  return Boolean(
    process.env.SIPGATE_TOKEN_ID?.trim() &&
      process.env.SIPGATE_TOKEN?.trim() &&
      process.env.SIPGATE_DEVICE_ID?.trim() &&
      process.env.SIPGATE_CALLER_ID?.trim(),
  );
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Fehlende Env-Variable für sipgate: ${name}`);
  return value;
}

export function getSipgateAuthHeader(): string {
  const id = readEnv("SIPGATE_TOKEN_ID");
  const token = readEnv("SIPGATE_TOKEN");
  return "Basic " + Buffer.from(`${id}:${token}`).toString("base64");
}

export function getSipgateCallerId(): string {
  return readEnv("SIPGATE_CALLER_ID");
}

export function getSipgateDeviceId(): string {
  return readEnv("SIPGATE_DEVICE_ID");
}

export function getSipgateCallerIds(): string[] {
  const primary = process.env.SIPGATE_CALLER_ID?.trim();
  const extra = (process.env.SIPGATE_CALLER_IDS || "")
    .split(/[;,\n]/)
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set([primary, ...extra].filter((v): v is string => Boolean(v)))];
}

// ---------------------------------------------------------------------------
// sipgate XML builder (sipgate.io NGCP/XML dialect)
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function withResponse(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${inner}\n</Response>`;
}

/** Play a static TTS greeting, then record the caller's reply. */
export function buildSipgateRecordXml(params: {
  playUrl?: string;
  sayText?: string;
  actionUrl: string;
  maxLength?: number;
  timeout?: number;
}): string {
  const playBlock = params.playUrl
    ? `  <Play>${escapeXml(params.playUrl)}</Play>\n`
    : "";
  const sayBlock = params.sayText
    ? `  <Say language="de-DE">${escapeXml(params.sayText)}</Say>\n`
    : "";

  const maxLength = params.maxLength ?? 30;
  const timeout = params.timeout ?? 5;

  return withResponse(
    `${playBlock}${sayBlock}` +
      `  <Record action="${escapeXml(params.actionUrl)}" method="POST" maxLength="${maxLength}" timeout="${timeout}" trimSilence="true" transcribe="false" />\n` +
      `  <Redirect method="POST">${escapeXml(params.actionUrl)}?noSpeech=1</Redirect>`,
  );
}

/** Play a URL, then hang up. Used for final goodbye. */
export function buildSipgatePlayHangupXml(params: {
  playUrl?: string;
  sayText?: string;
}): string {
  const playBlock = params.playUrl
    ? `  <Play>${escapeXml(params.playUrl)}</Play>\n`
    : "";
  const sayBlock = params.sayText
    ? `  <Say language="de-DE">${escapeXml(params.sayText)}</Say>\n`
    : "";

  return withResponse(`${playBlock}${sayBlock}  <Hangup />`);
}

/** Just hang up, optionally say something first. */
export function buildSipgateHangupXml(sayText?: string): string {
  const sayBlock = sayText
    ? `  <Say language="de-DE">${escapeXml(sayText)}</Say>\n`
    : "";
  return withResponse(`${sayBlock}  <Hangup />`);
}

// ---------------------------------------------------------------------------
// sipgate REST API – outbound call
// ---------------------------------------------------------------------------

const SIPGATE_API = "https://api.sipgate.com/v2";
const MAX_PREPARE_CALL_TIMEOUT_MS = 12_000;
const PREPARE_CALL_TIMEOUT_MS = Math.min(
  MAX_PREPARE_CALL_TIMEOUT_MS,
  Math.max(3_000, Number.parseInt(process.env.PREPARE_CALL_TIMEOUT_MS || "6000", 10)),
);
const PREPARE_CALL_RETRY_MS = Math.max(
  150,
  Number.parseInt(process.env.PREPARE_CALL_RETRY_MS || "350", 10),
);

function buildVoiceUrl(baseUrl: string, payload: TwilioCallRequest, prepared: boolean, preparation: { preparedAt?: string; topicProfileKey?: string } | null): string {
  const url = new URL(`${baseUrl}/api/sipgate/voice`);
  if (payload.leadId) url.searchParams.set("leadId", payload.leadId);
  if (payload.userId) url.searchParams.set("userId", payload.userId);
  if (payload.phoneNumberId) url.searchParams.set("phoneNumberId", payload.phoneNumberId);
  if (payload.ownerRealName) url.searchParams.set("ownerRealName", payload.ownerRealName);
  if (payload.ownerCompanyName) url.searchParams.set("ownerCompanyName", payload.ownerCompanyName);
  if (payload.ownerGesellschaft) url.searchParams.set("ownerGesellschaft", payload.ownerGesellschaft);
  if (payload.voiceId) url.searchParams.set("voiceId", payload.voiceId);
  url.searchParams.set("company", payload.company);
  if (payload.contactName) url.searchParams.set("contactName", payload.contactName);
  url.searchParams.set("topic", payload.topic);
  if (prepared) url.searchParams.set("prepared", "1");
  if (preparation?.preparedAt) url.searchParams.set("preparedAt", preparation.preparedAt);
  if (preparation?.topicProfileKey) url.searchParams.set("rtProfileKey", preparation.topicProfileKey);
  if (payload.previousSummary) url.searchParams.set("previousSummary", payload.previousSummary);
  if (payload.isCallback) url.searchParams.set("isCallback", "1");
  return url.toString();
}

function buildStatusUrl(baseUrl: string, payload: TwilioCallRequest): string {
  const url = new URL(`${baseUrl}/api/sipgate/status`);
  if (payload.leadId) url.searchParams.set("leadId", payload.leadId);
  if (payload.userId) url.searchParams.set("userId", payload.userId);
  if (payload.phoneNumberId) url.searchParams.set("phoneNumberId", payload.phoneNumberId);
  url.searchParams.set("company", payload.company);
  if (payload.contactName) url.searchParams.set("contactName", payload.contactName);
  url.searchParams.set("topic", payload.topic);
  if (payload.isTestCall) url.searchParams.set("testCall", "1");
  return url.toString();
}

export async function createSipgateCall(payload: TwilioCallRequest, request?: Request) {
  const deviceId = getSipgateDeviceId();
  const callerId = (() => {
    const allowed = getSipgateCallerIds();
    const from = payload.from?.trim() || process.env.SIPGATE_CALLER_ID?.trim() || "";
    if (from && !allowed.includes(from)) {
      throw new Error("Ausgangsnummer ist nicht freigegeben.");
    }
    return from || allowed[0];
  })();

  if (!callerId) throw new Error("Keine SIPGATE_CALLER_ID konfiguriert.");

  const baseUrl = getAppBaseUrl(request);

  // Prepare runtime (preloads TTS/LLM)
  const prepareDeadline = Date.now() + PREPARE_CALL_TIMEOUT_MS;
  let preparation: Awaited<ReturnType<typeof prepareCall>> | null = null;
  let lastPrepareError: unknown;

  while (Date.now() < prepareDeadline) {
    try {
      preparation = await prepareCall({ topic: payload.topic, userId: payload.userId, baseUrl, request });
      if (preparation.ready && preparation.topicProfileLoaded) break;
    } catch (err) {
      lastPrepareError = err;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PREPARE_CALL_RETRY_MS));
  }

  if (!preparation?.topicProfileLoaded) {
    const reason = lastPrepareError instanceof Error ? lastPrepareError.message : "Initialisierung nicht fertig.";
    throw new Error(`RUNTIME_NOT_READY: ${reason}`);
  }

  const preparedForStream = Boolean(preparation.ready && preparation.topicProfileLoaded);
  const voiceUrl = buildVoiceUrl(baseUrl, payload, preparedForStream, preparation);
  const statusUrl = buildStatusUrl(baseUrl, payload);

  const body = {
    deviceId,
    caller: deviceId,
    callee: payload.to,
    callerId,
    // sipgate will POST to voiceUrl when call is answered
    ...(process.env.SIPGATE_SUPPORTS_ANNOUNCE === "true" ? {} : {}),
  };

  const authHeader = getSipgateAuthHeader();
  const apiResp = await fetch(`${SIPGATE_API}/sessions/calls`, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await apiResp.text();
  if (!apiResp.ok) {
    log.error("sipgate.create_call_failed", { status: apiResp.status, body: text });
    throw new Error(`sipgate call failed: ${apiResp.status} ${text}`);
  }

  let data: { sessionId?: string } = {};
  try {
    data = JSON.parse(text);
  } catch {
    // ignore parse error
  }

  log.info("sipgate.call_created", {
    sessionId: data.sessionId,
    to: payload.to,
    from: callerId,
    voiceUrl,
    statusUrl,
  });

  // Persist state so sipgate.io webhook knows what context to use
  // We store voiceUrl as the incoming webhook (sipgate.io incomingUrl is account-wide,
  // so we use the callSid/sessionId as context token in the URL)
  return { sid: data.sessionId || "", voiceUrl, statusUrl };
}
