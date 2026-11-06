import type { CallSource, Topic } from "./types";
import { createHmac } from "node:crypto";
import { CampaignOutsideHoursError, isWithinCampaignHours } from "./campaign-schedule";
import { prepareCall } from "./telephony-runtime";
import { findUserById, listPhoneNumbersByUser } from "./report-db";
import { normalizePhoneForDial } from "./phone-utils";
import { log } from "./log";
import type { UserRole } from "./session";

export interface TelnyxCallRequest {
  to: string;
  company: string;
  contactName?: string;
  leadNote?: string;
  topic: Topic;
  leadId?: string;
  userId?: string;
  phoneNumberId?: string;
  ownerRealName?: string;
  ownerRealPhone?: string;
  ownerRole?: UserRole;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  voiceId?: string;
  isTestCall?: boolean;
  callSource?: CallSource;
  from?: string;
  previousSummary?: string;
  isCallback?: boolean;
  queueId?: string;
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
const BLOCKED_OUTBOUND_NUMBERS = new Set(["+18446290030"]);

function normalizePhoneNumber(value?: string): string {
  return String(value || "").replace(/[\s()-]/g, "").trim();
}

function isBlockedOutboundNumber(value?: string): boolean {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return false;
  for (const blocked of BLOCKED_OUTBOUND_NUMBERS) {
    if (normalizePhoneNumber(blocked) === normalized) {
      return true;
    }
  }
  return false;
}

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
    normalize(process.env.MEDIA_STREAM_WSS_URL) ||
    "wss://gloria-tebr.onrender.com/telnyx-stream";

  return fallback;
}

export function encodeTelnyxClientState(payload: TelnyxCallRequest): string {
  const data = {
    v: 1,
    calledPhone: payload.to,
    company: payload.company,
    contactName: payload.contactName,
    leadNote: payload.leadNote,
    topic: payload.topic,
    leadId: payload.leadId,
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    ownerRealName: payload.ownerRealName,
    ownerRealPhone: payload.ownerRealPhone,
    ownerRole: payload.ownerRole,
    ownerCompanyName: payload.ownerCompanyName,
    ownerGesellschaft: payload.ownerGesellschaft,
    voiceId: payload.voiceId,
    isTestCall: payload.isTestCall === true,
    callSource: payload.callSource || (payload.isTestCall || !payload.leadId ? "manual" : "crm"),
    isCallback: payload.isCallback ? 1 : 0,
    queueId: payload.queueId,
    previousSummary: (payload.previousSummary || "").slice(0, 320),
  };

  const secret = process.env.APP_INTERNAL_TOKEN?.trim();
  const expiresAt = Date.now() + 24 * 60 * 60_000;
  const unsigned = { ...data, streamExpiresAt: expiresAt };
  const streamSignature = secret ? createHmac("sha256", secret).update(JSON.stringify(unsigned)).digest("hex") : undefined;
  const json = JSON.stringify({ ...unsigned, streamSignature });
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

export class CallOwnerIdentityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CallOwnerIdentityError";
  }
}

export async function resolveCallOwnerIdentity(userId?: string): Promise<{ realName: string; realPhone?: string; role: UserRole }> {
  const resolvedUserId = userId?.trim();
  if (!resolvedUserId) {
    throw new CallOwnerIdentityError("Der Anruf hat keinen zugeordneten Benutzer. Bitte den Kontakt einem Benutzer zuweisen.");
  }
  let owner: Awaited<ReturnType<typeof findUserById>>;
  try {
    owner = await findUserById(resolvedUserId);
  } catch (error) {
    log.error("telnyx.call_owner_lookup_failed", { userId: resolvedUserId, error });
    throw new CallOwnerIdentityError("Der Benutzer für diesen Anruf konnte nicht geladen werden.", { cause: error });
  }
  if (!owner) {
    throw new CallOwnerIdentityError("Der Benutzer für diesen Anruf wurde nicht gefunden.");
  }
  const realName = owner.realName.trim();
  if (!realName) {
    throw new CallOwnerIdentityError("Bitte den vollständigen Namen des Benutzers hinterlegen, bevor ein Anruf gestartet wird.");
  }
  const rawPhone = owner.realPhone.trim();
  const normalizedPhone = /^\+?[\d\s()./-]+$/.test(rawPhone) ? normalizePhoneForDial(rawPhone) : undefined;
  const realPhone = normalizedPhone && /^\+[1-9]\d{7,14}$/.test(normalizedPhone) ? normalizedPhone : undefined;
  if (rawPhone && !realPhone) log.warn("telnyx.call_owner_invalid_phone", { userId: resolvedUserId });
  return { realName, realPhone, role: owner.role };
}

export async function createTelnyxCall(payload: TelnyxCallRequest, request?: Request) {
  const isCampaign = (payload.callSource || (payload.isTestCall || !payload.leadId ? "manual" : "crm")) === "crm";
  if (isCampaign && !isWithinCampaignHours()) {
    throw new CampaignOutsideHoursError();
  }
  const owner = await resolveCallOwnerIdentity(payload.userId);
  const apiKey = readEnv("TELNYX_API_KEY");
  const connectionId = readEnv("TELNYX_CONNECTION_ID");
  const defaultFrom = readEnv("TELNYX_PHONE_NUMBER");
  const allowedCallerIds = getTelnyxCallerIds().filter((number) => !isBlockedOutboundNumber(number));

  let from = payload.from?.trim();

  if (payload.userId) {
    const assignedNumbers = (await listPhoneNumbersByUser(payload.userId))
      .filter((entry) => entry.active)
      .filter((entry) => !isBlockedOutboundNumber(entry.phoneNumber));

    if (assignedNumbers.length === 0) {
      throw new Error("Für diesen Benutzer ist keine aktive, zugewiesene Ausgangsnummer hinterlegt.");
    }

    if (payload.phoneNumberId) {
      const selected = assignedNumbers.find((entry) => entry.id === payload.phoneNumberId);
      if (!selected) {
        throw new Error("Die ausgewählte Ausgangsnummer ist diesem Benutzer nicht zugewiesen oder nicht aktiv.");
      }
      from = selected.phoneNumber;
    } else if (from) {
      const matching = assignedNumbers.find(
        (entry) => normalizePhoneNumber(entry.phoneNumber) === normalizePhoneNumber(from),
      );
      if (!matching) {
        throw new Error("Es dürfen nur dem Benutzer zugewiesene Ausgangsnummern verwendet werden.");
      }
      from = matching.phoneNumber;
    } else {
      from = assignedNumbers[0].phoneNumber;
    }
  }

  from = from || defaultFrom;

  if (isBlockedOutboundNumber(from)) {
    throw new Error("Diese Ausgangsnummer ist gesperrt und darf nicht für Telefonie verwendet werden.");
  }

  const ownedCallerIds = await listOwnedTelnyxNumbers();
  const allowedSet = new Set([...allowedCallerIds, ...ownedCallerIds.filter((number) => !isBlockedOutboundNumber(number))]);

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
        preloadId: payload.queueId,
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

  if (isCampaign && !isWithinCampaignHours()) {
    throw new CampaignOutsideHoursError();
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
    ...(payload.queueId ? { command_id: payload.queueId } : {}),
    to: payload.to,
    from,
    client_state: encodeTelnyxClientState({ ...payload, ownerRealName: owner.realName, ownerRealPhone: owner.realPhone, ownerRole: owner.role }),
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
