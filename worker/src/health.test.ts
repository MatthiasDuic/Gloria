import assert from "node:assert/strict";
import test from "node:test";
import { dependenciesAreReady } from "./health.js";

test("readiness requires every telephony dependency", () => {
  assert.equal(dependenciesAreReady({ openai: true, telnyx: true, elevenlabs: true }), true);
  assert.equal(dependenciesAreReady({ openai: true, telnyx: false, elevenlabs: true }), false);
});
