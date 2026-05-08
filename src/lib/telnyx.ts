import type { TwilioCallRequest } from "./twilio";
import { prepareCall } from "./telephony-runtime";
import { getAppBaseUrl } from "./twilio";

export interface TelnyxCallerIdOption {
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
    throw new Error(`Um Telnyx zu nutzen, fehlt die Umgebungsvariable ${name}.`);
  }
  return value;
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

export async function createTelnyxCall(payload: TwilioCallRequest, request?: Request) {
  const apiKey = readEnv("TELNYX_API_KEY");
  const connectionId = readEnv("TELNYX_CONNECTION_ID");
  const defaultFrom = readEnv("TELNYX_PHONE_NUMBER");
  const allowedCallerIds = getTelnyxCallerIds();
  const from = payload.from?.trim() || defaultFrom;

  if (!allowedCallerIds.includes(from)) {
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
    throw new Error(`Telnyx call failed: ${response.status}${details ? ` ${details}` : ""}`);
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
