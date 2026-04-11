import type { Topic } from "./types";

export interface TwilioCallRequest {
  to: string;
  company: string;
  contactName?: string;
  topic: Topic;
  leadId?: string;
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Um Twilio zu nutzen, fehlt die Umgebungsvariable ${name}.`);
  }

  return value;
}

export function isTwilioConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_PHONE_NUMBER?.trim(),
  );
}

export type TwilioConversationMode = "guided" | "live" | "media-stream";

export function getTwilioConversationMode(): TwilioConversationMode {
  const value = process.env.TWILIO_CONVERSATION_MODE?.trim().toLowerCase();

  if (value === "guided") {
    return "guided";
  }

  if (value === "media-stream") {
    return "media-stream";
  }

  return "live";
}

export function getTwilioMediaStreamUrl() {
  const value = process.env.TWILIO_MEDIA_STREAM_URL?.trim();

  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      throw new Error("Twilio Media Streams erwarten eine ws:// oder wss:// URL.");
    }

    return url.toString();
  } catch {
    throw new Error(
      "TWILIO_MEDIA_STREAM_URL ist ungültig. Bitte als vollständige ws:// oder wss:// URL setzen.",
    );
  }
}

export function getAppBaseUrl(request?: Request) {
  const configured = process.env.APP_BASE_URL?.trim();

  if (configured) {
    try {
      return new URL(configured).toString().replace(/\/$/, "");
    } catch {
      if (!request) {
        throw new Error(
          "APP_BASE_URL ist ungültig. Bitte den vollständigen Wert inklusive https:// setzen, z. B. https://gloria.agentur-duic-sprockhoevel.de",
        );
      }
    }
  }

  if (request) {
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

  throw new Error(
    "APP_BASE_URL fehlt. Für Twilio braucht Gloria eine öffentliche URL, z. B. über Cloudflare Tunnel oder ngrok.",
  );
}

function buildUrl(
  baseUrl: string,
  pathname: string,
  params: Record<string, string | undefined>,
) {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, "")}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

export async function createTwilioCall(payload: TwilioCallRequest, request?: Request) {
  const accountSid = readEnv("TWILIO_ACCOUNT_SID");
  const authToken = readEnv("TWILIO_AUTH_TOKEN");
  const from = readEnv("TWILIO_PHONE_NUMBER");
  const baseUrl = getAppBaseUrl(request);
  const { default: twilio } = await import("twilio");

  const client = twilio(accountSid, authToken);

  return client.calls.create({
    to: payload.to,
    from,
    method: "POST",
    url: buildUrl(baseUrl, "/api/twilio/voice", {
      leadId: payload.leadId,
      company: payload.company,
      contactName: payload.contactName,
      topic: payload.topic,
    }),
    statusCallback: buildUrl(baseUrl, "/api/twilio/status", {
      leadId: payload.leadId,
      company: payload.company,
      contactName: payload.contactName,
      topic: payload.topic,
    }),
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });
}
