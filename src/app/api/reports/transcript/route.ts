import { NextResponse, type NextRequest } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getConversationEventsForCallSid, getDashboardData } from "@/lib/storage";
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
  if (events.length > 0) {
    return NextResponse.json({ ok: true, events, source: "transcript_events" });
  }

  const conversationEvents = await getConversationEventsForCallSid(callSid, {
    userId: sessionUser.role === "master" ? undefined : sessionUser.id,
  });

  const fallbackEvents = conversationEvents
    .filter((event) => {
      if (!event.text?.trim()) {
        return false;
      }
      const eventType = (event.eventType || "").toLowerCase();
      return eventType.includes("utterance")
        || eventType.includes("realtime.user_said")
        || eventType.includes("realtime.gloria_said");
    })
    .map((event) => {
      const normalizedType = (event.eventType || "").toLowerCase();
      const speaker: "Gloria" | "Interessent" =
        normalizedType.includes("gloria") || normalizedType.includes("assistant")
          ? "Gloria"
          : "Interessent";
      return {
        id: `conv-${event.id}`,
        callSid,
        userId: sessionUser.role === "master" ? undefined : sessionUser.id,
        speaker,
        text: event.text?.trim() || "",
        phase: event.step,
        createdAt: event.createdAt,
      };
    });

  return NextResponse.json({ ok: true, events: fallbackEvents, source: "conversation_events" });
}
