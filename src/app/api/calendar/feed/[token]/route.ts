import { NextResponse } from "next/server";
import { verifyCalendarFeedToken } from "@/lib/calendar-feed";
import { getDashboardData } from "@/lib/storage";
import { findUserById } from "@/lib/report-db";
import { buildUnifiedCalendarEntries } from "@/lib/crm-helpers";
import { getCalendarEntryColor } from "@/lib/calendar-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function formatIcsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const userId = verifyCalendarFeedToken(token);

  if (!userId) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const user = await findUserById(userId);
  // Kalender ist immer user-scoped, auch fuer Master.
  const dashboard = await getDashboardData({
    userId,
    role: "user",
  });

  const now = new Date();
  const calendarName = `Gloria Termine und Wiedervorlagen – ${user?.realName || user?.companyName || user?.username || "User"}`;

  const events: string[] = [];

  const addEvent = (event: {
    id: string;
    startAt: string;
    durationMinutes: number;
    endAt?: string;
    title: string;
    category: "Termin" | "Wiedervorlage" | "Sperrzeit";
    color: string;
    description: string;
  }) => {
    const start = new Date(event.startAt);
    if (Number.isNaN(start.getTime())) return;
    const end = event.endAt ? new Date(event.endAt) : new Date(start.getTime() + event.durationMinutes * 60 * 1000);
    events.push(
      [
        "BEGIN:VEVENT",
        `UID:${event.id}@gloria-ki-assistent`,
        `DTSTAMP:${formatIcsDate(now)}`,
        `DTSTART:${formatIcsDate(start)}`,
        `DTEND:${formatIcsDate(end)}`,
        `SUMMARY:${escapeIcs(event.title)}`,
        `DESCRIPTION:${escapeIcs(event.description)}`,
        `CATEGORIES:${event.category}`,
        `COLOR:${event.color}`,
        "STATUS:CONFIRMED",
        "SEQUENCE:0",
        "END:VEVENT",
      ].join("\r\n"),
    );
  };

  for (const entry of buildUnifiedCalendarEntries(dashboard, userId)) {
    const appointment = entry.kind === "appointment";
    addEvent({
      id: entry.id,
      startAt: entry.at,
      endAt: entry.endAt,
      durationMinutes: appointment ? 90 : 15,
      title: entry.kind === "block" ? `Sperrzeit: ${entry.company}` : appointment ? `Termin: ${entry.company} (${entry.topic})` : `Wiedervorlage: ${entry.company}`,
      category: entry.kind === "block" ? "Sperrzeit" : appointment ? "Termin" : "Wiedervorlage",
      color: getCalendarEntryColor(entry),
      description: [
        `Thema: ${entry.topic}`,
        `Quelle: ${entry.kind === "block" ? "Eigene Sperrzeit" : entry.callSource === "manual" ? "Analoge Termine" : "CRM"}`,
        `Kontakt: ${entry.company}`,
        `Ansprechpartner: ${entry.contactName || "-"}`,
        "",
        entry.calendarEventId ? "Notiz:" : appointment ? "Gespraechsnotiz (Gloria):" : "Wiedervorlage / geplanter Rückruf",
        entry.summary || "-",
      ].join("\n"),
    });
  }

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gloria KI Assistent//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
    "X-WR-TIMEZONE:Europe/Berlin",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");

  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="gloria-termine.ics"',
      "Cache-Control": "public, max-age=300",
    },
  });
}
