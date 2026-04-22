import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";

export const runtime = "nodejs";

function isInternalAuthorized(request: Request): boolean {
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();

  if (!username || !password) {
    return false;
  }

  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    return false;
  }

  try {
    const decoded = atob(auth.slice(6));
    return decoded === `${username}:${password}`;
  } catch {
    return false;
  }
}

function isInternalTokenAuthorized(request: Request): boolean {
  const token = request.headers.get("x-gloria-internal-token")?.trim();
  const expected = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!token || !expected) {
    return false;
  }

  return token === expected;
}

export async function GET(request: Request) {
  try {
    if (!isInternalAuthorized(request) && !isInternalTokenAuthorized(request)) {
      return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get("userId")?.trim() || undefined;
    const data = await getDashboardData({ userId, role: userId ? "user" : "master" });
    return NextResponse.json(
      {
        playbooks: data.playbooks,
        playbooksStorageMode: data.playbooksStorageMode,
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Playbooks konnten nicht geladen werden.",
      },
      { status: 500 },
    );
  }
}
