import assert from "node:assert/strict";
import test from "node:test";
import { planBargeIn } from "./barge-in-controller.js";

test("does nothing when Gloria is neither generating nor playing audio", () => {
  assert.deepEqual(planBargeIn({ responseActive: false, playbackPending: false, audioEndMs: 0 }), {
    interrupted: false,
    clearTelnyxPlayback: false,
    openAiEvents: [],
  });
});

test("cancels generation, clears Telnyx and truncates played audio", () => {
  assert.deepEqual(planBargeIn({
    responseActive: true,
    playbackPending: true,
    assistantItemId: "item_123",
    audioEndMs: 640,
  }), {
    interrupted: true,
    clearTelnyxPlayback: true,
    openAiEvents: [
      { type: "response.cancel" },
      { type: "conversation.item.truncate", item_id: "item_123", content_index: 0, audio_end_ms: 640 },
    ],
  });
});

test("clears and truncates remaining playback after generation already finished", () => {
  const plan = planBargeIn({
    responseActive: false,
    playbackPending: true,
    assistantItemId: "item_456",
    audioEndMs: 220,
  });
  assert.equal(plan.clearTelnyxPlayback, true);
  assert.deepEqual(plan.openAiEvents, [
    { type: "conversation.item.truncate", item_id: "item_456", content_index: 0, audio_end_ms: 220 },
  ]);
});