import { NextResponse } from "next/server";
import { verifyCalendarFeedToken } from "@/lib/calendar-feed";
import { getDashboardData } from "@/lib/storage";
import { findUserById } from "@/lib/report-db";

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
  const callbackKeys = new Set<string>();

  const addEvent = (event: {
    id: string;
    startAt: string;
    durationMinutes: number;
    title: string;
    category: "Termin" | "Wiedervorlage";
    color: string;
    description: string;
  }) => {
    const start = new Date(event.startAt);
    if (Number.isNaN(start.getTime())) return;
    const end = new Date(start.getTime() + event.durationMinutes * 60 * 1000);
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

  for (const report of dashboard.reports) {
    if (report.outcome === "Termin" && report.appointmentAt) {
      addEvent({
        id: report.id || report.callSid || report.appointmentAt,
        startAt: report.appointmentAt,
        durationMinutes: 90,
        title: `Termin: ${report.company} (${report.topic})`,
        category: "Termin",
        color: "#2563EB",
        description: [
          `Thema: ${report.topic}`,
          `Firma: ${report.company}`,
          `Ansprechpartner: ${report.contactName || "-"}`,
          "",
          "Gespraechsnotiz (Gloria):",
          report.summary || "-",
        ].join("\n"),
      });
    }

    if (report.outcome === "Wiedervorlage" && report.nextCallAt) {
      if (report.leadId) callbackKeys.add(`${report.leadId}:${report.nextCallAt}`);
      addEvent({
        id: report.id || report.callSid || report.nextCallAt,
        startAt: report.nextCallAt,
        durationMinutes: 15,
        title: `Wiedervorlage: ${report.company}`,
        category: "Wiedervorlage",
        color: "#D97706",
        description: [
          `Thema: ${report.topic}`,
          `Firma: ${report.company}`,
          `Ansprechpartner: ${report.contactName || "-"}`,
          "",
          "Wiedervorlage / geplanter Rückruf",
          report.summary || "-",
        ].join("\n"),
      });
    }
  }

  for (const lead of dashboard.leads) {
    if (lead.status !== "wiedervorlage" || !lead.nextCallAt) continue;
    if (callbackKeys.has(`${lead.id}:${lead.nextCallAt}`)) continue;

    addEvent({
      id: `callback-${lead.id}`,
      startAt: lead.nextCallAt,
      durationMinutes: 15,
      title: `Wiedervorlage: ${lead.company}`,
      category: "Wiedervorlage",
      color: "#D97706",
      description: [
        `Thema: ${lead.topic}`,
        `Firma: ${lead.company}`,
        `Ansprechpartner: ${lead.contactName || "-"}`,
        "",
        "Wiedervorlage / geplanter Rückruf",
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
