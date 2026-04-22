#!/usr/bin/env node
// Einmaliges Sync-Tool: Liest data/playbooks.json und schreibt sie nach Postgres
// (Tabelle `gloria_playbooks`). Mit --include-users werden auch die
// benutzerspezifischen Playbooks (Tabelle `user_playbooks`) auf den Default
// zurueckgesetzt.
//
// Ausfuehren: node scripts/sync-playbooks-to-db.mjs [--include-users]

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

function resolvePlaybooksFile() {
  const preferred = path.resolve(process.cwd(), "data/playbooks.json");
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.resolve(process.cwd(), "data/scripts.json");
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}

async function main() {
  loadEnvLocal();

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL ist nicht gesetzt.");
    process.exit(1);
  }

  const playbooksPath = resolvePlaybooksFile();
  const playbooks = JSON.parse(fs.readFileSync(playbooksPath, "utf8"));
  if (!Array.isArray(playbooks) || playbooks.length === 0) {
    console.error(`${playbooksPath} enthaelt keine Playbooks.`);
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

    // Migration: rename legacy tables if still present.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'scripts')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_playbooks') THEN
          ALTER TABLE scripts RENAME TO user_playbooks;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gloria_scripts')
           AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'gloria_playbooks') THEN
          ALTER TABLE gloria_scripts RENAME TO gloria_playbooks;
        END IF;
      END
      $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS gloria_playbooks (
        topic TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    for (const playbook of playbooks) {
      await client.query(
        `
        INSERT INTO gloria_playbooks (topic, data, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (topic) DO UPDATE SET
          data = EXCLUDED.data,
          updated_at = NOW();
        `,
        [playbook.topic, JSON.stringify(playbook)],
      );
      console.log(`gloria_playbooks aktualisiert: ${playbook.topic}`);
    }

    await client.query(
      `DELETE FROM gloria_playbooks WHERE topic <> ALL($1::text[])`,
      [playbooks.map((playbook) => playbook.topic)],
    );

    if (includeUsers) {
      const userRows = await client.query(`SELECT id FROM users`);
      for (const row of userRows.rows) {
        for (const playbook of playbooks) {
          await client.query(
            `
            INSERT INTO user_playbooks (id, user_id, topic, content, created_from_default, updated_at)
            VALUES ($1, $2, $3, $4, TRUE, NOW())
            ON CONFLICT (user_id, topic) DO UPDATE SET
              content = EXCLUDED.content,
              created_from_default = TRUE,
              updated_at = NOW();
            `,
            [
              `usr-playbook-${row.id}-${playbook.topic}`,
              row.id,
              playbook.topic,
              JSON.stringify({ ...playbook, id: `usr-playbook-${row.id}-${playbook.topic}` }),
            ],
          );
        }
        console.log(`Benutzer-Playbooks zurueckgesetzt: ${row.id}`);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
