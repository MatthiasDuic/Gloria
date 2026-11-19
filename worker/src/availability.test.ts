import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { findFreeSlots, parseFreeSlotQuery } from "./availability.js";
import { invalidateBusySlots, loadBusySlotsCached, peekBusySlots, resetBusyCacheForTests } from "./busy.js";

test("free slot search honours range, part of day and one slot per day", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-12T06:00:00Z"));
  const slots = findFreeSlots([], { fromDate: "2026-10-26", toDate: "2026-10-30", partOfDay: "afternoon", maxResults: 3 });
  assert.equal(slots.length, 3);
  const days = new Set(slots.map((slot) => slot.startUtc.slice(0, 10)));
  assert.equal(days.size, 3);
  for (const slot of slots) {
    assert.ok(slot.startUtc >= "2026-10-26" && slot.startUtc < "2026-10-31");
    assert.ok(Number(slot.phrase.match(/(\d{2}):\d{2} Uhr/)?.[1]) >= 13);
  }
});

test("free slot search skips busy times and keeps the 7 day lead", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-12T06:00:00Z"));
  const early = findFreeSlots([], { fromDate: "2026-10-12", toDate: "2026-10-16" });
  assert.equal(early.length, 0);
  const busy = [{ start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" }];
  const slots = findFreeSlots(busy, { fromDate: "2026-10-26", toDate: "2026-10-26" });
  assert.equal(slots.length, 0);
});

test("query parsing rejects malformed dates and clamps the result count", () => {
  const query = parseFreeSlotQuery({ from_date: "morgen", to_date: "2026-11-02", part_of_day: "evening", max_results: 99 });
  assert.deepEqual(query, { fromDate: undefined, toDate: "2026-11-02", partOfDay: "any", maxResults: 6 });
});

test("busy cache serves fresh data without a request, dedupes in-flight loads and can be invalidated", async () => {
  resetBusyCacheForTests();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    setTimeout(() => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ slots: [] }));
    }, 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = { APP_BASE_URL: process.env.APP_BASE_URL, APP_INTERNAL_TOKEN: process.env.APP_INTERNAL_TOKEN };
  process.env.APP_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.APP_INTERNAL_TOKEN = "test-only";
  try {
    assert.equal(peekBusySlots("u1", 1000), null);
    await Promise.all([loadBusySlotsCached({ userId: "u1" }, 1000), loadBusySlotsCached({ userId: "u1" }, 1000)]);
    assert.equal(requests, 1);
    assert.deepEqual(await loadBusySlotsCached({ userId: "u1" }, 1000), []);
    assert.equal(requests, 1);
    invalidateBusySlots("u1");
    const invalidated = loadBusySlotsCached({ userId: "u1" }, 0);
    invalidateBusySlots("u1");
    await invalidated;
    assert.equal(requests, 2);
    assert.equal(peekBusySlots("u1", 1000), null, "an older in-flight response must not repopulate the cache");
    await loadBusySlotsCached({ userId: "u1" }, 1000);
    assert.equal(requests, 3);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
