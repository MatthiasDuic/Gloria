import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "./log.js";

type OutboxEntry = { createdAt: number; body: Record<string, unknown> };
export type OutboxSender = (body: Record<string, unknown>) => Promise<boolean>;

const activeFiles = new Set<string>();
let flushing = false;

function outboxDir(): string {
  return process.env.GLORIA_OUTBOX_DIR?.trim()
    || (process.env.RENDER ? "/var/data/gloria-outbox" : path.join(tmpdir(), "gloria-outbox"));
}

export async function checkReportStorage(): Promise<boolean> {
  const dir = outboxDir();
  const probe = path.join(dir, `${randomUUID()}.probe`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe);
    return true;
  } catch (error) {
    log.error("outbox.storage_unavailable", { error: String(error) });
    return false;
  }
}

/** Publish only fully written, synced reports. The Render directory lives on the persistent disk. */
export async function enqueueReport(key: string, body: Record<string, unknown>): Promise<string> {
  const dir = outboxDir();
  const file = path.join(dir, `${randomUUID()}.json`);
  const temporary = `${file}.pending`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ createdAt: Date.now(), body } satisfies OutboxEntry), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    log.info("outbox.enqueued", { key });
    return file;
  } catch (error) {
    log.error("outbox.enqueue_failed", { key, error: String(error) });
    throw error;
  }
}

function isOutboxEntry(value: unknown): value is OutboxEntry {
  return typeof value === "object" && value !== null
    && "createdAt" in value && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
    && "body" in value && typeof value.body === "object" && value.body !== null && !Array.isArray(value.body);
}

async function sendFile(file: string, send: OutboxSender, now: number): Promise<boolean> {
  if (activeFiles.has(file)) return false;
  activeFiles.add(file);
  try {
    const entry: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isOutboxEntry(entry)) throw new Error("Invalid report outbox entry");
    if (now - entry.createdAt > 24 * 60 * 60_000) {
      log.warn("outbox.overdue", { file: path.basename(file), callSid: entry.body.callSid });
    }
    if (!await send(entry.body)) return false;
    await rm(file);
    log.info("outbox.delivered", { callSid: entry.body.callSid });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    // Keep malformed entries and failed deliveries for recovery; never discard customer reports.
    log.error("outbox.delivery_failed", { file: path.basename(file), error: String(error) });
    return false;
  } finally {
    activeFiles.delete(file);
  }
}

/** Persist before the first network attempt, not only after all retries have failed. */
export async function deliverReport(key: string, body: Record<string, unknown>, send: OutboxSender): Promise<boolean> {
  const file = await enqueueReport(key, body);
  return sendFile(file, send, Date.now());
}

export async function flushOutbox(send: OutboxSender, now = Date.now()): Promise<{ sent: number; pending: number; dropped: number }> {
  const result = { sent: 0, pending: 0, dropped: 0 };
  if (flushing) return result;
  flushing = true;
  try {
    let files: string[];
    try {
      files = await readdir(outboxDir());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
      throw error;
    }
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      if (await sendFile(path.join(outboxDir(), name), send, now)) result.sent += 1;
      else result.pending += 1;
    }
  } finally {
    flushing = false;
  }
  return result;
}
