import assert from "node:assert/strict";
import test from "node:test";
import { parseRelativeCallbackAt, parseSlotPhraseToIso, persistAppointmentBooking } from "./finalize.js";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { newContext } from "./state.js";

test("accepts model time forms but never silently substitutes midnight for a missing time", () => {
  const canonical = parseSlotPhraseToIso("Dienstag, 10. November um 08:30 Uhr");
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November, 8:30"), canonical);
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November um 8:30"), canonical);
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November"), undefined);
});

test("persists booking before confirmation and rejects a success response without the stored appointment", async () => {
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const oldBase = process.env.APP_BASE_URL;
  const oldToken = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_BASE_URL = "https://booking.test";
  process.env.APP_INTERNAL_TOKEN = "test-token";
  setGlobalDispatcher(agent);
  try {
    const appointmentAt = "2026-11-10T07:30:00.000Z";
    const ctx = newContext({ callSid: "booking-test", streamSid: "test", userId: "test-user", company: "Testfirma", topic: "Test" });
    agent.get("https://booking.test").intercept({
      path: "/api/calls/webhook", method: "POST",
      body: (raw) => {
        const data = JSON.parse(raw);
        return data.outcome === "Termin" && data.appointmentAt === appointmentAt
          && data.appointmentMode === "Beim Kunden vor Ort" && data.userId === "test-user"
          && typeof data.summaryChunk === "string" && !data.summary;
      },
    }).reply(200, { ok: true, report: { outcome: "Termin", appointmentAt } });
    assert.equal(await persistAppointmentBooking(ctx, appointmentAt, "Beim Kunden vor Ort"), true);
    agent.get("https://booking.test").intercept({ path: "/api/calls/webhook", method: "POST" })
      .reply(200, { ok: true, report: {} });
    assert.equal(await persistAppointmentBooking(ctx, appointmentAt, "Beim Kunden vor Ort"), false);
    agent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    if (oldBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = oldToken;
    await agent.close();
  }
});

test("parses the exact numeric calendar slot used by the appointment controller", () => {
  const parsed = parseSlotPhraseToIso("Donnerstag, 31. Dezember um 13:00 Uhr");
  assert.match(parsed || "", /-12-31T12:00:00\.000Z$/);
});

test("resolves a relative callback time from the caller's agreed utterance", () => {
  const callerSpokeAt = Date.parse("2026-10-13T12:14:00.000Z");
  const parsed = parseRelativeCallbackAt([
    { role: "assistant", text: "Wann passt es Ihnen besser, dass ich zurückrufe?", at: callerSpokeAt - 5_000 },
    { role: "user", text: "In zehn Minuten wäre gut.", at: callerSpokeAt },
    { role: "assistant", text: "Dann melde ich mich in zehn Minuten noch einmal. Passt das?", at: callerSpokeAt + 2_000 },
    { role: "user", text: "Ja, das passt.", at: callerSpokeAt + 4_000 },
  ]);

  assert.equal(parsed, "2026-10-13T12:24:00.000Z");
});

test("does not turn an unrelated relative time into a callback", () => {
  const parsed = parseRelativeCallbackAt([
    { role: "assistant", text: "Wie läuft Ihre Woche?", at: 1_000 },
    { role: "user", text: "In zehn Minuten beginnt mein Termin.", at: 2_000 },
  ]);

  assert.equal(parsed, undefined);
});
