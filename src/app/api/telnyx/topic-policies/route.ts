import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { readScriptsFromPostgres } from "@/lib/report-db";

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
  const expected =
    process.env.APP_INTERNAL_TOKEN?.trim() ||
    process.env.CALL_STATE_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();

  if (!token || !expected) {
    return false;
  }

  return token === expected;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("scope") === "global") {
      const sessionUser = getSessionUserFromRequest(request);
      if (sessionUser?.role !== "master") return NextResponse.json({ error: "Nicht autorisiert." }, { status: 403 });
      const policies = await readScriptsFromPostgres();
      if (policies === null) return NextResponse.json({ error: "Gespeicherte Leitfäden sind nicht verfügbar." }, { status: 503 });
      return NextResponse.json({ topicPolicies: policies, topicPoliciesStorageMode: "postgres" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!isInternalAuthorized(request) && !isInternalTokenAuthorized(request)) {
      return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
    }

    const userId = url.searchParams.get("userId")?.trim() || undefined;
    const data = await getDashboardData({ userId, role: userId ? "user" : "master" });
    return NextResponse.json(
      {
        topicPolicies: data.topicPolicies,
        topicPoliciesStorageMode: data.topicPoliciesStorageMode,
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
            : "Topic Policies konnten nicht geladen werden.",
      },
      { status: 500 },
    );
  }
}
