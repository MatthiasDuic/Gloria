// Edge-kompatible Twilio-Webhook-Signaturvalidierung.
// Twilio-Algorithmus:
//   POST x-www-form-urlencoded -> HMAC-SHA1(url + key1value1key2value2..., AUTH_TOKEN), base64
//     Parameter werden nach key alphabetisch sortiert.
//   GET  -> HMAC-SHA1(url, AUTH_TOKEN), base64. Parameter sind bereits in der URL.
// Referenz: https://www.twilio.com/docs/usage/webhooks/webhooks-security

import { getAppBaseUrl } from "@/lib/twilio";

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha1Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return base64Encode(new Uint8Array(signature));
}

export interface TwilioSignatureValidationResult {
  ok: boolean;
  reason?: "missing-token" | "missing-header" | "mismatch" | "skipped";
  publicUrl?: string;
  form?: FormData;
}

function shouldSkipValidation(): boolean {
  const raw = (process.env.TWILIO_SKIP_SIGNATURE_VALIDATION || "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Validiert die Twilio-Webhook-Signatur einer Anfrage.
 * Gibt bei POST zusätzlich die bereits geparste FormData zurück, damit der
 * Body nicht doppelt gelesen werden muss (Edge-Request-Body ist ein Stream).
 */
export async function validateTwilioRequest(
  request: Request,
): Promise<TwilioSignatureValidationResult> {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!authToken) {
    return { ok: false, reason: "missing-token" };
  }

  if (shouldSkipValidation()) {
    return { ok: true, reason: "skipped" };
  }

  const header = request.headers.get("x-twilio-signature")?.trim();
  if (!header) {
    return { ok: false, reason: "missing-header" };
  }

  const requestUrl = new URL(request.url);
  const publicBase = getAppBaseUrl(request);
  const publicUrl = `${publicBase}${requestUrl.pathname}${requestUrl.search}`;

  let message = publicUrl;
  let form: FormData | undefined;

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      // Klonen, damit der Aufrufer den Body später erneut als formData() lesen kann.
      form = await request.clone().formData();
      const entries: Array<[string, string]> = [];
      form.forEach((value, key) => {
        entries.push([key, typeof value === "string" ? value : ""]);
      });
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [k, v] of entries) {
        message += k + v;
      }
    }
  }

  const expected = await hmacSha1Base64(authToken, message);

  if (!timingSafeEqual(expected, header)) {
    // Debug-Ausgabe hilft, die Ursache für Mismatches zu finden (anderer
    // Host zwischen TwiML-Generator und Twilio-Webhook, nicht-kanonische
    // Form-Parameter, Proxy-Rewrites, etc.). Enthält keine Secrets.
    if ((process.env.TWILIO_SIGNATURE_DEBUG || "").toLowerCase() === "true") {
      console.log(
        JSON.stringify({
          level: "warn",
          message: "twilio.signature_debug",
          publicUrl,
          receivedHeader: header,
          expectedSignature: expected,
          method: request.method,
          paramKeys: form ? Array.from(form.keys()).sort() : undefined,
        }),
      );
    }
    return { ok: false, reason: "mismatch", publicUrl, form };
  }

  return { ok: true, publicUrl, form };
}
