import { Pool } from "pg";
import { TOPICS } from "./types";
import type { CallReport, ConversationEvent, ReportOutcome, Topic } from "./types";

export interface RecordingEntry {
  id: string;
  callSid: string;
  company: string;
  contactName?: string;
  topic: Topic;
  recordingUrl: string;
  createdAt: string;
}

export interface ReportDatabase {
  reports: CallReport[];
  recordings: RecordingEntry[];
}

let pool: Pool | null = null;
let schemaReady = false;

function getDatabaseUrl() {
  return process.env.DATABASE_URL?.trim() || "";
}

function shouldUsePostgres() {
  return Boolean(getDatabaseUrl());
}

function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = getDatabaseUrl();

  if (!connectionString) {
    throw new Error("DATABASE_URL is not configured.");
  }

  pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  });

  return pool;
}

function normalizeTopic(value: string): Topic {
  const topic = TOPICS.find((entry) => entry === value);
  return topic || TOPICS[0];
}

function normalizeOutcome(value: string): ReportOutcome {
  if (value === "Termin" || value === "Absage" || value === "Wiedervorlage") {
    return value;
  }

  return "Kein Kontakt";
}

function toIso(value?: string | Date | null) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

async function ensureSchema() {
  if (schemaReady || !shouldUsePostgres()) {
    return;
  }

  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_reports (
      id TEXT PRIMARY KEY,
      call_sid TEXT,
      lead_id TEXT,
      company TEXT NOT NULL,
      contact_name TEXT,
      topic TEXT NOT NULL,
      summary TEXT NOT NULL,
      outcome TEXT NOT NULL,
      conversation_date TIMESTAMPTZ NOT NULL,
      appointment_at TIMESTAMPTZ,
      next_call_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL,
      recording_consent BOOLEAN NOT NULL,
      recording_url TEXT,
      emailed_to TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS gloria_reports_call_sid_idx
    ON gloria_reports (call_sid);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_recordings (
      id TEXT PRIMARY KEY,
      call_sid TEXT NOT NULL,
      company TEXT NOT NULL,
      contact_name TEXT,
      topic TEXT NOT NULL,
      recording_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS gloria_recordings_call_sid_idx
    ON gloria_recordings (call_sid);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_conversation_events (
      id TEXT PRIMARY KEY,
      call_sid TEXT,
      topic TEXT NOT NULL,
      company TEXT NOT NULL,
      step TEXT NOT NULL,
      event_type TEXT NOT NULL,
      contact_role TEXT,
      turn INTEGER,
      text_value TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS gloria_conversation_events_call_sid_idx
    ON gloria_conversation_events (call_sid);
  `);

  schemaReady = true;
}

export async function readReportDatabaseFromPostgres(): Promise<ReportDatabase | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();

    const db = getPool();
    const reportsResult = await db.query(`
      SELECT
        id,
        call_sid,
        lead_id,
        company,
        contact_name,
        topic,
        summary,
        outcome,
        conversation_date,
        appointment_at,
        next_call_at,
        attempts,
        recording_consent,
        recording_url,
        emailed_to
      FROM gloria_reports
      ORDER BY conversation_date DESC;
    `);

    const recordingsResult = await db.query(`
      SELECT id, call_sid, company, contact_name, topic, recording_url, created_at
      FROM gloria_recordings
      ORDER BY created_at DESC;
    `);

    const reports: CallReport[] = reportsResult.rows.map((row) => ({
      id: String(row.id),
      callSid: row.call_sid ? String(row.call_sid) : undefined,
      leadId: row.lead_id ? String(row.lead_id) : undefined,
      company: String(row.company),
      contactName: row.contact_name ? String(row.contact_name) : undefined,
      topic: normalizeTopic(String(row.topic)),
      summary: String(row.summary || ""),
      outcome: normalizeOutcome(String(row.outcome)),
      conversationDate: toIso(row.conversation_date) || new Date().toISOString(),
      appointmentAt: toIso(row.appointment_at),
      nextCallAt: toIso(row.next_call_at),
      attempts: Number(row.attempts || 1),
      recordingConsent: Boolean(row.recording_consent),
      recordingUrl: row.recording_url ? String(row.recording_url) : undefined,
      emailedTo: String(row.emailed_to || process.env.REPORT_TO_EMAIL || ""),
    }));

    const recordings: RecordingEntry[] = recordingsResult.rows.map((row) => ({
      id: String(row.id),
      callSid: String(row.call_sid),
      company: String(row.company),
      contactName: row.contact_name ? String(row.contact_name) : undefined,
      topic: normalizeTopic(String(row.topic)),
      recordingUrl: String(row.recording_url),
      createdAt: toIso(row.created_at) || new Date().toISOString(),
    }));

    return { reports, recordings };
  } catch (error) {
    console.error("Postgres read failed, fallback to file storage", error);
    return null;
  }
}

export async function writeReportDatabaseToPostgres(data: ReportDatabase): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      for (const report of data.reports) {
        await client.query(
          `
          INSERT INTO gloria_reports (
            id,
            call_sid,
            lead_id,
            company,
            contact_name,
            topic,
            summary,
            outcome,
            conversation_date,
            appointment_at,
            next_call_at,
            attempts,
            recording_consent,
            recording_url,
            emailed_to,
            updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
          )
          ON CONFLICT (id)
          DO UPDATE SET
            call_sid = EXCLUDED.call_sid,
            lead_id = EXCLUDED.lead_id,
            company = EXCLUDED.company,
            contact_name = EXCLUDED.contact_name,
            topic = EXCLUDED.topic,
            summary = EXCLUDED.summary,
            outcome = EXCLUDED.outcome,
            conversation_date = EXCLUDED.conversation_date,
            appointment_at = EXCLUDED.appointment_at,
            next_call_at = EXCLUDED.next_call_at,
            attempts = EXCLUDED.attempts,
            recording_consent = EXCLUDED.recording_consent,
            recording_url = EXCLUDED.recording_url,
            emailed_to = EXCLUDED.emailed_to,
            updated_at = NOW();
          `,
          [
            report.id,
            report.callSid || null,
            report.leadId || null,
            report.company,
            report.contactName || null,
            report.topic,
            report.summary,
            report.outcome,
            report.conversationDate,
            report.appointmentAt || null,
            report.nextCallAt || null,
            report.attempts,
            report.recordingConsent,
            report.recordingUrl || null,
            report.emailedTo,
          ],
        );
      }

      for (const recording of data.recordings) {
        await client.query(
          `
          INSERT INTO gloria_recordings (
            id,
            call_sid,
            company,
            contact_name,
            topic,
            recording_url,
            created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id)
          DO UPDATE SET
            call_sid = EXCLUDED.call_sid,
            company = EXCLUDED.company,
            contact_name = EXCLUDED.contact_name,
            topic = EXCLUDED.topic,
            recording_url = EXCLUDED.recording_url,
            created_at = EXCLUDED.created_at;
          `,
          [
            recording.id,
            recording.callSid,
            recording.company,
            recording.contactName || null,
            recording.topic,
            recording.recordingUrl,
            recording.createdAt,
          ],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return true;
  } catch (error) {
    console.error("Postgres write failed, fallback to file storage", error);
    return false;
  }
}

export async function deleteReportFromPostgres(reportId: string): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();

    const result = await db.query(
      `SELECT call_sid FROM gloria_reports WHERE id = $1`,
      [reportId],
    );
    const callSid = result.rows[0]?.call_sid as string | undefined;

    await db.query(`DELETE FROM gloria_reports WHERE id = $1`, [reportId]);

    if (callSid) {
      await db.query(`DELETE FROM gloria_recordings WHERE call_sid = $1`, [callSid]);
    }

    return true;
  } catch (error) {
    console.error("Postgres delete report failed", error);
    return false;
  }
}

export async function clearReportRecordingInPostgres(reportId: string): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();

    // Get callSid before clearing, so we can delete from recordings table too
    const result = await db.query(
      `SELECT call_sid FROM gloria_reports WHERE id = $1`,
      [reportId],
    );
    const callSid = result.rows[0]?.call_sid as string | undefined;

    await db.query(
      `UPDATE gloria_reports SET recording_url = NULL, updated_at = NOW() WHERE id = $1`,
      [reportId],
    );

    if (callSid) {
      await db.query(`DELETE FROM gloria_recordings WHERE call_sid = $1`, [callSid]);
    }

    return true;
  } catch (error) {
    console.error("Postgres clear recording failed", error);
    return false;
  }
}

export async function readConversationEventsFromPostgres(): Promise<ConversationEvent[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(`
      SELECT id, call_sid, topic, company, step, event_type, contact_role, turn, text_value, created_at
      FROM gloria_conversation_events
      ORDER BY created_at DESC
      LIMIT 5000;
    `);

    return result.rows.map((row) => ({
      id: String(row.id),
      callSid: row.call_sid ? String(row.call_sid) : undefined,
      topic: normalizeTopic(String(row.topic)),
      company: String(row.company),
      step: String(row.step),
      eventType: String(row.event_type),
      contactRole:
        row.contact_role === "gatekeeper" || row.contact_role === "decision-maker"
          ? row.contact_role
          : undefined,
      turn: typeof row.turn === "number" ? row.turn : undefined,
      text: row.text_value ? String(row.text_value) : undefined,
      createdAt: toIso(row.created_at) || new Date().toISOString(),
    }));
  } catch (error) {
    console.error("Postgres event read failed, fallback to file storage", error);
    return null;
  }
}

export async function appendConversationEventToPostgres(
  event: ConversationEvent,
): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO gloria_conversation_events (
        id,
        call_sid,
        topic,
        company,
        step,
        event_type,
        contact_role,
        turn,
        text_value,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO NOTHING;
      `,
      [
        event.id,
        event.callSid || null,
        event.topic,
        event.company,
        event.step,
        event.eventType,
        event.contactRole || null,
        event.turn ?? null,
        event.text || null,
        event.createdAt,
      ],
    );

    return true;
  } catch (error) {
    console.error("Postgres event write failed, fallback to file storage", error);
    return false;
  }
}