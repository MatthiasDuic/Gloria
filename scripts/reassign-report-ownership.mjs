#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

function loadEnvLocal() {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function createClient(databaseUrl) {
  return new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("render.com") || databaseUrl.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });
}

async function main() {
  loadEnvLocal();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL ist nicht gesetzt.");
    process.exit(1);
  }

  const client = createClient(databaseUrl);
  await client.connect();

  try {
    await client.query("BEGIN");

    const { rows } = await client.query(`
      SELECT
        r.id AS report_id,
        r.user_id AS report_user_id,
        r.lead_id,
        r.call_sid,
        r.company,
        r.topic,
        l.user_id AS lead_user_id,
        l.list_id,
        l.list_name
      FROM gloria_reports r
      JOIN gloria_leads l ON l.id = r.lead_id
      WHERE l.user_id IS NOT NULL
        AND (r.user_id IS DISTINCT FROM l.user_id)
    `);

    const affectedCallSids = new Set();
    const byTargetUser = new Map();

    for (const row of rows) {
      affectedCallSids.add(row.call_sid);
      const next = byTargetUser.get(row.lead_user_id) || 0;
      byTargetUser.set(row.lead_user_id, next + 1);
      await client.query(
        `UPDATE gloria_reports SET user_id = $1, updated_at = NOW() WHERE id = $2`,
        [row.lead_user_id, row.report_id],
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

    const updatedTranscript = await client.query(`
      UPDATE call_transcript_events cte
      SET user_id = l.user_id
      FROM gloria_reports r
      JOIN gloria_leads l ON l.id = r.lead_id
      WHERE cte.call_sid = r.call_sid
        AND l.user_id IS NOT NULL
        AND cte.user_id IS DISTINCT FROM l.user_id
      RETURNING cte.call_sid, cte.user_id;
    `);

    await client.query("COMMIT");

    console.log(JSON.stringify({
      updatedReports: rows.length,
      updatedReportsByUser: Object.fromEntries(byTargetUser.entries()),
      affectedCallSids: affectedCallSids.size,
      updatedTranscriptEvents: updatedTranscript.rowCount,
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});