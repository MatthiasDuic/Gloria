import { createHmac, timingSafeEqual } from "node:crypto";
import type { Topic } from "./types";

export type CallStep = "intro" | "consent" | "conversation" | "finished";
export type ContactRole = "gatekeeper" | "decision-maker";

export interface TokenizedCallState {
  callSid?: string;
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  step: CallStep;
  consent: "yes" | "no";
  turn: number;
  transcript: string;
  contactRole: ContactRole;
  issuedAt: number;
  expiresAt: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 2;

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getTokenSecret() {
  return (
    process.env.CALL_STATE_SECRET?.trim() ||
    process.env.TWILIO_AUTH_TOKEN?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-call-state-secret"
  );
}

function signPayload(payloadBase64: string) {
  return createHmac("sha256", getTokenSecret()).update(payloadBase64).digest("base64url");
}

export function encodeCallStateToken(
  payload: Omit<TokenizedCallState, "issuedAt" | "expiresAt">,
  ttlSeconds = TOKEN_TTL_SECONDS,
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fullPayload: TokenizedCallState = {
    ...payload,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
  };

  const payloadBase64 = encodeBase64Url(JSON.stringify(fullPayload));
  const signature = signPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export function decodeCallStateToken(token: string | null | undefined, expectedCallSid?: string) {
  if (!token?.trim()) {
    return undefined;
  }

  try {
    const [payloadBase64, signatureBase64] = token.split(".");

    if (!payloadBase64 || !signatureBase64) {
      return undefined;
    }

    const expectedSignature = signPayload(payloadBase64);
    const actualBuffer = Buffer.from(signatureBase64, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (actualBuffer.length !== expectedBuffer.length) {
      return undefined;
    }

    if (!timingSafeEqual(actualBuffer, expectedBuffer)) {
      return undefined;
    }

    const parsed = JSON.parse(decodeBase64Url(payloadBase64)) as TokenizedCallState;
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (!parsed.expiresAt || parsed.expiresAt < nowSeconds) {
      return undefined;
    }

    if (expectedCallSid && parsed.callSid && parsed.callSid !== expectedCallSid) {
      return undefined;
    }

    return parsed;
  } catch {
    return undefined;
  }
}