#!/usr/bin/env node
// Migration: Füllt proofPoints und objectionResponses für PKV-Playbooks in der DB nach, falls leer oder nicht gesetzt.
// Ausführen: node scripts/migrate-fill-pkv-fields.mjs

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

function getDefaults() {
  // Lies die Defaults aus data/playbooks.json (kann alternativ aus sample-data.ts geholt werden)
  const playbooksPath = path.resolve(process.cwd(), "data/playbooks.json");
  const playbooks = JSON.parse(fs.readFileSync(playbooksPath, "utf8"));
  // Akzeptiere beide Varianten: "pkv" oder "private Krankenversicherung"
  const pkv = playbooks.find(pb => pb.topic === "pkv" || pb.topic === "private Krankenversicherung");
  if (!pkv) throw new Error("Kein PKV-Playbook in data/playbooks.json gefunden! (topic: 'pkv' oder 'private Krankenversicherung')");
  return {
    proofPoints: pkv.proofPoints,
    objectionResponses: pkv.objectionResponses,
  };
}

async function main() {
  loadEnvLocal();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error("DATABASE_URL ist nicht gesetzt.");
    process.exit(1);
  }
  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("render.com") || databaseUrl.includes("sslmode=require")
      ? { rejectUnauthorized: false }
      : undefined,
  });
  await client.connect();
  const defaults = getDefaults();
  let updated = 0;
  try {
    // user_playbooks: alle laden, dann im JSON-Feld content prüfen
    const { rows } = await client.query("SELECT id, topic, content FROM user_playbooks");
    for (const row of rows) {
      if (row.topic !== "pkv" && row.topic !== "private Krankenversicherung") continue;
      let changed = false;
      let data;
      try {
        data = JSON.parse(row.content);
      } catch (e) {
        console.error(`user_playbooks id=${row.id} hat ungültiges JSON in content, übersprungen.`);
        continue;
      }
      // Nur leere Felder überschreiben, niemals bestehende Inhalte löschen!
      if (!data.proofPoints || !data.proofPoints.trim()) {
        data.proofPoints = defaults.proofPoints;
        changed = true;
      }
      if (!data.objectionResponses || !data.objectionResponses.trim()) {
        data.objectionResponses = defaults.objectionResponses;
        changed = true;
      }
      if (changed) {
        await client.query(
          "UPDATE user_playbooks SET content = $1, updated_at = NOW() WHERE id = $2",
          [JSON.stringify(data), row.id]
        );
        console.log(`user_playbooks id=${row.id} aktualisiert.`);
        updated++;
      }
    }
    // gloria_playbooks: alle laden, dann im JSON-Feld data.topic prüfen
    // Hole ctid als Zeilen-ID, falls kein PK vorhanden
    const { rows: gRows } = await client.query("SELECT topic, data FROM gloria_playbooks");
    for (const row of gRows) {
      const topic = row.topic;
      if (topic !== "pkv" && topic !== "private Krankenversicherung") continue;
      let changed = false;
      let data = row.data;
      if (!data.proofPoints || !data.proofPoints.trim()) {
        data.proofPoints = defaults.proofPoints;
        changed = true;
      }
      if (!data.objectionResponses || !data.objectionResponses.trim()) {
        data.objectionResponses = defaults.objectionResponses;
        changed = true;
      }
      if (changed) {
        await client.query(
          "UPDATE gloria_playbooks SET data = $1, updated_at = NOW() WHERE topic = $2",
          [JSON.stringify(data), topic]
        );
        console.log(`gloria_playbooks topic=${topic} aktualisiert.`);
        updated++;
      }
    }
    if (updated === 0) {
      console.log("Keine Playbooks mussten aktualisiert werden.");
    } else {
      console.log(`${updated} Playbooks aktualisiert.`);
    }
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
