import type { Topic } from "./types";

export type CallStep = "intro" | "consent" | "conversation" | "appointment" | "finished";
export type ContactRole = "gatekeeper" | "decision-maker";
export type RoleState = "reception" | "transfer" | "decision_maker";

export interface TokenizedCallState {
  userId?: string;
  phoneNumberId?: string;
  callSid?: string;
  leadId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  company: string;
  contactName?: string;
  directDial?: string;
  decisionMakerIntroDone?: boolean;
  scriptPhaseIndex?: number;
  scriptSegmentIndex?: number;
  healthQuestionIndex?: number;
  pkvHealthIntroDone?: boolean;
  appointmentAtDraft?: string;
  appointmentNoteDraft?: string;
  appointmentProposalAsked?: boolean;
  appointmentPreference?: "morning" | "afternoon" | "any";
  appointmentOptionAAt?: string;
  appointmentOptionBAt?: string;
  topic: Topic;
  step: CallStep;
  consent: "yes" | "no";
  consentAsked?: boolean;
  turn: number;
  transcript: string;
  contactRole: ContactRole;
  roleState?: RoleState;
  issuedAt: number;
  expiresAt: number;
}

const TOKEN_TTL_SECONDS = 60 * 60 * 2;

function base64UrlEncodeText(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToText(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getTokenSecret() {
  return (
    process.env.CALL_STATE_SECRET?.trim() ||
    process.env.TWILIO_AUTH_TOKEN?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-call-state-secret"
  );
}

async function signPayload(payloadBase64: string): Promise<string> {
  const keyData = new TextEncoder().encode(getTokenSecret());
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = new TextEncoder().encode(payloadBase64);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return bytesToBase64Url(new Uint8Array(signature));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

export async function encodeCallStateToken(
  payload: Omit<TokenizedCallState, "issuedAt" | "expiresAt">,
  ttlSeconds = TOKEN_TTL_SECONDS,
) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const fullPayload: TokenizedCallState = {
    ...payload,
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + ttlSeconds,
  };

  const payloadBase64 = base64UrlEncodeText(JSON.stringify(fullPayload));
  const signature = await signPayload(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export async function decodeCallStateToken(token: string | null | undefined, expectedCallSid?: string) {
  if (!token?.trim()) {
    return undefined;
  }

  try {
    const [payloadBase64, signatureBase64] = token.split(".");

    if (!payloadBase64 || !signatureBase64) {
      return undefined;
    }

    const expectedSignature = await signPayload(payloadBase64);
    const actualBytes = base64UrlToBytes(signatureBase64);
    const expectedBytes = base64UrlToBytes(expectedSignature);

    if (!timingSafeEqualBytes(actualBytes, expectedBytes)) {
      return undefined;
    }

    const parsed = JSON.parse(base64UrlDecodeToText(payloadBase64)) as TokenizedCallState;
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
