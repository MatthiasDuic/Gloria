import { createHash, createPublicKey, verify } from "node:crypto";

let cachedPublicKey: { key: string; expiresAt: number } | undefined;
let publicKeyRequest: Promise<string> | undefined;

export function extractTelnyxPublicKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    if (value.includes("BEGIN PUBLIC KEY")) return value;
    if (/^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, "hex").toString("base64");
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value) && [32,44].includes(Buffer.from(value, "base64").length)) return value;
    return undefined;
  }
  if (Array.isArray(value)) return value.map(extractTelnyxPublicKey).find(Boolean);
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ["public", "public_key", "publicKey", "key", "data"]) {
      const found = extractTelnyxPublicKey(object[key]);
      if (found) return found;
    }
  }
  return undefined;
}

export async function getTelnyxPublicKey(): Promise<string> {
  if (process.env.TELNYX_PUBLIC_KEY?.trim()) return process.env.TELNYX_PUBLIC_KEY.trim();
  if (cachedPublicKey && cachedPublicKey.expiresAt > Date.now()) return cachedPublicKey.key;
  if (!publicKeyRequest) {
    publicKeyRequest = (async () => {
      const apiKey = process.env.TELNYX_API_KEY?.trim();
      if (!apiKey) throw new Error("Telnyx authentication is not configured");
      const base = process.env.TELNYX_API_BASE_URL?.replace(/\/$/, "") || "https://api.telnyx.com/v2";
      const response = await fetch(`${base}/public_key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Telnyx public key unavailable: ${response.status}`);
      const body = await response.json();
      const key = extractTelnyxPublicKey(body);
      if (!key) throw new Error(`Invalid Telnyx public key response (${Object.entries(body.data || {}).map(([name,value]) => `${name}:${typeof value}:${typeof value === "string" ? value.length : ""}`).join(",")})`);
      cachedPublicKey = { key, expiresAt: Date.now() + 3600_000 };
      return key;
    })().finally(() => { publicKeyRequest = undefined; });
  }
  return publicKeyRequest;
}

export function verifyTelnyxWebhook(body: string, headers: Headers, publicKey: string, now = Date.now()): boolean {
  const timestamp = headers.get("telnyx-timestamp") || "";
  const signature = headers.get("telnyx-signature-ed25519") || "";
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !signature) return false;
  try {
    const rawKey = Buffer.from(publicKey, "base64");
    const key = publicKey.includes("BEGIN PUBLIC KEY") ? createPublicKey(publicKey)
      : createPublicKey({ key: rawKey.length === 32 ? Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]) : rawKey, format: "der", type: "spki" });
    return verify(null, Buffer.from(`${timestamp}|${body}`), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function telnyxCommandId(eventId: string, action: string): string {
  const hash = createHash("sha256").update(`${eventId}:${action}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}