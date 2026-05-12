import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TelnyxEventPayload = {
  call_control_id?: string;
  call_leg_id?: string;
  call_session_id?: string;
  client_state?: string;
  stream_url?: string;
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
  const value =
    process.env.TELNYX_MEDIA_STREAM_URL?.trim() ||
    process.env.TWILIO_MEDIA_STREAM_URL?.trim()?.replace("/twilio-stream", "/telnyx-stream") ||
    process.env.MEDIA_STREAM_WSS_URL?.trim()?.replace("/twilio-stream", "/telnyx-stream");

  if (!value) {
    throw new Error("TELNYX_MEDIA_STREAM_URL fehlt.");
  }

  return value;
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
    body: JSON.stringify(body),
    cache: "no-store",
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

export async function POST(request: Request): Promise<NextResponse> {
  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return new NextResponse("", { status: 200 });
  }

  const event = parseEvent(parsedBody);
  const eventType = event.event_type || "unknown";
  const callControlId = event.payload?.call_control_id;

  if (!callControlId) {
    log.warn("telnyx.events.missing_call_control_id", { eventType });
    return new NextResponse("", { status: 200 });
  }

  try {
    if (eventType === "call.initiated") {
      await sendTelnyxCommand(callControlId, "answer", {
        ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
      });
    } else if (eventType === "call.answered") {
      await sendTelnyxCommand(callControlId, "streaming_start", {
        stream_url: getTelnyxMediaStreamUrl(),
        stream_track: "both_tracks",
        stream_bidirectional_mode: "rtp",
        stream_bidirectional_codec: "L16",
        stream_bidirectional_sampling_rate: 16000,
        ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
      });
    } else if (eventType === "call.streaming.failed") {
      log.warn("telnyx.events.streaming_failed", {
        callControlId,
        callLegId: event.payload?.call_leg_id,
        callSessionId: event.payload?.call_session_id,
      });
    } else if (eventType === "call.hangup") {
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
  }

  return new NextResponse("", { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse("telnyx events endpoint ok", { status: 200 });
}
