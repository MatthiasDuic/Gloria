import type { Topic } from "./types";
import { prepareCall } from "./telephony-runtime";

export interface TelnyxCallerIdOption {
  number: string;
  label: string;
}

export interface TelnyxCallRequest {
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
  voiceId?: string;
  isTestCall?: boolean;
  from?: string;
  previousSummary?: string;
  isCallback?: boolean;
}

export class TelnyxApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TelnyxApiError";
    this.status = status;
  }
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

function getAppBaseUrl(request?: Request): string {
  const configured = process.env.APP_BASE_URL?.trim();

  if (configured) {
    try {
      return new URL(configured).toString().replace(/\/$/, "");
    } catch {
      if (!request) {
        throw new Error(
          "APP_BASE_URL ist ungueltig. Bitte den vollstaendigen Wert inklusive https:// setzen, z. B. https://gloria.agentur-duic-sprockhoevel.de",
        );
      }
    }
  }

  if (request) {
    const url = new URL(request.url);
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
    const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "");

    return `${proto}://${host}`.replace(/\/$/, "");
  }

  throw new Error(
    "APP_BASE_URL fehlt. Bitte eine oeffentliche URL setzen, z. B. ueber Cloudflare Tunnel oder ngrok.",
  );
}

function getTelnyxMediaStreamUrl(): string {
  const explicit = process.env.TELNYX_MEDIA_STREAM_URL?.trim();
  if (explicit) {
    return explicit;
  }

  const fallback = process.env.MEDIA_STREAM_WSS_URL?.trim();
  if (fallback) {
    return fallback.replace("/twilio-stream", "/telnyx-stream");
  }

  throw new Error("TELNYX_MEDIA_STREAM_URL fehlt. Bitte eine ws:// oder wss:// URL setzen.");
}

