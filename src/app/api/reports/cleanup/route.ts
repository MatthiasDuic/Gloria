import { NextResponse } from "next/server";
import { deleteReportsOlderThan } from "@/lib/storage";

export const runtime = "nodejs";

const DEFAULT_RETENTION_DAYS = 30;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();

  // Ohne CRON_SECRET ist der Endpunkt intern offen, damit Vercel-Crons auch
  // ohne Extra-Konfiguration funktionieren. In der Praxis sollte CRON_SECRET
  // gesetzt sein – Vercel-Crons senden den passenden Authorization-Header.
  if (!expected) {
    return true;
  }

  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function resolveRetentionDays(request: Request): number {
  const url = new URL(request.url);
  const fromQuery = Number.parseInt(url.searchParams.get("days") || "", 10);
  if (Number.isFinite(fromQuery) && fromQuery >= 1) {
    return Math.min(365, Math.floor(fromQuery));
  }

  const fromEnv = Number.parseInt(process.env.REPORT_RETENTION_DAYS || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv >= 1) {
    return Math.min(365, Math.floor(fromEnv));
  }

  return DEFAULT_RETENTION_DAYS;
}

async function run(request: Request): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = resolveRetentionDays(request);
  const result = await deleteReportsOlderThan(days);

  return NextResponse.json({
    ok: true,
    retentionDays: days,
    deletedReports: result.deletedReports,
    deletedRecordings: result.deletedRecordings,
  });
}

export async function GET(request: Request) {
  return run(request);
}

export async function POST(request: Request) {
  return run(request);
}
