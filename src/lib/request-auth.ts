import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken, type SessionUser } from "@/lib/session";

export function getSessionUserFromRequest(request: Request | NextRequest): SessionUser | null {
  const cookieHeader = request.headers.get("cookie") || "";
  const token = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${SESSION_COOKIE_NAME}=`))
    ?.split("=")
    .slice(1)
    .join("=");

  return verifySessionToken(token);
}

export function requireSessionUser(request: Request | NextRequest): SessionUser {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    throw new Error("UNAUTHORIZED");
  }

  return sessionUser;
}

export function unauthorizedResponse(message = "Nicht angemeldet.") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export function forbiddenResponse(message = "Keine Berechtigung.") {
  return NextResponse.json({ error: message }, { status: 403 });
}
