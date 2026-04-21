export interface EdgeSessionUser {
  id: string;
  username: string;
  role: "master" | "user";
}

function getSessionSecret(): string {
  return (
    process.env.SESSION_SECRET?.trim() ||
    process.env.CALL_STATE_SECRET?.trim() ||
    "gloria-default-session-secret"
  );
}

function toBytesFromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    output[i] = binary.charCodeAt(i);
  }

  return output;
}

function decodePayload(value: string): Record<string, unknown> | null {
  try {
    const bytes = toBytesFromBase64Url(value);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
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

async function signPayload(payloadBase64: string): Promise<Uint8Array> {
  const keyData = new TextEncoder().encode(getSessionSecret());
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadBase64),
  );

  return new Uint8Array(signature);
}

export async function verifySessionTokenEdge(token: string | undefined): Promise<EdgeSessionUser | null> {
  if (!token) {
    return null;
  }

  const [payloadBase64, signatureBase64] = token.split(".");
  if (!payloadBase64 || !signatureBase64) {
    return null;
  }

  const payload = decodePayload(payloadBase64);
  if (!payload) {
    return null;
  }

  const exp = Number(payload.exp || 0);
  const now = Math.floor(Date.now() / 1000);

  if (!exp || exp <= now) {
    return null;
  }

  const expectedSignature = await signPayload(payloadBase64);
  const actualSignature = toBytesFromBase64Url(signatureBase64);

  if (!timingSafeEqualBytes(expectedSignature, actualSignature)) {
    return null;
  }

  const role = payload.role === "master" ? "master" : "user";

  return {
    id: String(payload.sub || ""),
    username: String(payload.username || ""),
    role,
  };
}
