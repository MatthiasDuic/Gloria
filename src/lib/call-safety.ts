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

const LIST_NOUN = String.raw`(?:anruf|kontakt|kunden|adress|telefon)?(?:liste|datenbank|kartei|verteiler|datei)`;

/** Mirrors the worker's opt-out detection (worker/src/conversation-event-controller.ts) as a server-side safety net. */
export function isDataDeletionRequest(text: string): boolean {
  return /\bl[öo]schen\s+sie\b/i.test(text)
    || /\b(?:daten|nummer|telefonnummer|kontaktdaten|angaben|adresse)\b[^.!?]{0,40}\b(?:l[öo]schen|gel[öo]scht|entfernen|entfernt)\b/i.test(text)
    || /\b(?:l[öo]schen|entfernen)\b[^.!?]{0,30}\b(?:meine|unsere|die|alle)\s+(?:daten|nummer|telefonnummer|kontaktdaten|angaben)\b/i.test(text)
    || /\bwiderspreche\b[^.!?]{0,50}\b(?:daten|nutzung|verarbeitung|speicherung|verwendung)\b/i.test(text)
    || /\bwiderspruch\s+gegen\b[^.!?]{0,40}\b(?:daten|nutzung|verarbeitung|speicherung|verwendung)\b/i.test(text);
}

export function isDoNotCallRequest(text: string): boolean {
  if (isDataDeletionRequest(text)) return true;
  return /\bnicht\s+mehr\s+an(?:rufen|zurufen)\b|\bnie\s+wieder\s+an(?:rufen|zurufen)?\b|\brufen\s+sie\s+(?:mich|uns|hier)?\s*(?:bitte\s+)?(?:nie\s+wieder|nicht\s+mehr|nie\s+mehr)\s+an\b|\bkeine\s+(?:weiteren\s+)?(?:werbe)?anrufe\b|\bkeine\s+werbung\b|\bstreichen\s+sie\s+(?:mich|uns|meine|unsere|die)\b|\bnummer\s+l[öo]schen\b|\bh[öo]ren\s+sie\s+auf,?\s+(?:mich|uns|hier)\s+anzurufen\b|\bwiderspreche\b[^.!?]{0,40}\bwerbung\b/i.test(text)
    || (new RegExp(String.raw`\b(?:aus|von)\s+(?:ihrer|der|eurer|dieser|ihren|den)\s+${LIST_NOUN}`, "i").test(text)
      && /\b(?:nehmen|streichen|l[öo]schen|entfernen|austragen|raus)\b/i.test(text));
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