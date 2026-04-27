import type { Topic } from "./types";
import { prepareCall } from "./telephony-runtime";

export interface TwilioCallRequest {
  to: string;
  company: string;
  contactName?: string;
  topic: Topic;
  leadId?: string;
  userId?: string;
  phoneNumberId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  isTestCall?: boolean;
  from?: string;
}

export interface TwilioCallerIdOption {
  number: string;
  label: string;
}

const MAX_PREPARE_CALL_TIMEOUT_MS = 12_000;
const PREPARE_CALL_TIMEOUT_MS = Math.min(
  MAX_PREPARE_CALL_TIMEOUT_MS,
  Math.max(3_000, Number.parseInt(process.env.PREPARE_CALL_TIMEOUT_MS || "6000", 10)),
);
const PREPARE_CALL_RETRY_MS = Math.max(
  150,
  Number.parseInt(process.env.PREPARE_CALL_RETRY_MS || "350", 10),
);

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

export function getTwilioCallerIds(): string[] {
  const primary = process.env.TWILIO_PHONE_NUMBER?.trim();
  const rawList = process.env.TWILIO_PHONE_NUMBERS || "";
  const extras = rawList
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);

  const merged = [primary, ...extras].filter((value): value is string => Boolean(value));
  return [...new Set(merged)];
}

function getTwilioCallerIdLabelMap(): Record<string, string> {
  const raw = process.env.TWILIO_PHONE_NUMBER_LABELS || "";
  const map: Record<string, string> = {};

  for (const entry of raw.split(/[;,\n]/).map((value) => value.trim()).filter(Boolean)) {
    const [number, ...labelParts] = entry.split(":");
    const phoneNumber = number?.trim();
    const label = labelParts.join(":").trim();

    if (phoneNumber && label) {
      map[phoneNumber] = label;
    }
  }

  return map;
}

export function getTwilioCallerIdOptions(): TwilioCallerIdOption[] {
  const numbers = getTwilioCallerIds();
  const labelMap = getTwilioCallerIdLabelMap();

  return numbers.map((number, index) => {
    const configured = labelMap[number];
    if (configured) {
      return { number, label: configured };
    }

    if (index === 0) {
      return { number, label: "Agentur-Duic" };
    }

    return { number, label: `Nummer ${index + 1}` };
  });
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
  const defaultFrom = readEnv("TWILIO_PHONE_NUMBER");
  const allowedCallerIds = getTwilioCallerIds();
  const from = payload.from?.trim() || defaultFrom;

  if (!allowedCallerIds.includes(from)) {
    throw new Error("Ausgangsnummer ist nicht freigegeben. Bitte wählen Sie eine konfigurierte Twilio-Nummer.");
  }
  const baseUrl = getAppBaseUrl(request);

  const prepareDeadline = Date.now() + PREPARE_CALL_TIMEOUT_MS;
  let preparation: Awaited<ReturnType<typeof prepareCall>> | null = null;
  let lastPrepareError: unknown;

  while (Date.now() < prepareDeadline) {
    try {
      preparation = await prepareCall({
        topic: payload.topic,
        userId: payload.userId,
        baseUrl,
        request,
      });

      if (preparation.ready && preparation.topicProfileLoaded) {
        break;
      }
    } catch (error) {
      lastPrepareError = error;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, PREPARE_CALL_RETRY_MS);
    });
  }

  const topicProfileLoaded = Boolean(preparation?.topicProfileLoaded);
  const preparedForStream = Boolean(preparation?.ready && topicProfileLoaded);

  if (!preparation || !topicProfileLoaded) {
    const reason =
      lastPrepareError instanceof Error
        ? lastPrepareError.message
        : "Initialisierung ist nicht rechtzeitig fertig geworden.";
    throw new Error(`RUNTIME_NOT_READY: ${reason}`);
  }

  const voiceUrl = buildUrl(baseUrl, "/api/twilio/voice", {
    leadId: payload.leadId,
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    ownerRealName: payload.ownerRealName,
    ownerCompanyName: payload.ownerCompanyName,
    ownerGesellschaft: payload.ownerGesellschaft,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    prepared: preparedForStream ? "1" : undefined,
    preparedAt: preparation.preparedAt,
    rtProfileKey: preparation.topicProfileKey,
    prepMode: preparedForStream ? "ready" : "degraded",
  });

  const statusCallback = buildUrl(baseUrl, "/api/twilio/status", {
    leadId: payload.leadId,
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    testCall: payload.isTestCall ? "1" : undefined,
  });

  const body = new URLSearchParams();
  body.set("To", payload.to);
  body.set("From", from);
  body.set("Method", "POST");
  body.set("Url", voiceUrl);
  body.set("StatusCallback", statusCallback);
  body.set("StatusCallbackMethod", "POST");
  body.append("StatusCallbackEvent", "initiated");
  body.append("StatusCallbackEvent", "ringing");
  body.append("StatusCallbackEvent", "answered");
  body.append("StatusCallbackEvent", "completed");
  body.set("Record", "true");
  body.set("RecordingChannels", "mono");
  body.set("RecordingStatusCallback", statusCallback);
  body.set("RecordingStatusCallbackMethod", "POST");

  const authHeader = btoa(`${accountSid}:${authToken}`);
  const twilioApiTimeoutMs = Math.max(
    3_000,
    Math.min(30_000, Number.parseInt(process.env.TWILIO_API_TIMEOUT_MS || "10000", 10)),
  );
  const twilioController = new AbortController();
  const twilioTimer = setTimeout(() => twilioController.abort(), twilioApiTimeoutMs);
  let response: Response;
  try {
    response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authHeader}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
        cache: "no-store",
        signal: twilioController.signal,
      },
    );
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(
        `Twilio API hat nicht innerhalb von ${twilioApiTimeoutMs}ms geantwortet. Bitte erneut versuchen.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(twilioTimer);
  }

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Twilio API Fehler (${response.status}): ${details}`);
  }

  const created = (await response.json()) as {
    sid: string;
    status: string;
    to: string;
    from: string;
  };

  return created;
}