function encodeTelnyxClientState(payload: TelnyxCallRequest): string {
  const data = {
    v: 1,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    leadId: payload.leadId,
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    ownerRealName: payload.ownerRealName,
    ownerCompanyName: payload.ownerCompanyName,
    ownerGesellschaft: payload.ownerGesellschaft,
    voiceId: payload.voiceId,
    isCallback: payload.isCallback ? 1 : 0,
    previousSummary: (payload.previousSummary || "").slice(0, 320),
  };

  const json = JSON.stringify(data);
  return Buffer.from(json, "utf8").toString("base64");
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Um Telnyx zu nutzen, fehlt die Umgebungsvariable ${name}.`);
  }
  return value;
}

function formatTelnyxCallError(status: number, details: string): string {
  const payload = details ? (JSON.parse(details) as {
    errors?: Array<{ detail?: string }>;
    telnyx_error?: { error_code?: string };
  }) : undefined;

  const telnyxCode = payload?.telnyx_error?.error_code?.trim();
  const detailText = payload?.errors?.[0]?.detail?.trim();

  if (status === 403 && telnyxCode === "D13") {
    return [
      "Telnyx blockiert den Zielanruf (D13): Die Zielnummer liegt in einem Land, das im Outbound Voice Profile nicht freigeschaltet ist.",
      "Bitte in Telnyx unter Outbound Voice Profile die Ziel-Laender-Whitelist erweitern und das Profil der genutzten Connection zuweisen.",
      detailText || "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const fallback = `Telnyx call failed: ${status}${details ? ` ${details}` : ""}`;
  return detailText ? `${fallback} (${detailText})` : fallback;
}

export function isTelnyxConfigured(): boolean {
  return Boolean(
    process.env.TELNYX_API_KEY?.trim() &&
      process.env.TELNYX_CONNECTION_ID?.trim() &&
      process.env.TELNYX_PHONE_NUMBER?.trim(),
  );
}

export function getTelnyxApiBaseUrl(): string {
  const explicit = process.env.TELNYX_API_BASE_URL?.trim();
  if (explicit) {
    try {
      return new URL(explicit).toString().replace(/\/$/, "");
    } catch {
      throw new Error("TELNYX_API_BASE_URL ist ungueltig. Bitte eine vollstaendige https:// URL setzen.");
    }
  }

  return "https://api.telnyx.com/v2";
}

export function getTelnyxCallerIds(): string[] {
  const primary = process.env.TELNYX_PHONE_NUMBER?.trim();
  const rawList = process.env.TELNYX_PHONE_NUMBERS || "";
  const extras = rawList
    .split(/[;,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);

  const merged = [primary, ...extras].filter((value): value is string => Boolean(value));
  return [...new Set(merged)];
}

function getTelnyxCallerIdLabelMap(): Record<string, string> {
  const raw = process.env.TELNYX_PHONE_NUMBER_LABELS || "";
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

export function getTelnyxCallerIdOptions(): TelnyxCallerIdOption[] {
  const numbers = getTelnyxCallerIds();
  const labelMap = getTelnyxCallerIdLabelMap();

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

async function listOwnedTelnyxNumbers(): Promise<string[]> {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!apiKey) {
    return [];
  }

  const apiBaseUrl = getTelnyxApiBaseUrl();
  const response = await fetch(`${apiBaseUrl}/phone_numbers?page[size]=250`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  }).catch(() => null);

  if (!response || !response.ok) {
    return [];
  }

  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{ phone_number?: string }>;
  };

  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows
    .map((entry) => String(entry.phone_number || "").trim())
    .filter(Boolean);
}

export async function createTelnyxCall(payload: TelnyxCallRequest, request?: Request) {
  const apiKey = readEnv("TELNYX_API_KEY");
  const connectionId = readEnv("TELNYX_CONNECTION_ID");
  const defaultFrom = readEnv("TELNYX_PHONE_NUMBER");
  const allowedCallerIds = getTelnyxCallerIds();
  const from = payload.from?.trim() || defaultFrom;

  const ownedCallerIds = await listOwnedTelnyxNumbers();
  const allowedSet = new Set([...allowedCallerIds, ...ownedCallerIds]);

  if (!allowedSet.has(from)) {
    throw new Error("Ausgangsnummer ist nicht freigegeben. Bitte waehlen Sie eine konfigurierte Telnyx-Nummer.");
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
  if (!preparation || !topicProfileLoaded) {
    const reason =
      lastPrepareError instanceof Error
        ? lastPrepareError.message
        : "Initialisierung ist nicht rechtzeitig fertig geworden.";
    throw new Error(`RUNTIME_NOT_READY: ${reason}`);
  }

  const apiBaseUrl = getTelnyxApiBaseUrl();
  const timeoutMs = Math.max(
    3_000,
    Math.min(30_000, Number.parseInt(process.env.TELNYX_API_TIMEOUT_MS || "10000", 10)),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    connection_id: connectionId,
    to: payload.to,
    from,
    client_state: encodeTelnyxClientState(payload),
    stream_url: getTelnyxMediaStreamUrl(),
    stream_track: "both_tracks",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "L16",
    stream_bidirectional_sampling_rate: 16000,
  };

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(
        `Telnyx API hat nicht innerhalb von ${timeoutMs}ms geantwortet. Bitte erneut versuchen.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const details = await response.text();
  if (!response.ok) {
    let message: string;

    try {
      message = formatTelnyxCallError(response.status, details);
    } catch {
      message = `Telnyx call failed: ${response.status}${details ? ` ${details}` : ""}`;
    }

    throw new TelnyxApiError(message, response.status);
  }

  let data:
    | {
        data?: {
          call_control_id?: string;
          call_leg_id?: string;
          call_session_id?: string;
          call_state?: string;
          to?: string;
          from?: string;
        };
      }
    | undefined;

  try {
    data = JSON.parse(details) as typeof data;
  } catch {
    data = undefined;
  }

  const sid =
    data?.data?.call_control_id ||
    data?.data?.call_leg_id ||
    data?.data?.call_session_id ||
    "";

  return {
    sid,
    status: data?.data?.call_state || "queued",
    to: data?.data?.to || payload.to,
    from: data?.data?.from || from,
  };
}
