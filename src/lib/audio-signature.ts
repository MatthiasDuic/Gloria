// HMAC-signierte, kurzlebige Tokens für /api/twilio/audio?text=...
//
// Zweck: Verhindert, dass Dritte beliebigen Text durch unsere ElevenLabs-Pipeline
// ziehen (Quota-Missbrauch + Log-Leak). Signatur bindet den konkreten Text +
// Ablaufzeit an unser CALL_STATE_SECRET. Twilio ruft die URL nur wenige Sekunden
// nach Generierung ab, daher reicht ein 5-Minuten-TTL.

const DEFAULT_TTL_SECONDS = 300;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return base64UrlEncode(new Uint8Array(sig));
}

function getSecret(): string {
  const secret =
    process.env.CALL_STATE_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim() ||
    process.env.BASIC_AUTH_PASSWORD?.trim();
  if (!secret) {
    throw new Error("audio-signature: kein Secret konfiguriert (CALL_STATE_SECRET).");
  }
  return secret;
}

export async function signAudioText(
  text: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<{ exp: number; sig: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await hmacSha256Base64Url(getSecret(), `${exp}.${text}`);
  return { exp, sig };
}

export interface AudioSignatureCheck {
  ok: boolean;
  reason?: "missing" | "expired" | "mismatch" | "skipped";
}

function shouldSkipValidation(): boolean {
  return (process.env.AUDIO_SIGNATURE_SKIP_VALIDATION || "").toLowerCase() === "true";
}

export async function verifyAudioText(
  text: string | null,
  expRaw: string | null,
  sig: string | null,
): Promise<AudioSignatureCheck> {
  if (shouldSkipValidation()) {
    return { ok: true, reason: "skipped" };
  }

  if (!text || !expRaw || !sig) {
    return { ok: false, reason: "missing" };
  }

  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp)) {
    return { ok: false, reason: "missing" };
  }

  if (Math.floor(Date.now() / 1000) > exp) {
    return { ok: false, reason: "expired" };
  }

  const expected = await hmacSha256Base64Url(getSecret(), `${exp}.${text}`);
  if (!timingSafeEqual(expected, sig)) {
    return { ok: false, reason: "mismatch" };
  }
  return { ok: true };
}
