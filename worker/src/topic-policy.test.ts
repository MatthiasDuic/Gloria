import assert from "node:assert/strict";
import test from "node:test";
import { createVoiceProfile } from "./topic-policy.js";

test("uses a natural, conversational PKV voice profile by default", () => {
  const profile = createVoiceProfile("private Krankenversicherung");
  assert.equal(profile.stability, 0.38);
  assert.equal(profile.style, 0.36);
  assert.equal(profile.speed, 0.96);
  assert.equal(profile.speakerBoost, true);
});