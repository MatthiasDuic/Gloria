import assert from "node:assert/strict";
import test from "node:test";
import { TelnyxPlayback, type PlaybackTimer } from "./telnyx-playback.js";

function manualScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    schedule(callback: () => void): PlaybackTimer {
      callbacks.push(callback);
      return callbacks.length as unknown as PlaybackTimer;
    },
    cancelSchedule(): void {},
    runNext(): void {
      callbacks.shift()?.();
    },
  };
}

test("splits realtime audio into paced Telnyx frames", () => {
  const scheduler = manualScheduler();
  const frames: Buffer[] = [];
  let idleCount = 0;
  const playback = new TelnyxPlayback({
    sendFrame: (frame) => { frames.push(frame); return true; },
    onIdle: () => { idleCount += 1; },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  playback.startResponse();
  playback.appendBase64Audio(Buffer.alloc(320, 7).toString("base64"));
  assert.equal(frames.length, 1);
  assert.equal(playback.isPending(), true);

  scheduler.runNext();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 160);
  assert.equal(playback.bytesSent(), 320);
  assert.equal(playback.isPending(), true);

  playback.finishAudio(0xd5);
  scheduler.runNext();
  assert.equal(playback.isPending(), false);
  assert.equal(idleCount, 1);
});

test("pads the final partial frame with the codec silence byte", () => {
  const frames: Buffer[] = [];
  const playback = new TelnyxPlayback({ sendFrame: (frame) => { frames.push(frame); return true; } });
  playback.startResponse();
  playback.appendBase64Audio(Buffer.from([1, 2, 3]).toString("base64"));
  playback.finishAudio(0xd5);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 160);
  assert.deepEqual([...frames[0].subarray(0, 4)], [1, 2, 3, 0xd5]);
});

test("stop clears queued playback and ignores later audio", () => {
  const scheduler = manualScheduler();
  const frames: Buffer[] = [];
  const playback = new TelnyxPlayback({
    sendFrame: (frame) => { frames.push(frame); return true; },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });
  playback.appendBase64Audio(Buffer.alloc(320).toString("base64"));
  playback.stop();
  scheduler.runNext();
  playback.appendBase64Audio(Buffer.alloc(160).toString("base64"));
  assert.equal(frames.length, 1);
  assert.equal(playback.isPending(), false);
});

test("interrupt reports played duration and allows the next response", () => {
  const scheduler = manualScheduler();
  const frames: Buffer[] = [];
  const playback = new TelnyxPlayback({
    sendFrame: (frame) => { frames.push(frame); return true; },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });
  playback.startResponse();
  playback.appendBase64Audio(Buffer.alloc(480).toString("base64"));
  scheduler.runNext();

  assert.deepEqual(playback.interrupt(), { audioEndMs: 40, bytesSent: 320 });
  assert.equal(playback.isPending(), false);

  playback.startResponse();
  playback.appendBase64Audio(Buffer.alloc(160).toString("base64"));
  assert.equal(frames.length, 3);
});

test("stays pending while the stream has a temporary gap", () => {
  const scheduler = manualScheduler();
  const frames: Buffer[] = [];
  const playback = new TelnyxPlayback({
    sendFrame: (frame) => { frames.push(frame); return true; },
    schedule: scheduler.schedule,
    cancelSchedule: scheduler.cancelSchedule,
  });

  playback.startResponse();
  playback.appendBase64Audio(Buffer.alloc(160, 7).toString("base64"));
  scheduler.runNext();
  assert.equal(playback.isPending(), true);

  playback.appendBase64Audio(Buffer.alloc(160, 7).toString("base64"));
  assert.equal(playback.isPending(), true);
  playback.finishAudio(0xd5);
  scheduler.runNext();
  assert.equal(playback.isPending(), false);
});