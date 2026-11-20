import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeResponseController, type ResponseTimer } from "./realtime-response-controller.js";

function manualClock() {
  let currentTime = 1000;
  const callbacks: Array<{ id: number; callback: () => void; delayMs: number; cancelled: boolean }> = [];
  let nextId = 0;
  return {
    now: () => currentTime,
    schedule(callback: () => void, delayMs: number): ResponseTimer {
      const id = ++nextId;
      callbacks.push({ id, callback, delayMs, cancelled: false });
      return id as unknown as ResponseTimer;
    },
    cancelSchedule(timer: ResponseTimer): void {
      const scheduled = callbacks.find((entry) => entry.id === (timer as unknown as number));
      if (scheduled) scheduled.cancelled = true;
    },
    runNext(): void {
      let next = callbacks.shift();
      while (next?.cancelled) next = callbacks.shift();
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

test("reserves the response slot before response.created arrives", () => {
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
  });

  assert.equal(controller.request("first"), true);
  assert.equal(controller.request("second"), false);
  assert.deepEqual(sent, ["first"]);
});

test("does not deduplicate distinct instructions that share a long prefix", () => {
  const clock = manualClock();
  const sent: string[] = [];
  const sharedPrefix = "A".repeat(110);
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });

  controller.request(`${sharedPrefix} first`);
  controller.markCreated();
  controller.request(`${sharedPrefix} second`);
  controller.markFinished();
  clock.runNext();

  assert.deepEqual(sent, [`${sharedPrefix} first`, `${sharedPrefix} second`]);
});

test("reconnects when a response is never acknowledged by the realtime server", () => {
  const clock = manualClock();
  const timeouts: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: () => true,
    isPlaybackPending: () => false,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    creationTimeoutMs: 100,
    onTimeout: (phase) => timeouts.push(phase),
  });

  controller.request("hello");
  clock.runNext();

  assert.deepEqual(timeouts, ["creation"]);
  assert.equal(controller.isActive(), true);
});

test("clears the response watchdog after response completion", () => {
  const clock = manualClock();
  const timeouts: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: () => true,
    isPlaybackPending: () => false,
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
    generationTimeoutMs: 100,
    onTimeout: (phase) => timeouts.push(phase),
  });

  controller.request("hello");
  controller.markCreated();
  controller.markFinished();
  clock.runNext();

  assert.deepEqual(timeouts, []);
});

test("allows an empty instruction on the first request", () => {
  const sent: string[] = [];
  const controller = new RealtimeResponseController({
    sendResponse: (instructions) => { sent.push(instructions); return true; },
    isPlaybackPending: () => false,
  });

  assert.equal(controller.request(""), true);
  assert.deepEqual(sent, [""]);
  controller.stop();
});