import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeResponseController, type ResponseTimer } from "./realtime-response-controller.js";

function manualClock() {
  let currentTime = 1000;
  const callbacks: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    now: () => currentTime,
    schedule(callback: () => void, delayMs: number): ResponseTimer {
      callbacks.push({ callback, delayMs });
      return callbacks.length as unknown as ResponseTimer;
    },
    cancelSchedule(): void {},
    runNext(): void {
      const next = callbacks.shift();
      if (!next) return;
      currentTime += next.delayMs;
      next.callback();
    },
  };
}

test("queues only the first request while a response is active", () => {
  const clock = manualClock();
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });

  assert.equal(controller.request("first"), true);
  controller.markCreated();
  assert.equal(controller.request("second"), false);
  assert.equal(controller.request("third"), false);
  controller.markFinished();
  clock.runNext();
  assert.deepEqual(sent, ["first", "second"]);
});

test("waits for playback to become idle before sending queued work", () => {
  const clock = manualClock();
  const sent: string[] = [];
  let playbackPending = true;
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => playbackPending,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });

  controller.request("after audio");
  assert.deepEqual(sent, []);
  playbackPending = false;
  controller.flush();
  assert.deepEqual(sent, ["after audio"]);
});

test("cancelled responses release queued instructions without a cooldown", () => {
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
  });
  controller.request("first");
  controller.markCreated();
  controller.request("next");
  controller.markCancelled();
  assert.deepEqual(sent, ["first", "next"]);
});

test("stop discards queued instructions", () => {
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
  });
  controller.request("first");
  controller.markCreated();
  controller.request("discarded");
  controller.stop();
  controller.markCancelled();
  assert.deepEqual(sent, ["first"]);
});

test("interruption discards stale queued instructions before cancellation completes", () => {
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
  });
  controller.request("active");
  controller.markCreated();
  controller.request("stale queued response");
  controller.markInterruptRequested();
  controller.markCancelled();
  assert.deepEqual(sent, ["active"]);
});