import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATH_PREFIXES = ["/_next", "/api/twilio", "/api/calls/webhook", "/api/health"];
const PUBLIC_PATHS = ["/favicon.ico"];

function isPublicPath(pathname: string) {
  return (
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

function buildUnauthorizedResponse() {
  return new NextResponse("Anmeldung erforderlich.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Gloria Admin", charset="UTF-8"',
      "Cache-Control": "no-store",
    },
  });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();

  if (!username || !password) {
    if (process.env.NODE_ENV === "development") {
      return NextResponse.next();
    }

    return new NextResponse(
      "Admin-Zugang noch nicht konfiguriert. Bitte BASIC_AUTH_USERNAME und BASIC_AUTH_PASSWORD setzen.",
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const authorization = request.headers.get("authorization");

  if (!authorization?.startsWith("Basic ")) {
    return buildUnauthorizedResponse();
  }

  try {
    const base64 = authorization.split(" ")[1] || "";
    const [providedUser = "", ...passwordParts] = atob(base64).split(":");
    const providedPassword = passwordParts.join(":");

    if (providedUser === username && providedPassword === password) {
      return NextResponse.next();
    }
  } catch {
    return buildUnauthorizedResponse();
  }

  return buildUnauthorizedResponse();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
