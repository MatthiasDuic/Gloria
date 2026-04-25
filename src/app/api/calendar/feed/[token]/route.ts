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
  const calendarName = `Gloria Termine – ${user?.realName || user?.companyName || user?.username || "User"}`;

  const events: string[] = [];

  for (const report of dashboard.reports) {
    if (report.outcome !== "Termin" || !report.appointmentAt) continue;

    const start = new Date(report.appointmentAt);
    if (Number.isNaN(start.getTime())) continue;

    const end = new Date(start.getTime() + 90 * 60 * 1000);
    const uid = `${report.id || report.callSid || start.getTime()}@gloria-ki-assistent`;

    const description = escapeIcs(
      [
        `Thema: ${report.topic}`,
        `Firma: ${report.company}`,
        `Ansprechpartner: ${report.contactName || "-"}`,
        "",
        "Gespraechsnotiz (Gloria):",
        report.summary || "-",
      ].join("\n"),
    );

    events.push(
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${formatIcsDate(now)}`,
        `DTSTART:${formatIcsDate(start)}`,
        `DTEND:${formatIcsDate(end)}`,
        `SUMMARY:${escapeIcs(`Termin: ${report.company} (${report.topic})`)}`,
        `DESCRIPTION:${description}`,
        "STATUS:CONFIRMED",
        "SEQUENCE:0",
        "END:VEVENT",
      ].join("\r\n"),
    );
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
