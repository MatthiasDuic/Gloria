import assert from "node:assert/strict";
import test from "node:test";
import { UserTurnBuffer } from "./user-turn-buffer.js";

test("an ASR timeout releases a missing transcript so later turns can be processed", () => {
  const turns = new UserTurnBuffer();
  turns.speechStarted("missing-asr");
  turns.speechStopped("missing-asr");
  turns.speechStarted("next-turn");
  turns.speechStopped("next-turn");
  turns.complete("Ja, bitte.", "next-turn");

  assert.equal(turns.isBlocked(), true);
  turns.fail("missing-asr");
  assert.equal(turns.isBlocked(), false);
  turns.complete("Verspäteter ASR-Text.", "missing-asr");
  assert.deepEqual(turns.takeParts(), ["Ja, bitte."]);
});
