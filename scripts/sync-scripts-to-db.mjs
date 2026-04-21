#!/usr/bin/env node
// Einmaliges Sync-Tool: Liest data/scripts.json und schreibt sie in Postgres (gloria_scripts).
// Optional mit --include-users werden auch die benutzerspezifischen scripts-Zeilen
// auf den Default-Inhalt zurueckgesetzt (pro Topic).
//
// Ausfuehren: node scripts/sync-scripts-to-db.mjs [--include-users]

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

async function main() {
  loadEnvLocal();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL ist nicht gesetzt.");
    process.exit(1);
  }

  const scriptsPath = path.resolve(process.cwd(), "data/scripts.json");
  const scripts = JSON.parse(fs.readFileSync(scriptsPath, "utf8"));
  if (!Array.isArray(scripts) || scripts.length === 0) {
    console.error("data/scripts.json enthaelt keine Skripte.");
    process.exit(1);
  }

  const includeUsers = process.argv.includes("--include-users");

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("render.com") || databaseUrl.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  await client.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS gloria_scripts (
        topic TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const script of scripts) {
      await client.query(
        `
        INSERT INTO gloria_scripts (topic, data, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (topic) DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW();
        `,
        [script.topic, JSON.stringify(script)],
      );
      console.log(`gloria_scripts aktualisiert: ${script.topic}`);
    }

    await client.query(
      `DELETE FROM gloria_scripts WHERE topic <> ALL($1::text[])`,
      [scripts.map((script) => script.topic)],
    );

    if (includeUsers) {
      const userRows = await client.query(`SELECT id FROM users WHERE role = 'user'`);
      for (const row of userRows.rows) {
        for (const script of scripts) {
          await client.query(
            `
            INSERT INTO scripts (id, user_id, topic, content, created_from_default, updated_at)
            VALUES ($1, $2, $3, $4, TRUE, NOW())
            ON CONFLICT (user_id, topic) DO UPDATE SET
              content = EXCLUDED.content,
              created_from_default = TRUE,
              updated_at = NOW();
            `,
            [
              `usr-script-${row.id}-${script.topic}`,
              row.id,
              script.topic,
              JSON.stringify({ ...script, id: `usr-script-${row.id}-${script.topic}` }),
            ],
          );
        }
        console.log(`Benutzer-Skripte zurueckgesetzt: ${row.id}`);
      }
    }

    await client.query("COMMIT");
    console.log("Sync abgeschlossen.");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Sync fehlgeschlagen:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
