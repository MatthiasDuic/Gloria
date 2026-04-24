import { Pool } from "pg";
import { TOPICS } from "./types";
import type { CallReport, ConversationEvent, Lead, ReportOutcome, ScriptConfig, Topic } from "./types";
import { hashPassword, verifyPassword, type UserRole } from "./session";
import { defaultScripts } from "./sample-data";

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

export interface CampaignListStateRow {
  listId: string;
  listName: string;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastRunAt?: string;
}

export interface AppUser {
  id: string;
  username: string;
  realName: string;
  companyName: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface UserPhoneNumber {
  id: string;
  userId: string;
  phoneNumber: string;
  label: string;
  active: boolean;
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
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_role') THEN
        CREATE TYPE user_role AS ENUM ('master', 'user');
      END IF;
    END$$;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      real_name TEXT NOT NULL,
      company_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role user_role NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS phone_numbers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone_number TEXT NOT NULL,
      label TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS phone_numbers_user_id_idx
    ON phone_numbers (user_id);
  `);

  // --- Migration (Skript → Playbook) ---
  // Rename legacy tables in-place so existing data moves to the new names.
  await db.query(`
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

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_playbooks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      created_from_default BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, topic)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS playbook_revisions (
      id TEXT PRIMARY KEY,
      playbook_id TEXT NOT NULL REFERENCES user_playbooks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS playbook_revisions_playbook_id_idx
    ON playbook_revisions (playbook_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, key)
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS campaigns_user_id_idx
    ON campaigns (user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS campaign_leads (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      company TEXT NOT NULL,
      contact_name TEXT,
      phone TEXT NOT NULL,
      direct_dial TEXT,
      email TEXT,
      topic TEXT NOT NULL,
      note TEXT,
      next_call_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'neu',
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS campaign_leads_campaign_id_idx
    ON campaign_leads (campaign_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS campaign_leads_user_id_idx
    ON campaign_leads (user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS call_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      phone_number_id TEXT REFERENCES phone_numbers(id) ON DELETE SET NULL,
      call_sid TEXT,
      lead_id TEXT,
      company TEXT NOT NULL,
      contact_name TEXT,
      direct_dial TEXT,
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
    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      phone_number_id TEXT REFERENCES phone_numbers(id) ON DELETE SET NULL,
      campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
      lead_id TEXT,
      call_sid TEXT,
      company TEXT,
      topic TEXT,
      outcome TEXT,
      recording_url TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS call_logs_user_id_idx
    ON call_logs (user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS call_transcript_events (
      id TEXT PRIMARY KEY,
      call_sid TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      speaker TEXT NOT NULL,
      text_value TEXT NOT NULL,
      phase TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS call_transcript_events_call_sid_idx
    ON call_transcript_events (call_sid);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS call_transcript_events_user_id_idx
    ON call_transcript_events (user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_reports (
      id TEXT PRIMARY KEY,
      call_sid TEXT,
      lead_id TEXT,
      company TEXT NOT NULL,
      contact_name TEXT,
      direct_dial TEXT,
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
    ALTER TABLE gloria_reports
    ADD COLUMN IF NOT EXISTS direct_dial TEXT;
  `);

  await db.query(`
    ALTER TABLE gloria_reports
    ADD COLUMN IF NOT EXISTS user_id TEXT;
  `);

  await db.query(`
    ALTER TABLE gloria_reports
    ADD COLUMN IF NOT EXISTS phone_number_id TEXT;
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
      user_id TEXT,
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

  await db.query(`
    ALTER TABLE gloria_conversation_events
    ADD COLUMN IF NOT EXISTS user_id TEXT;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS gloria_conversation_events_user_id_idx
    ON gloria_conversation_events (user_id);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_playbooks (
      topic TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_leads (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      list_id TEXT,
      list_name TEXT,
      company TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      direct_dial TEXT,
      email TEXT,
      topic TEXT NOT NULL,
      note TEXT,
      next_call_at TIMESTAMPTZ,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE gloria_leads
    ADD COLUMN IF NOT EXISTS user_id TEXT;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS gloria_leads_status_idx
    ON gloria_leads (status);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS gloria_campaign_lists (
      user_id TEXT,
      list_id TEXT PRIMARY KEY,
      list_name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ,
      stopped_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE gloria_campaign_lists
    ADD COLUMN IF NOT EXISTS user_id TEXT;
  `);

  schemaReady = true;
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function ensureMasterAdmin(): Promise<void> {
  if (!shouldUsePostgres()) {
    return;
  }

  await ensureSchema();
  const db = getPool();
  const username = process.env.BASIC_AUTH_USERNAME?.trim() || "mduic";
  const password = process.env.BASIC_AUTH_PASSWORD?.trim() || "ChangeMe123!";

  const existing = await db.query(
    `SELECT id, username FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`,
    [username],
  );

  if (existing.rows[0]) {
    await db.query(
      `
      UPDATE users
      SET
        username = $2,
        real_name = $3,
        company_name = $4,
        password_hash = $5,
        role = 'master'
      WHERE id = $1
      `,
      [
        String(existing.rows[0].id),
        username,
        "Matthias Duic",
        "Agentur Duic Sprockhoevel",
        hashPassword(password),
      ],
    );
    return;
  }

  await db.query(
    `
    INSERT INTO users (id, username, real_name, company_name, password_hash, role, created_at)
    VALUES ($1,$2,$3,$4,$5,'master',NOW())
    `,
    [
      makeId("usr"),
      username,
      "Matthias Duic",
      "Agentur Duic Sprockhoevel",
      hashPassword(password),
    ],
  );
}

export async function findUserByUsername(username: string): Promise<AppUser | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `
    SELECT id, username, real_name, company_name, password_hash, role, created_at
    FROM users
    WHERE LOWER(username) = LOWER($1)
    LIMIT 1
    `,
    [username],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    username: String(row.username),
    realName: String(row.real_name),
    companyName: String(row.company_name),
    passwordHash: String(row.password_hash),
    role: row.role === "master" ? "master" : "user",
    createdAt: toIso(row.created_at) || new Date().toISOString(),
  };
}

export async function findUserById(userId: string): Promise<AppUser | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `
    SELECT id, username, real_name, company_name, password_hash, role, created_at
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    username: String(row.username),
    realName: String(row.real_name),
    companyName: String(row.company_name),
    passwordHash: String(row.password_hash),
    role: row.role === "master" ? "master" : "user",
    createdAt: toIso(row.created_at) || new Date().toISOString(),
  };
}

export function verifyUserPassword(rawPassword: string, passwordHash: string): boolean {
  return verifyPassword(rawPassword, passwordHash);
}

export async function listUsers(): Promise<AppUser[]> {
  if (!shouldUsePostgres()) {
    return [];
  }

  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `
    SELECT id, username, real_name, company_name, password_hash, role, created_at
    FROM users
    ORDER BY created_at DESC
    `,
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    username: String(row.username),
    realName: String(row.real_name),
    companyName: String(row.company_name),
    passwordHash: String(row.password_hash),
    role: row.role === "master" ? "master" : "user",
    createdAt: toIso(row.created_at) || new Date().toISOString(),
  }));
}

export async function createUser(input: {
  username: string;
  realName: string;
  companyName: string;
  password: string;
  role?: UserRole;
}): Promise<AppUser> {
  await ensureSchema();
  const db = getPool();
  const id = makeId("usr");
  const role = input.role === "master" ? "master" : "user";

  await db.query(
    `
    INSERT INTO users (id, username, real_name, company_name, password_hash, role, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    `,
    [id, input.username, input.realName, input.companyName, hashPassword(input.password), role],
  );

  const created = await findUserByUsername(input.username);

  if (!created) {
    throw new Error("Benutzer konnte nicht erstellt werden.");
  }

  if (created.role === "user") {
    await bootstrapUserScriptsFromDefaults(created.id, defaultScripts);
  }

  return created;
}

export async function updateUser(
  userId: string,
  input: {
    realName?: string;
    companyName?: string;
    password?: string;
    role?: UserRole;
  },
): Promise<void> {
  await ensureSchema();
  const db = getPool();

  if (input.realName) {
    await db.query(`UPDATE users SET real_name = $2 WHERE id = $1`, [userId, input.realName]);
  }
  if (input.companyName) {
    await db.query(`UPDATE users SET company_name = $2 WHERE id = $1`, [userId, input.companyName]);
  }
  if (input.password) {
    await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hashPassword(input.password)]);
  }
  if (input.role) {
    await db.query(`UPDATE users SET role = $2 WHERE id = $1`, [userId, input.role]);
  }
}

export async function deleteUser(userId: string): Promise<void> {
  await ensureSchema();
  const db = getPool();
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
}

export async function listPhoneNumbersByUser(userId: string): Promise<UserPhoneNumber[]> {
  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `
    SELECT id, user_id, phone_number, label, active
    FROM phone_numbers
    WHERE user_id = $1
    ORDER BY created_at DESC
    `,
    [userId],
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    phoneNumber: String(row.phone_number),
    label: String(row.label),
    active: Boolean(row.active),
  }));
}

export async function listAllPhoneNumbers(): Promise<UserPhoneNumber[]> {
  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `SELECT id, user_id, phone_number, label, active FROM phone_numbers ORDER BY created_at DESC`,
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    phoneNumber: String(row.phone_number),
    label: String(row.label),
    active: Boolean(row.active),
  }));
}

export async function createPhoneNumber(input: {
  userId: string;
  phoneNumber: string;
  label: string;
  active?: boolean;
}): Promise<UserPhoneNumber> {
  await ensureSchema();
  const db = getPool();
  const id = makeId("pn");

  await db.query(
    `
    INSERT INTO phone_numbers (id, user_id, phone_number, label, active, created_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    `,
    [id, input.userId, input.phoneNumber, input.label, input.active !== false],
  );

  return {
    id,
    userId: input.userId,
    phoneNumber: input.phoneNumber,
    label: input.label,
    active: input.active !== false,
  };
}

export async function updatePhoneNumber(
  id: string,
  payload: { label?: string; active?: boolean; phoneNumber?: string },
): Promise<void> {
  await ensureSchema();
  const db = getPool();

  if (payload.label !== undefined) {
    await db.query(`UPDATE phone_numbers SET label = $2 WHERE id = $1`, [id, payload.label]);
  }
  if (payload.active !== undefined) {
    await db.query(`UPDATE phone_numbers SET active = $2 WHERE id = $1`, [id, payload.active]);
  }
  if (payload.phoneNumber !== undefined) {
    await db.query(`UPDATE phone_numbers SET phone_number = $2 WHERE id = $1`, [id, payload.phoneNumber]);
  }
}

export async function deletePhoneNumber(id: string): Promise<void> {
  await ensureSchema();
  const db = getPool();
  await db.query(`DELETE FROM phone_numbers WHERE id = $1`, [id]);
}

export async function findPhoneNumberById(id: string): Promise<UserPhoneNumber | null> {
  await ensureSchema();
  const db = getPool();
  const result = await db.query(
    `
    SELECT id, user_id, phone_number, label, active
    FROM phone_numbers
    WHERE id = $1
    LIMIT 1
    `,
    [id],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: String(row.id),
    userId: String(row.user_id),
    phoneNumber: String(row.phone_number),
    label: String(row.label),
    active: Boolean(row.active),
  };
}

export async function readScriptsFromPostgres(): Promise<ScriptConfig[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(`
      SELECT topic, data
      FROM gloria_playbooks
      ORDER BY topic ASC;
    `);

    if (!result.rows.length) {
      return null;
    }

    return result.rows.map((row) => {
      const data = (row.data || {}) as Partial<ScriptConfig>;

      return {
        ...data,
        id: String(data.id || `playbook-${String(row.topic)}`),
        topic: normalizeTopic(String(row.topic)),
        opener: String(data.opener || ""),
        discovery: String(data.discovery || ""),
        objectionHandling: String(data.objectionHandling || ""),
        close: String(data.close || ""),
      } as ScriptConfig;
    });
  } catch (error) {
    console.error("Postgres script read failed, fallback to file storage", error);
    return null;
  }
}

export async function writeScriptsToPostgres(scripts: ScriptConfig[]): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const client = await db.connect();

    try {
      await client.query("BEGIN");

      for (const script of scripts) {
        await client.query(
          `
          INSERT INTO gloria_playbooks (topic, data, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (topic)
          DO UPDATE SET
            data = EXCLUDED.data,
            updated_at = NOW();
          `,
          [script.topic, JSON.stringify(script)],
        );
      }

      await client.query(
        `DELETE FROM gloria_playbooks WHERE topic <> ALL($1::text[])`,
        [scripts.map((script) => script.topic)],
      );

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Postgres script write failed, fallback to file storage", error);
    return false;
  }
}

export async function readReportDatabaseFromPostgres(userId?: string): Promise<ReportDatabase | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();

    const db = getPool();
    const reportsResult = await db.query(`
      SELECT
        id,
        user_id,
        phone_number_id,
        call_sid,
        lead_id,
        company,
        contact_name,
        direct_dial,
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
      ${userId ? "WHERE user_id = $1" : ""}
      ORDER BY conversation_date DESC;
    `, userId ? [userId] : []);

    const recordingsResult = await db.query(
      `
      SELECT r.id, r.call_sid, r.company, r.contact_name, r.topic, r.recording_url, r.created_at
      FROM gloria_recordings r
      ${
        userId
          ? "WHERE EXISTS (SELECT 1 FROM gloria_reports gr WHERE gr.call_sid = r.call_sid AND gr.user_id = $1)"
          : ""
      }
      ORDER BY r.created_at DESC;
      `,
      userId ? [userId] : [],
    );

    const reports: CallReport[] = reportsResult.rows.map((row) => ({
      id: String(row.id),
      userId: row.user_id ? String(row.user_id) : undefined,
      phoneNumberId: row.phone_number_id ? String(row.phone_number_id) : undefined,
      callSid: row.call_sid ? String(row.call_sid) : undefined,
      leadId: row.lead_id ? String(row.lead_id) : undefined,
      company: String(row.company),
      contactName: row.contact_name ? String(row.contact_name) : undefined,
      directDial: row.direct_dial ? String(row.direct_dial) : undefined,
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
            user_id,
            phone_number_id,
            call_sid,
            lead_id,
            company,
            contact_name,
            direct_dial,
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
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW()
          )
          ON CONFLICT (id)
          DO UPDATE SET
            user_id = EXCLUDED.user_id,
            phone_number_id = EXCLUDED.phone_number_id,
            call_sid = EXCLUDED.call_sid,
            lead_id = EXCLUDED.lead_id,
            company = EXCLUDED.company,
            contact_name = EXCLUDED.contact_name,
            direct_dial = EXCLUDED.direct_dial,
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
            report.userId || null,
            report.phoneNumberId || null,
            report.callSid || null,
            report.leadId || null,
            report.company,
            report.contactName || null,
            report.directDial || null,
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

export async function deleteAllReportsFromPostgres(
  options: { userId?: string } = {},
): Promise<{ ok: boolean; deletedReports: number; deletedRecordings: number }> {
  if (!shouldUsePostgres()) {
    return { ok: false, deletedReports: 0, deletedRecordings: 0 };
  }

  try {
    await ensureSchema();
    const db = getPool();

    const callSidsResult = await db.query<{ call_sid: string | null }>(
      options.userId
        ? `SELECT call_sid FROM gloria_reports WHERE user_id = $1 AND call_sid IS NOT NULL`
        : `SELECT call_sid FROM gloria_reports WHERE call_sid IS NOT NULL`,
      options.userId ? [options.userId] : [],
    );
    const callSids = callSidsResult.rows
      .map((row) => row.call_sid)
      .filter((sid): sid is string => Boolean(sid));

    const reportsResult = await db.query(
      options.userId
        ? `DELETE FROM gloria_reports WHERE user_id = $1`
        : `DELETE FROM gloria_reports`,
      options.userId ? [options.userId] : [],
    );

    let deletedRecordings = 0;
    if (callSids.length > 0) {
      const recordingsResult = await db.query(
        `DELETE FROM gloria_recordings WHERE call_sid = ANY($1::text[])`,
        [callSids],
      );
      deletedRecordings = recordingsResult.rowCount || 0;
    }

    return {
      ok: true,
      deletedReports: reportsResult.rowCount || 0,
      deletedRecordings,
    };
  } catch (error) {
    console.error("Postgres bulk delete reports failed", error);
    return { ok: false, deletedReports: 0, deletedRecordings: 0 };
  }
}

export async function deleteReportsOlderThanInPostgres(
  days: number,
): Promise<{ ok: boolean; deletedReports: number; deletedRecordings: number }> {
  if (!shouldUsePostgres()) {
    return { ok: false, deletedReports: 0, deletedRecordings: 0 };
  }

  const safeDays = Math.max(1, Math.floor(days));

  try {
    await ensureSchema();
    const db = getPool();

    const callSidsResult = await db.query<{ call_sid: string | null }>(
      `SELECT call_sid FROM gloria_reports
         WHERE conversation_date < NOW() - ($1::int * INTERVAL '1 day')
           AND call_sid IS NOT NULL`,
      [safeDays],
    );
    const callSids = callSidsResult.rows
      .map((row) => row.call_sid)
      .filter((sid): sid is string => Boolean(sid));

    const reportsResult = await db.query(
      `DELETE FROM gloria_reports
         WHERE conversation_date < NOW() - ($1::int * INTERVAL '1 day')`,
      [safeDays],
    );

    let deletedRecordings = 0;
    if (callSids.length > 0) {
      const recordingsResult = await db.query(
        `DELETE FROM gloria_recordings WHERE call_sid = ANY($1::text[])`,
        [callSids],
      );
      deletedRecordings = recordingsResult.rowCount || 0;
    }

    return {
      ok: true,
      deletedReports: reportsResult.rowCount || 0,
      deletedRecordings,
    };
  } catch (error) {
    console.error("Postgres retention delete failed", error);
    return { ok: false, deletedReports: 0, deletedRecordings: 0 };
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

export async function readConversationEventsFromPostgres(userId?: string): Promise<ConversationEvent[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(`
      SELECT id, call_sid, topic, company, step, event_type, contact_role, turn, text_value, created_at
      FROM gloria_conversation_events
      ${userId ? "WHERE user_id = $1" : ""}
      ORDER BY created_at DESC
      LIMIT 5000;
    `, userId ? [userId] : []);

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
  userId?: string,
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
        user_id,
        call_sid,
        topic,
        company,
        step,
        event_type,
        contact_role,
        turn,
        text_value,
        created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO NOTHING;
      `,
      [
        event.id,
        userId || null,
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

export async function writeScriptToPostgres(script: ScriptConfig): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO gloria_playbooks (topic, data, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (topic)
      DO UPDATE SET
        data = EXCLUDED.data,
        updated_at = NOW();
      `,
      [script.topic, JSON.stringify(script)],
    );
    return true;
  } catch (error) {
    console.error("Postgres single script write failed, fallback to file storage", error);
    return false;
  }
}

export async function readLeadsFromPostgres(userId?: string): Promise<Lead[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(`
      SELECT
        id,
        user_id,
        list_id,
        list_name,
        company,
        contact_name,
        phone,
        direct_dial,
        email,
        topic,
        note,
        next_call_at,
        status,
        attempts
      FROM gloria_leads
      ${userId ? "WHERE user_id = $1" : ""}
      ORDER BY updated_at DESC;
    `, userId ? [userId] : []);

    return result.rows.map((row) => ({
      id: String(row.id),
      userId: row.user_id ? String(row.user_id) : undefined,
      listId: row.list_id ? String(row.list_id) : undefined,
      listName: row.list_name ? String(row.list_name) : undefined,
      company: String(row.company),
      contactName: String(row.contact_name || "Empfang"),
      phone: String(row.phone || ""),
      directDial: row.direct_dial ? String(row.direct_dial) : undefined,
      email: row.email ? String(row.email) : undefined,
      topic: normalizeTopic(String(row.topic)),
      note: row.note ? String(row.note) : undefined,
      nextCallAt: toIso(row.next_call_at),
      status:
        row.status === "neu" ||
        row.status === "angerufen" ||
        row.status === "termin" ||
        row.status === "absage" ||
        row.status === "wiedervorlage"
          ? row.status
          : "neu",
      attempts: Number(row.attempts || 0),
    }));
  } catch (error) {
    console.error("Postgres lead read failed, fallback to file storage", error);
    return null;
  }
}

export async function writeLeadsToPostgres(leads: Lead[], userId?: string): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const client = await db.connect();

    try {
      await client.query("BEGIN");
      if (userId) {
        await client.query("DELETE FROM gloria_leads WHERE user_id = $1", [userId]);
      } else {
        await client.query("DELETE FROM gloria_leads");
      }

      for (const lead of leads) {
        await client.query(
          `
          INSERT INTO gloria_leads (
            id,
            user_id,
            list_id,
            list_name,
            company,
            contact_name,
            phone,
            direct_dial,
            email,
            topic,
            note,
            next_call_at,
            status,
            attempts,
            updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW()
          );
          `,
          [
            lead.id,
            lead.userId || userId || null,
            lead.listId || null,
            lead.listName || null,
            lead.company,
            lead.contactName,
            lead.phone,
            lead.directDial || null,
            lead.email || null,
            lead.topic,
            lead.note || null,
            lead.nextCallAt || null,
            lead.status,
            lead.attempts,
          ],
        );
      }

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Postgres lead write failed, fallback to file storage", error);
    return false;
  }
}

export async function readCampaignListsStateFromPostgres(userId?: string): Promise<CampaignListStateRow[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(`
      SELECT list_id, list_name, active, started_at, stopped_at, last_run_at
      FROM gloria_campaign_lists
      ${userId ? "WHERE user_id = $1" : ""}
      ORDER BY updated_at DESC;
    `, userId ? [userId] : []);

    return result.rows.map((row) => ({
      listId: String(row.list_id),
      listName: String(row.list_name),
      active: Boolean(row.active),
      startedAt: toIso(row.started_at),
      stoppedAt: toIso(row.stopped_at),
      lastRunAt: toIso(row.last_run_at),
    }));
  } catch (error) {
    console.error("Postgres campaign list read failed, fallback to file storage", error);
    return null;
  }
}

export async function writeCampaignListsStateToPostgres(
  lists: CampaignListStateRow[],
  userId?: string,
): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const client = await db.connect();

    try {
      await client.query("BEGIN");
      if (userId) {
        await client.query("DELETE FROM gloria_campaign_lists WHERE user_id = $1", [userId]);
      } else {
        await client.query("DELETE FROM gloria_campaign_lists");
      }

      for (const list of lists) {
        await client.query(
          `
          INSERT INTO gloria_campaign_lists (
            user_id,
            list_id,
            list_name,
            active,
            started_at,
            stopped_at,
            last_run_at,
            updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW());
          `,
          [
            userId || null,
            list.listId,
            list.listName,
            list.active,
            list.startedAt || null,
            list.stoppedAt || null,
            list.lastRunAt || null,
          ],
        );
      }

      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Postgres campaign list write failed, fallback to file storage", error);
    return false;
  }
}

export async function readUserScriptsFromPostgres(userId: string): Promise<ScriptConfig[] | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(
      `
      SELECT topic, content
      FROM user_playbooks
      WHERE user_id = $1
      ORDER BY topic ASC
      `,
      [userId],
    );

    if (!result.rows.length) {
      return null;
    }

    return result.rows.map((row) => {
      const data = JSON.parse(String(row.content || "{}")) as Partial<ScriptConfig>;
      const topic = normalizeTopic(String(row.topic));

      return {
        id: String(data.id || `playbook-${topic}`),
        topic,
        opener: String(data.opener || ""),
        discovery: String(data.discovery || ""),
        objectionHandling: String(data.objectionHandling || ""),
        close: String(data.close || ""),
        aiKeyInfo: typeof data.aiKeyInfo === "string" ? data.aiKeyInfo : undefined,
        consentPrompt: typeof data.consentPrompt === "string" ? data.consentPrompt : undefined,
        pkvHealthIntro: typeof data.pkvHealthIntro === "string" ? data.pkvHealthIntro : undefined,
        pkvHealthQuestions: typeof data.pkvHealthQuestions === "string" ? data.pkvHealthQuestions : undefined,
        gatekeeperTask: typeof data.gatekeeperTask === "string" ? data.gatekeeperTask : undefined,
        gatekeeperBehavior: typeof data.gatekeeperBehavior === "string" ? data.gatekeeperBehavior : undefined,
        decisionMakerTask: typeof data.decisionMakerTask === "string" ? data.decisionMakerTask : undefined,
        decisionMakerBehavior: typeof data.decisionMakerBehavior === "string" ? data.decisionMakerBehavior : undefined,
        decisionMakerContext: typeof data.decisionMakerContext === "string" ? data.decisionMakerContext : undefined,
        appointmentGoal: typeof data.appointmentGoal === "string" ? data.appointmentGoal : undefined,
        receptionTopicReason: typeof data.receptionTopicReason === "string" ? data.receptionTopicReason : undefined,
        problemBuildup: typeof data.problemBuildup === "string" ? data.problemBuildup : undefined,
        conceptTransition: typeof data.conceptTransition === "string" ? data.conceptTransition : undefined,
        appointmentConfirmation:
          typeof data.appointmentConfirmation === "string" ? data.appointmentConfirmation : undefined,
        availableAppointmentSlots:
          typeof data.availableAppointmentSlots === "string" ? data.availableAppointmentSlots : undefined,
      };
    });
  } catch (error) {
    console.error("Postgres user script read failed", error);
    return null;
  }
}

export async function writeUserScriptToPostgres(
  userId: string,
  script: ScriptConfig,
  createdFromDefault = false,
): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO user_playbooks (id, user_id, topic, content, created_from_default, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id, topic)
      DO UPDATE SET
        content = EXCLUDED.content,
        created_from_default = EXCLUDED.created_from_default,
        updated_at = NOW()
      `,
      [
        script.id || makeId("usr-playbook"),
        userId,
        script.topic,
        JSON.stringify(script),
        createdFromDefault,
      ],
    );

    return true;
  } catch (error) {
    console.error("Postgres user script write failed", error);
    return false;
  }
}

export async function bootstrapUserScriptsFromDefaults(
  userId: string,
  defaults: ScriptConfig[],
): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const existing = await readUserScriptsFromPostgres(userId);
    if (existing && existing.length > 0) {
      return true;
    }

    for (const script of defaults) {
      await writeUserScriptToPostgres(
        userId,
        {
          ...script,
          id: makeId("usr-playbook"),
        },
        true,
      );
    }

    return true;
  } catch (error) {
    console.error("Postgres user script bootstrap failed", error);
    return false;
  }
}

export async function findReportByIdFromPostgres(reportId: string): Promise<CallReport | null> {
  if (!shouldUsePostgres()) {
    return null;
  }

  try {
    await ensureSchema();
    const db = getPool();
    const result = await db.query(
      `
      SELECT
        id,
        user_id,
        phone_number_id,
        call_sid,
        lead_id,
        company,
        contact_name,
        direct_dial,
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
      WHERE id = $1
      LIMIT 1
      `,
      [reportId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      userId: row.user_id ? String(row.user_id) : undefined,
      phoneNumberId: row.phone_number_id ? String(row.phone_number_id) : undefined,
      callSid: row.call_sid ? String(row.call_sid) : undefined,
      leadId: row.lead_id ? String(row.lead_id) : undefined,
      company: String(row.company),
      contactName: row.contact_name ? String(row.contact_name) : undefined,
      directDial: row.direct_dial ? String(row.direct_dial) : undefined,
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
    };
  } catch (error) {
    console.error("Postgres report lookup failed", error);
    return null;
  }
}

export async function appendCallTranscriptEventToPostgres(payload: {
  callSid: string;
  userId?: string;
  speaker: "Gloria" | "Interessent";
  text: string;
  phase?: string;
}): Promise<boolean> {
  if (!shouldUsePostgres()) {
    return false;
  }

  try {
    await ensureSchema();
    const db = getPool();
    await db.query(
      `
      INSERT INTO call_transcript_events (id, call_sid, user_id, speaker, text_value, phase, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (id) DO NOTHING;
      `,
      [
        `tx-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        payload.callSid,
        payload.userId || null,
        payload.speaker,
        payload.text,
        payload.phase || null,
      ],
    );
    return true;
  } catch (error) {
    console.error("Postgres transcript event write failed", error);
    return false;
  }
}