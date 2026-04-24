import { createHmac, timingSafeEqual } from "node:crypto";

function getSecret(): string {
  return (
    process.env.CALENDAR_FEED_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    process.env.CALL_STATE_SECRET?.trim() ||
    "gloria-default-calendar-secret"
  );
}

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Signierter, langlebiger Token fuer Kalender-Feed-URLs.
 * Format: <userId>.<base64url(hmac_sha256(secret, userId))>
 * Bewusst ohne Expiration – der Feed soll dauerhaft abonnierbar bleiben.
 * Beim Widerruf: CALENDAR_FEED_SECRET rotieren -> alle bestehenden URLs werden ungueltig.
 */
export function createCalendarFeedToken(userId: string): string {
  const sig = toBase64Url(
    createHmac("sha256", getSecret()).update(userId).digest(),
  );
  return `${userId}.${sig}`;
}

export function verifyCalendarFeedToken(token: string): string | null {
  const [userId, sig] = token.split(".");
  if (!userId || !sig) return null;

  const expected = toBase64Url(
    createHmac("sha256", getSecret()).update(userId).digest(),
  );

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;

  try {
    return timingSafeEqual(a, b) ? userId : null;
  } catch {
    return null;
  }
}
