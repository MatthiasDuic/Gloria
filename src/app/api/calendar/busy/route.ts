import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isInternalTokenAuthorized(request: Request): boolean {
  const token = request.headers.get("x-gloria-internal-token")?.trim();
  const expected = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!token || !expected) return false;
  return token === expected;
}

/**
 * Liefert die noch nicht stattgefundenen Termine eines Users als
 * 90-Min-Slots in UTC-ISO. Wird vom Worker zur Doppelbelegungs-Vermeidung
 * vor jedem Call abgefragt.
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

  const data = await getDashboardData({ userId, role: "user" });
  const now = Date.now();
  const slots: Array<{ start: string; end: string }> = [];

  for (const r of data.reports) {
    if (r.outcome !== "Termin" || !r.appointmentAt) continue;
    const start = new Date(r.appointmentAt);
    if (Number.isNaN(start.getTime())) continue;
    if (start.getTime() < now) continue; // nur künftige
    const end = new Date(start.getTime() + 90 * 60 * 1000);
    slots.push({ start: start.toISOString(), end: end.toISOString() });
  }

  slots.sort((a, b) => a.start.localeCompare(b.start));

  return NextResponse.json({ slots }, {
    headers: { "Cache-Control": "no-store" },
  });
}
