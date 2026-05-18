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

type DecodedClientState = {
  company?: string;
  contactName?: string;
  topic?: string;
  leadId?: string;
  userId?: string;
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

function findRecordingUrl(input: unknown): string | undefined {
  if (!input) return undefined;
  if (typeof input === "string") {
    const value = input.trim();
    if (!/^https?:\/\//i.test(value)) return undefined;
    if (/record|recording|\.mp3\b|\.wav\b|\.m4a\b/i.test(value)) return value;
    return undefined;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const nested = findRecordingUrl(item);
      if (nested) return nested;
    }
    return undefined;
  }
  if (typeof input === "object") {
    for (const value of Object.values(input as Record<string, unknown>)) {
      const nested = findRecordingUrl(value);
      if (nested) return nested;
    }
  }
  return undefined;
}

async function postRecordingToCallsWebhook(params: {
  callSid: string;
  state: DecodedClientState;
  recordingUrl: string;
}): Promise<void> {
  const baseUrl = process.env.APP_BASE_URL?.trim()?.replace(/\/$/, "");
  if (!baseUrl || !params.state.company || !params.state.topic) {
    return;
  }

  const token = process.env.APP_INTERNAL_TOKEN?.trim() || "";
  const payload = {
    userId: params.state.userId,
    leadId: params.state.leadId,
    callSid: params.callSid,
    company: params.state.company,
    contactName: params.state.contactName,
    topic: params.state.topic,
    recordingUrl: params.recordingUrl,
  };

  const response = await fetch(`${baseUrl}/api/calls/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-gloria-internal-token": token } : {}),
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`calls/webhook recording post failed: ${response.status} ${details}`);
  }
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
  const clientState = decodeClientState(event.payload?.client_state);
  const extractedRecordingUrl =
    event.payload?.recording_url ||
    findRecordingUrl((parsedBody as { data?: { payload?: unknown } })?.data?.payload);

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
      // Recording parallel zum Media-Stream starten, damit bei erteilter
      // Einwilligung eine echte Audiodatei fuer den Report vorliegt.
      await sendTelnyxCommand(callControlId, "record_start", {
        format: "mp3",
        channels: "dual",
        ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
      }).catch(async (error) => {
        log.warn("telnyx.events.record_start_with_options_failed", {
          callControlId,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          await sendTelnyxCommand(callControlId, "record_start", {
            ...(event.payload?.client_state ? { client_state: event.payload.client_state } : {}),
          });
        } catch (fallbackError) {
          log.warn("telnyx.events.record_start_fallback_failed", {
            callControlId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      });
    } else if (eventType === "call.streaming.failed") {
      log.warn("telnyx.events.streaming_failed", {
        callControlId,
        callLegId: event.payload?.call_leg_id,
        callSessionId: event.payload?.call_session_id,
      });
    } else if (eventType === "call.recording.saved" || eventType === "call.recording.available") {
      if (extractedRecordingUrl) {
        await postRecordingToCallsWebhook({
          callSid: callControlId,
          state: clientState,
          recordingUrl: extractedRecordingUrl,
        });
        log.info("telnyx.events.recording_forwarded", {
          callControlId,
          recordingId: event.payload?.recording_id,
        });
      } else {
        log.warn("telnyx.events.recording_missing_url", {
          callControlId,
          eventType,
        });
      }
    } else if (eventType === "call.hangup") {
      if (extractedRecordingUrl) {
        await postRecordingToCallsWebhook({
          callSid: callControlId,
          state: clientState,
          recordingUrl: extractedRecordingUrl,
        });
      }
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
