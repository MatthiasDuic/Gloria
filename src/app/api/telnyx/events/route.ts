import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { completeOutboundCall, markOutboundCallActive, releaseCampaignCallLock } from "@/lib/report-db";
import { processOutboundCallQueue } from "@/lib/outbound-call-queue";
import { getTelnyxPublicKey, telnyxCommandId, verifyTelnyxWebhook } from "@/lib/telnyx-webhook-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelnyxEventPayload = {
  call_control_id?: string;
  call_leg_id?: string;
  call_session_id?: string;
  direction?: unknown;
  client_state?: string;
  stream_url?: string;
  recording_id?: string;
  recording_url?: string;
};

type TelnyxEvent = {
  event_type?: string;
  payload?: TelnyxEventPayload;
};

function getApiBaseUrl(): string {
  const explicit = process.env.TELNYX_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  return "https://api.telnyx.com/v2";
}

function readApiKey(): string {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("TELNYX_API_KEY fehlt.");
  }
  return apiKey;
}

function getTelnyxMediaStreamUrl(): string {
  const normalize = (raw?: string): string | undefined => {
    const value = raw?.trim();
    if (!value) return undefined;
    const rewritten = value.replace("/twilio-stream", "/telnyx-stream");
    try {
      const url = new URL(rewritten);
      if (url.protocol === "https:") url.protocol = "wss:";
      if (url.protocol === "http:") url.protocol = "ws:";
      if (!url.pathname || url.pathname === "/") {
        url.pathname = "/telnyx-stream";
      } else if (url.pathname === "/twilio-stream") {
        url.pathname = "/telnyx-stream";
      }
      return url.toString();
    } catch {
      return rewritten;
    }
  };

  const derivedFromHealthcheck = (() => {
    const health = process.env.WORKER_HEALTHCHECK_URL?.trim();
    if (!health) return undefined;
    try {
      const url = new URL(health);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/telnyx-stream";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return undefined;
    }
  })();

  const explicit = normalize(process.env.TELNYX_MEDIA_STREAM_URL);
  const legacyHostPattern = /gloria-stream-worker\.onrender\.com/i;
  if (explicit && !legacyHostPattern.test(explicit)) {
    return explicit;
  }

  const fallback =
    derivedFromHealthcheck ||
    normalize(process.env.TWILIO_MEDIA_STREAM_URL) ||
    normalize(process.env.MEDIA_STREAM_WSS_URL) ||
    "wss://gloria-tebr.onrender.com/telnyx-stream";

  return fallback;
}

async function sendTelnyxCommand(
  callControlId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `${getApiBaseUrl()}/calls/${encodeURIComponent(callControlId)}/actions/${action}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readApiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ ...body, command_id: telnyxCommandId(callControlId, action) }),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Telnyx command ${action} failed: ${response.status} ${details}`);
  }
}

function parseEvent(body: unknown): TelnyxEvent {
  if (!body || typeof body !== "object") {
    return {};
  }

  const root = body as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const payload = (data.payload && typeof data.payload === "object"
    ? data.payload
    : {}) as TelnyxEventPayload;

  return {
    event_type: typeof data.event_type === "string" ? data.event_type : undefined,
    payload,
  };
}

type DecodedClientState = {
  queueId?: string;
  company?: string;
  contactName?: string;
  topic?: string;
  leadId?: string;
  userId?: string;
  callSource?: "crm" | "manual";
  isTestCall?: boolean;
  calledPhone?: string;
};

function decodeClientState(raw?: string): DecodedClientState {
  if (!raw) return {};
  const tryDecode = (encoding: "base64" | "base64url"): DecodedClientState | null => {
    try {
      const json = Buffer.from(raw, encoding).toString("utf8");
      return JSON.parse(json) as DecodedClientState;
    } catch {
      return null;
    }
  };
  return tryDecode("base64") || tryDecode("base64url") || {};
}

export async function POST(request: Request): Promise<NextResponse> {
  const publicKey = await getTelnyxPublicKey().catch(() => undefined);
  if (!publicKey) return NextResponse.json({ error: "Webhook verification is unavailable" }, { status: 503 });
  const rawBody = await request.text();
  if (!verifyTelnyxWebhook(rawBody, request.headers, publicKey)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return new NextResponse("", { status: 200 });
  }

  const event = parseEvent(parsedBody);
  const eventType = event.event_type || "unknown";
  const callControlId = event.payload?.call_control_id;
  const clientState = decodeClientState(event.payload?.client_state);

  if (!callControlId) {
    log.warn("telnyx.events.missing_call_control_id", { eventType });
    return new NextResponse("", { status: 200 });
  }

  try {
    if (eventType === "call.initiated") {
      if (clientState.queueId) {
        await markOutboundCallActive(clientState.queueId, callControlId);
      }
      const direction = typeof event.payload?.direction === "string" ? event.payload.direction.toLowerCase() : undefined;
      const isOutbound = direction === "outgoing"
        || (direction !== "incoming" && Boolean(clientState.userId || clientState.queueId));
      if (!isOutbound) {
        if (direction !== "incoming") log.warn("telnyx.events.unknown_call_direction", { callControlId, direction });
        await sendTelnyxCommand(callControlId, "answer", {
          ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
        });
      }
    } else if (eventType === "call.answered") {
      const streamBidirectionalCodec = (process.env.TELNYX_STREAM_BIDIRECTIONAL_CODEC || "PCMA").trim();
      await sendTelnyxCommand(callControlId, "streaming_start", {
        stream_url: getTelnyxMediaStreamUrl(),
        stream_track: "both_tracks",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: streamBidirectionalCodec,
        ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
      });
      log.info("telnyx.events.streaming_start", {
        callControlId,
        bidirectionalMode: "rtp",
        bidirectionalCodec: streamBidirectionalCodec,
      });
    } else if (eventType === "call.streaming.failed") {
      await sendTelnyxCommand(callControlId, "hangup", {});
      log.warn("telnyx.events.streaming_failed", {
        callControlId,
        callLegId: event.payload?.call_leg_id,
        callSessionId: event.payload?.call_session_id,
      });
    } else if (eventType === "call.hangup") {
      await completeOutboundCall(callControlId, clientState.queueId);
      await releaseCampaignCallLock(callControlId);
      await processOutboundCallQueue().catch((error) => {
        log.error("outbound_call_queue.pump_after_hangup_failed", {
          callControlId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      log.info("telnyx.events.hangup", {
        callControlId,
        callLegId: event.payload?.call_leg_id,
        callSessionId: event.payload?.call_session_id,
      });
    }
  } catch (error) {
    log.error("telnyx.events.handler_error", {
      eventType,
      callControlId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Event processing failed" }, { status: 503 });
  }

  return new NextResponse("", { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  let verificationError: string | undefined;
  const publicKey = await getTelnyxPublicKey().catch((error) => {
    verificationError = error instanceof Error ? error.message : "Verification unavailable";
    return undefined;
  });
  return NextResponse.json({ ok: Boolean(publicKey), signatureVerificationReady: Boolean(publicKey), publicKey, verificationError, audioRecordingEnabled: false }, { status: publicKey ? 200 : 503 });
}
