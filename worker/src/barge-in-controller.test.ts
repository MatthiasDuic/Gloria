import assert from "node:assert/strict";
import test from "node:test";
import { planBargeIn } from "./barge-in-controller.js";

test("does nothing when Gloria is neither generating nor playing audio", () => {
  assert.deepEqual(planBargeIn({ responseActive: false, playbackPending: false }), {
    interrupted: false,
    clearTelnyxPlayback: false,
    openAiEvents: [],
  });
});

test("cancels text generation and clears ElevenLabs playback", () => {
  assert.deepEqual(planBargeIn({
    responseActive: true,
    playbackPending: true,
  }), {
    interrupted: true,
    clearTelnyxPlayback: true,
    openAiEvents: [{ type: "response.cancel" }],
  });
});

test("clears remaining ElevenLabs playback after generation already finished", () => {
  const plan = planBargeIn({
    responseActive: false,
    playbackPending: true,
  });
  assert.equal(plan.clearTelnyxPlayback, true);
  assert.deepEqual(plan.openAiEvents, []);
});

test("keeps barge-in cancellation synchronous", () => {
  const startedAt = Date.now();
  const plan = planBargeIn({
    responseActive: true,
    playbackPending: true,
  });
  const elapsedMs = Date.now() - startedAt;
  assert.equal(plan.interrupted, true);
  assert.equal(plan.clearTelnyxPlayback, true);
  assert.deepEqual(plan.openAiEvents, [{ type: "response.cancel" }]);
  assert.ok(elapsedMs < 100);
});