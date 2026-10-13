import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";
import { buildUnifiedCalendarEntries } from "@/lib/crm-helpers";
import { calendarBusySlots } from "@/lib/calendar-view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isInternalTokenAuthorized(request: Request): boolean {
  const token = request.headers.get("x-gloria-internal-token")?.trim();
  const expected =
    process.env.APP_INTERNAL_TOKEN?.trim() ||
    process.env.CALL_STATE_SECRET?.trim() ||
    process.env.CRON_SECRET?.trim();
  if (!token || !expected) return false;
  return token === expected;
}

/**
 * Liefert aktive und künftige Reservierungen und Sperrzeiten eines Users.
 * Der Worker prüft diese vor dem Anruf und erneut vor der Terminbestätigung.
 */
export async function GET(request: Request) {
  if (!isInternalTokenAuthorized(request)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  const url = new URL(request.url);
  const userId = url.searchParams.get("userId")?.trim();
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  try {
    const data = await getDashboardData({ userId, role: "user" });
    if (process.env.DATABASE_URL && data.reportStorageMode !== "postgres") {
      throw new Error("Terminbestand aus der Datenbank nicht verfügbar.");
    }
    const slots = calendarBusySlots(buildUnifiedCalendarEntries(data, userId));
    return NextResponse.json({ slots }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("calendar/busy failed:", error);
    return NextResponse.json({ error: "Kalenderverfügbarkeit konnte nicht geprüft werden." }, { status: 503 });
  }
}
