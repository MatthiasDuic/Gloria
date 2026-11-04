import { getDatabasePool, isDatabaseUrlConfigured } from "./report-db";
import { normalizePhoneForDial } from "./phone-utils";

let schemaReady: Promise<void> | undefined;
async function database() {
  const pool = await getDatabasePool();
  if (!schemaReady) schemaReady = pool.query(`CREATE TABLE IF NOT EXISTS gloria_call_suppressions (
    user_id TEXT NOT NULL, phone TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id,phone))`).then(() => undefined).catch((error) => { schemaReady = undefined; throw error; });
  await schemaReady;
  return pool;
}

export function isDoNotCallRequest(text: string): boolean {
  return /nicht\s+mehr\s+anrufen|rufen\s+sie\s+(?:mich\s+)?(?:bitte\s+)?nicht\s+mehr\s+an|keine\s+(?:weiteren\s+)?(?:werbe)?anrufe|streichen\s+sie\s+mich|nummer\s+l[öo]schen/i.test(text);
}

export async function suppressPhoneNumber(userId: string, phone: string): Promise<void> {
  if (!isDatabaseUrlConfigured()) return;
  const normalized = normalizePhoneForDial(phone);
  if (!normalized) return;
  const pool = await database();
  await pool.query("INSERT INTO gloria_call_suppressions (user_id,phone) VALUES ($1,$2) ON CONFLICT DO NOTHING", [userId, normalized]);
}

export async function isPhoneNumberSuppressed(userId: string, phone: string): Promise<boolean> {
  if (!isDatabaseUrlConfigured()) return false;
  const pool = await database();
  const result = await pool.query("SELECT 1 FROM gloria_call_suppressions WHERE user_id = $1 AND phone = $2", [userId, normalizePhoneForDial(phone)]);
  return result.rows.length > 0;
}