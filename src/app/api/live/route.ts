import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getRecentConversationEvents } from "@/lib/storage";
import type { ConversationEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LiveSession {
  callSid?: string;
  company: string;
  topic: string;
  startedAt: string;
  lastEventAt: string;
  lastStep: string;
  lastEventType: string;
  contactRole?: "gatekeeper" | "decision-maker";
  turns: number;
  events: Array<Pick<ConversationEvent, "eventType" | "step" | "text" | "createdAt" | "contactRole" | "turn">>;
  status: "aktiv" | "beendet";
}

const TERMINAL_EVENTS = new Set([
  "call_completed",
  "call_ended",
  "hangup",
  "appointment_booked",
  "rejection_final",
  "transfer_failed",
]);

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;
  const minutesParam = Number(url.searchParams.get("minutes"));
  const minutes = Number.isFinite(minutesParam) && minutesParam > 0 ? Math.min(minutesParam, 180) : 15;

  const events = await getRecentConversationEvents({
    userId: resolvedUserId,
    minutes,
    limit: 400,
  });

  const grouped = new Map<string, LiveSession>();
  const ordered = [...events].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  for (const event of ordered) {
    const key = event.callSid || `no-sid-${event.company}-${event.topic}`;
    const existing = grouped.get(key);
    const slim = {
      eventType: event.eventType,
      step: event.step,
      text: event.text,
      createdAt: event.createdAt,
      contactRole: event.contactRole,
      turn: event.turn,
    };
    if (!existing) {
      grouped.set(key, {
        callSid: event.callSid,
        company: event.company,
        topic: event.topic,
        startedAt: event.createdAt,
        lastEventAt: event.createdAt,
        lastStep: event.step,
        lastEventType: event.eventType,
        contactRole: event.contactRole,
        turns: typeof event.turn === "number" ? event.turn : 0,
        events: [slim],
        status: TERMINAL_EVENTS.has(event.eventType) ? "beendet" : "aktiv",
      });
      continue;
    }
    existing.lastEventAt = event.createdAt;
    existing.lastStep = event.step;
    existing.lastEventType = event.eventType;
    if (event.contactRole) existing.contactRole = event.contactRole;
    if (typeof event.turn === "number") existing.turns = Math.max(existing.turns, event.turn);
    existing.events.push(slim);
    if (existing.events.length > 40) existing.events = existing.events.slice(-40);
    if (TERMINAL_EVENTS.has(event.eventType)) existing.status = "beendet";
  }

  const sessions = Array.from(grouped.values()).sort(
    (a, b) => Date.parse(b.lastEventAt) - Date.parse(a.lastEventAt),
  );
  const activeCount = sessions.filter((s) => s.status === "aktiv").length;

  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    windowMinutes: minutes,
    activeCount,
    totalSessions: sessions.length,
    sessions,
  });
}
