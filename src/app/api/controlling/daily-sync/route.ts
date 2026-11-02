import { NextResponse } from "next/server";
import { aggregateDailyGloriaControlling, formatDailyGloriaControllingNote, getBerlinDateAndHour } from "@/lib/daily-controlling";
import { getDashboardData } from "@/lib/storage";
import { getUserCrmConnection, listUsers } from "@/lib/report-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request, secret: string): boolean {
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET ist nicht konfiguriert." }, { status: 503 });
  }
  if (!isAuthorized(request, cronSecret)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  const localTime = getBerlinDateAndHour(new Date());
  if (localTime.hour !== 19) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "outside_19_00_berlin",
      berlinDate: localTime.date,
      berlinHour: localTime.hour,
    });
  }

  const integrationToken = process.env.GLORIA_CRM_INTEGRATION_TOKEN?.trim();
  if (!integrationToken) {
    return NextResponse.json({ error: "GLORIA_CRM_INTEGRATION_TOKEN ist nicht konfiguriert." }, { status: 503 });
  }

  const users = await listUsers();
  let processed = 0;
  let skipped = 0;
  const failures: Array<{ userId: string; error: string }> = [];

  for (const user of users) {
    const connection = await getUserCrmConnection(user.id);
    if (!connection?.apiUrl || !connection.crmUserId) {
      skipped += 1;
      continue;
    }

    try {
      const dashboard = await getDashboardData({ userId: user.id, role: "user" });
      const metrics = aggregateDailyGloriaControlling(dashboard, localTime.date);
      const response = await fetch(`${connection.apiUrl.replace(/\/+$/, "")}/integrations/gloria/sync-controlling`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gloria-integration-token": integrationToken,
        },
        body: JSON.stringify({
          crm_user_id: connection.crmUserId,
          gloria_user_id: user.id,
          date: localTime.date,
          ...metrics,
          notes: formatDailyGloriaControllingNote(localTime.date, metrics),
        }),
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({})) as { detail?: string; error?: string };
      if (!response.ok) {
        throw new Error(result.detail || result.error || `CRM-Abgleich fehlgeschlagen (HTTP ${response.status}).`);
      }
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Tägliches Gloria-Controlling konnte nicht übertragen werden.", {
        userId: user.id,
        crmUserId: connection.crmUserId,
        error: message,
      });
      failures.push({ userId: user.id, error: message });
    }
  }

  if (failures.length > 0) {
    return NextResponse.json({ ok: false, date: localTime.date, processed, skipped, failures }, { status: 502 });
  }
  return NextResponse.json({ ok: true, date: localTime.date, processed, skipped });
}
