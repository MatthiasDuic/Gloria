import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { checkReportStorage, deliverReport, enqueueReport, flushOutbox } from "./report-outbox.js";

async function withOutboxDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "gloria-outbox-test-"));
  const previous = process.env.GLORIA_OUTBOX_DIR;
  process.env.GLORIA_OUTBOX_DIR = dir;
  try {
    await run(dir);
  } finally {
    if (previous === undefined) delete process.env.GLORIA_OUTBOX_DIR;
    else process.env.GLORIA_OUTBOX_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

test("keeps an undelivered report until a later flush succeeds", async () => {
  await withOutboxDir(async (dir) => {
    await enqueueReport("call:1/a", { callSid: "call-1", outcome: "Termin" });
    assert.equal((await readdir(dir)).filter((file) => file.endsWith(".json")).length, 1);
    assert.deepEqual(await flushOutbox(async () => false), { sent: 0, pending: 1, dropped: 0 });
    const delivered: Array<Record<string, unknown>> = [];
    assert.deepEqual(await flushOutbox(async (body) => {
      delivered.push(body);
      return true;
    }), { sent: 1, pending: 0, dropped: 0 });
    assert.deepEqual(delivered, [{ callSid: "call-1", outcome: "Termin" }]);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("retries reports after a multi-day outage instead of deleting them", async () => {
  await withOutboxDir(async (dir) => {
    await enqueueReport("old", { callSid: "call-old" });
    let called = false;
    const result = await flushOutbox(async () => { called = true; return true; }, Date.now() + 25 * 60 * 60_000);
    assert.deepEqual(result, { sent: 1, pending: 0, dropped: 0 });
    assert.equal(called, true);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("does not overwrite different call IDs that used to normalize to the same filename", async () => {
  await withOutboxDir(async () => {
    await enqueueReport("call:1/a", { callSid: "first" });
    await enqueueReport("call_1_a", { callSid: "second" });
    const delivered: unknown[] = [];
    await flushOutbox(async (body) => { delivered.push(body.callSid); return true; });
    assert.deepEqual(delivered.sort(), ["first", "second"]);
  });
});

test("preserves damaged entries for recovery and surfaces the failure", async () => {
  await withOutboxDir(async (dir) => {
    await writeFile(path.join(dir, "damaged.json"), "{truncated", "utf8");
    const result = await flushOutbox(async () => { throw new Error("must not send"); });
    assert.equal(result.pending, 1);
    assert.equal(result.dropped, 0);
    assert.equal(await readFile(path.join(dir, "damaged.json"), "utf8"), "{truncated");
  });
});

test("a failed write rejects rather than pretending the report was queued", async () => {
  await withOutboxDir(async (dir) => {
    const file = path.join(dir, "not-a-directory");
    await writeFile(file, "");
    process.env.GLORIA_OUTBOX_DIR = file;
    assert.equal(await checkReportStorage(), false);
    await assert.rejects(enqueueReport("call", { callSid: "call" }));
  });
});

test("persists before sending and avoids concurrent delivery by the retry timer", async () => {
  await withOutboxDir(async (dir) => {
    const sent = await deliverReport("call", { callSid: "call" }, async () => {
      const entries = await readdir(dir);
      assert.equal(entries.length, 1);
      assert.equal(JSON.parse(await readFile(path.join(dir, entries[0]), "utf8")).body.callSid, "call");
      assert.deepEqual(await flushOutbox(async () => { throw new Error("duplicate delivery"); }),
        { sent: 0, pending: 1, dropped: 0 });
      return true;
    });
    assert.equal(sent, true);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("replays a report written by a different, terminated worker process", async () => {
  await withOutboxDir(async () => {
    const moduleUrl = new URL("./report-outbox.js", import.meta.url).href;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      `const { enqueueReport } = await import(${JSON.stringify(moduleUrl)}); await enqueueReport("restart", {callSid:"restart"});`,
    ], { env: process.env });
    const delivered: unknown[] = [];
    assert.deepEqual(await flushOutbox(async (body) => { delivered.push(body.callSid); return true; }),
      { sent: 1, pending: 0, dropped: 0 });
    assert.deepEqual(delivered, ["restart"]);
  });
});

test("an empty or missing outbox is a no-op", async () => {
  await withOutboxDir(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(await flushOutbox(async () => true), { sent: 0, pending: 0, dropped: 0 });
  });
});
