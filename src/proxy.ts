import { NextRequest, NextResponse } from "next/server";
import { verifySessionTokenEdge } from "@/lib/session-edge";

const PUBLIC_PATH_PREFIXES = [
  "/_next",
  "/api/twilio",
  "/api/calls/webhook",
  "/api/callbacks/run",
  "/api/reports/cleanup",
  "/api/campaigns/run-active",
  "/api/calendar/feed",
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
];
const PUBLIC_PATHS = ["/favicon.ico", "/logout", "/login"];

function isPublicPath(pathname: string) {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get("gloria_session")?.value;
  const sessionUser = await verifySessionTokenEdge(token);

  if (sessionUser) {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
