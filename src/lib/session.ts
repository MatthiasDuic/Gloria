import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type UserRole = "master" | "user";

export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
  realName: string;
  companyName: string;
  gesellschaft: string;
}

interface SessionTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
  realName: string;
  companyName: string;
  gesellschaft: string;
  iat: number;
  exp: number;
}

const SESSION_TTL_SECONDS = Math.max(
  60 * 30,
  Number.parseInt(process.env.SESSION_TTL_SECONDS || `${60 * 60 * 12}`, 10),
);

function getSessionSecret(): string {
  return (
    process.env.SESSION_SECRET?.trim() ||
    process.env.CALL_STATE_SECRET?.trim() ||
    "gloria-default-session-secret"
  );
}

function toBase64Url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(padLength)}`, "base64");
}

function signValue(value: string): string {
  return toBase64Url(createHmac("sha256", getSessionSecret()).update(value).digest());
}

export function createSessionToken(user: SessionUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionTokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    realName: user.realName,
    companyName: user.companyName,
    gesellschaft: user.gesellschaft,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token: string | undefined): SessionUser | null {
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signValue(encodedPayload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expectedSignature);

  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload).toString("utf8")) as SessionTokenPayload;

    if (!parsed.sub || !parsed.username || !parsed.role || !parsed.exp) {
      return null;
    }

    if (parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      id: parsed.sub,
      username: parsed.username,
      role: parsed.role,
      realName: parsed.realName || "",
      companyName: parsed.companyName || "",
      gesellschaft: parsed.gesellschaft || "",
    };
  } catch {
    return null;
  }
}

export function hashPassword(rawPassword: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(rawPassword, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(rawPassword: string, storedHash: string): boolean {
  const [salt, expectedHash] = storedHash.split(":");

  if (!salt || !expectedHash) {
    return false;
  }

  const actualHash = scryptSync(rawPassword, salt, 64).toString("hex");
  const left = Buffer.from(actualHash, "hex");
  const right = Buffer.from(expectedHash, "hex");

  return left.length === right.length && timingSafeEqual(left, right);
}

export const SESSION_COOKIE_NAME = "gloria_session";
