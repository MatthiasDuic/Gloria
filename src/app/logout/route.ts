import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const response = NextResponse.redirect("https://gloria.agentur-duic-sprockhoevel.de/", {
    headers: {
      "Cache-Control": "no-store",
    },
  });

  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return response;
}
