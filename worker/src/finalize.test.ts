import assert from "node:assert/strict";
import test from "node:test";
import { parseSlotPhraseToIso } from "./finalize.js";

test("parses the exact numeric calendar slot used by the appointment controller", () => {
  const parsed = parseSlotPhraseToIso("Donnerstag, 31. Dezember um 13:00 Uhr");
  assert.match(parsed || "", /-12-31T12:00:00\.000Z$/);
});
