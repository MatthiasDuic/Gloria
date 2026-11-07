import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { enqueueReport, flushOutbox } from "./report-outbox.js";

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
    assert.deepEqual(await readdir(dir), ["call_1_a.json"]);

    const failed = await flushOutbox(async () => false);
    assert.deepEqual(failed, { sent: 0, pending: 1, dropped: 0 });
    assert.equal((await readdir(dir)).length, 1);

    const delivered: Array<Record<string, unknown>> = [];
    const sent = await flushOutbox(async (body) => {
      delivered.push(body);
      return true;
    });
    assert.deepEqual(sent, { sent: 1, pending: 0, dropped: 0 });
    assert.deepEqual(delivered, [{ callSid: "call-1", outcome: "Termin" }]);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("drops reports older than one day instead of retrying forever", async () => {
  await withOutboxDir(async (dir) => {
    await enqueueReport("old", { callSid: "call-old" });
    let called = false;
    const result = await flushOutbox(async () => {
      called = true;
      return true;
    }, Date.now() + 25 * 60 * 60_000);
    assert.deepEqual(result, { sent: 0, pending: 0, dropped: 1 });
    assert.equal(called, false);
    assert.deepEqual(await readdir(dir), []);
  });
});

test("an empty or missing outbox is a no-op", async () => {
  await withOutboxDir(async (dir) => {
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(await flushOutbox(async () => true), { sent: 0, pending: 0, dropped: 0 });
  });
});
