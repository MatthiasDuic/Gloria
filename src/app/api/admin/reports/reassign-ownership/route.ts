import { NextResponse } from "next/server";
import pg from "pg";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();

  if (!expected) {
    return true;
  }

  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function createClient() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL ist nicht gesetzt.");
  }

  return new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("render.com") || databaseUrl.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = createClient();
  await client.connect();

  try {
    await client.query("BEGIN");

    const reportsResult = await client.query(`
      SELECT
        r.id AS report_id,
        r.call_sid,
        r.user_id AS report_user_id,
        l.user_id AS lead_user_id
      FROM gloria_reports r
      JOIN gloria_leads l ON l.id = r.lead_id
      WHERE l.user_id IS NOT NULL
        AND r.user_id IS DISTINCT FROM l.user_id
    `);

    const affectedCallSids = new Set<string>();
    const byTargetUser = new Map<string, number>();

    for (const row of reportsResult.rows) {
      const targetUserId = String(row.lead_user_id);
      affectedCallSids.add(String(row.call_sid || ""));
      byTargetUser.set(targetUserId, (byTargetUser.get(targetUserId) || 0) + 1);

      await client.query(
        `UPDATE gloria_reports SET user_id = $1, updated_at = NOW() WHERE id = $2`,
        [targetUserId, String(row.report_id)],
      );
    }

    await client.query(`
      UPDATE gloria_conversation_events gce
      SET user_id = l.user_id
      FROM gloria_reports r
      JOIN gloria_leads l ON l.id = r.lead_id
      WHERE gce.call_sid = r.call_sid
        AND l.user_id IS NOT NULL
        AND gce.user_id IS DISTINCT FROM l.user_id;
    `);

    const transcriptUpdate = await client.query(`
      UPDATE call_transcript_events cte
      SET user_id = l.user_id
      FROM gloria_reports r
      JOIN gloria_leads l ON l.id = r.lead_id
      WHERE cte.call_sid = r.call_sid
        AND l.user_id IS NOT NULL
        AND cte.user_id IS DISTINCT FROM l.user_id;
    `);

    await client.query("COMMIT");

    return NextResponse.json({
      ok: true,
      updatedReports: reportsResult.rowCount,
      updatedReportsByUser: Object.fromEntries(byTargetUser.entries()),
      affectedCallSids: [...affectedCallSids].filter(Boolean).length,
      updatedTranscriptEvents: transcriptUpdate.rowCount,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Migration fehlgeschlagen." },
      { status: 500 },
    );
  } finally {
    await client.end();
  }
}