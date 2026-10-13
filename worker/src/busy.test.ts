import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { computeFreeSlots, isAppointmentSlotFree, loadBusySlots } from "./busy.js";

test("a booking reserves exactly 90 minutes and allows touching endpoints", () => {
  const busy = [{ start: "2026-10-14T09:00:00Z", end: "2026-10-14T10:30:00Z" }];
  assert.equal(isAppointmentSlotFree("2026-10-14T07:30:00Z", busy), true);
  assert.equal(isAppointmentSlotFree("2026-10-14T08:00:00Z", busy), false);
  assert.equal(isAppointmentSlotFree("2026-10-14T09:45:00Z", busy), false);
  assert.equal(isAppointmentSlotFree("2026-10-14T10:30:00Z", busy), true);
  assert.equal(isAppointmentSlotFree("invalid", busy), false);
});

test("multi-day blocks exclude customer-proposed appointment times", () => {
  const busy = [{ start: "2026-10-13T09:00:00Z", end: "2026-10-16T10:00:00Z" }];
  assert.equal(isAppointmentSlotFree("2026-10-14T12:00:00Z", busy), false);
  assert.equal(isAppointmentSlotFree("2026-10-16T09:30:00Z", busy), false);
  assert.equal(isAppointmentSlotFree("2026-10-16T10:00:00Z", busy), true);
});

test("free proposals have no daily count cap or double travel buffer", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-10-12T06:00:00Z"));
  const free = computeFreeSlots([], { daysAhead: 3, minLeadDays: 0, maxCount: 1000 });
  const counts = new Map<string, number>();
  for (const slot of free) {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(slot.startUtc));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.ok([...counts.values()].some((count) => count >= 5));
  const first = free[0];
  const busy = [{ start: first.startUtc, end: new Date(Date.parse(first.startUtc) + 90 * 60_000).toISOString() }];
  const remaining = computeFreeSlots(busy, { daysAhead: 3, minLeadDays: 0, maxCount: 1000 });
  assert.ok(remaining.every((slot) => isAppointmentSlotFree(slot.startUtc, busy)));
  assert.ok(remaining.some((slot) => slot.startUtc === busy[0].end));
});

test("missing calendar configuration is unavailable, not an empty calendar", async () => {
  assert.equal(await loadBusySlots({}), null);
});

test("failed and malformed calendar responses fail closed; a valid empty calendar remains available", async () => {
  let status = 200;
  let body: object = { slots: [] };
  const server = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const previous = { APP_BASE_URL: process.env.APP_BASE_URL, APP_INTERNAL_TOKEN: process.env.APP_INTERNAL_TOKEN };
  process.env.APP_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.APP_INTERNAL_TOKEN = "test-only";
  try {
    assert.deepEqual(await loadBusySlots({ userId: "test" }), []);
    status = 503;
    assert.equal(await loadBusySlots({ userId: "test" }), null);
    status = 200;
    for (const invalid of [{}, { slots: [null] }, { slots: [{ start: "invalid", end: "invalid" }] }, { slots: [{ start: "2026-10-14T10:00:00Z", end: "2026-10-14T09:00:00Z" }] }]) {
      body = invalid;
      assert.equal(await loadBusySlots({ userId: "test" }), null);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
