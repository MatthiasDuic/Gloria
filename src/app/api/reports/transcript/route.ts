import { NextResponse, type NextRequest } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getDashboardData } from "@/lib/storage";
import { listCallTranscriptEventsFromPostgres } from "@/lib/report-db";

export const runtime = "nodejs";

/**
 * GET /api/reports/transcript?callSid=...
 * Liefert das vollständige Wort-für-Wort-Protokoll zu einem Anruf inkl.
 * Reaktionszeit pro Gloria-Antwort. Auth: nur eingeloggte User. User ohne
 * Admin-Rolle bekommen nur eigene Transkripte.
 */
export async function GET(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const callSid = request.nextUrl.searchParams.get("callSid")?.trim();
  if (!callSid) {
    return NextResponse.json({ error: "missing_callSid" }, { status: 400 });
  }

  // Berechtigungsprüfung: gehört der callSid einem Report dieses Users?
  // (Master-User dürfen alles.)
  if (sessionUser.role !== "master") {
    const ownData = await getDashboardData({ userId: sessionUser.id, role: "user" });
    const owns = ownData.reports.some((r) => r.callSid === callSid);
    if (!owns) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

  const events = await listCallTranscriptEventsFromPostgres(callSid);
  return NextResponse.json({ ok: true, events });
}
