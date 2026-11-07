import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { log } from "./log.js";

const MAX_AGE_MS = 24 * 60 * 60_000;

type OutboxEntry = { createdAt: number; body: Record<string, unknown> };

export type OutboxSender = (body: Record<string, unknown>) => Promise<boolean>;

function outboxDir(): string {
  return process.env.GLORIA_OUTBOX_DIR?.trim() || path.join(tmpdir(), "gloria-outbox");
}

function entryFile(dir: string, key: string): string {
  return path.join(dir, `${key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || Date.now()}.json`);
}

/** Keeps a report that could not be delivered, so a later flush can retry it (no secrets are stored). */
export async function enqueueReport(key: string, body: Record<string, unknown>): Promise<void> {
  const dir = outboxDir();
  try {
    await mkdir(dir, { recursive: true });
    const entry: OutboxEntry = { createdAt: Date.now(), body };
    await writeFile(entryFile(dir, key), JSON.stringify(entry), "utf8");
    log.warn("outbox.enqueued", { key });
  } catch (error) {
    log.error("outbox.enqueue_failed", { key, error: String(error) });
  }
}

let flushing = false;

export async function flushOutbox(send: OutboxSender, now = Date.now()): Promise<{ sent: number; pending: number; dropped: number }> {
  const result = { sent: 0, pending: 0, dropped: 0 };
  if (flushing) return result;
  flushing = true;
  const dir = outboxDir();
  try {
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const name of files.filter((file) => file.endsWith(".json"))) {
      const file = path.join(dir, name);
      let entry: OutboxEntry;
      try {
        entry = JSON.parse(await readFile(file, "utf8")) as OutboxEntry;
      } catch {
        await rm(file, { force: true });
        result.dropped += 1;
        continue;
      }
      if (now - entry.createdAt > MAX_AGE_MS) {
        log.error("outbox.expired", { file: name, callSid: entry.body.callSid });
        await rm(file, { force: true });
        result.dropped += 1;
        continue;
      }
      if (await send(entry.body)) {
        await rm(file, { force: true });
        result.sent += 1;
        log.info("outbox.delivered", { callSid: entry.body.callSid });
      } else {
        result.pending += 1;
      }
    }
  } finally {
    flushing = false;
  }
  return result;
}
