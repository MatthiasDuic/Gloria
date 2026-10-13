import assert from "node:assert/strict";
import test from "node:test";
import { parseRelativeCallbackAt, parseSlotPhraseToIso } from "./finalize.js";

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
