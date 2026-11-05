import assert from "node:assert/strict";
import test from "node:test";
import { PrefetchedSpeech } from "./prefetched-speech.js";

test("prefetched speech replays cached audio and then streams the pending rest", () => {
  const speech = new PrefetchedSpeech("Guten Tag");
  speech.push(Buffer.from([1, 2]));
  const played: number[] = [];
  let ended: [boolean, number] | undefined;
  speech.play({ onChunk: (chunk) => played.push(...chunk), onEnd: (ok, bytes) => { ended = [ok, bytes]; } });
  assert.deepEqual(played, [1, 2]);
  assert.equal(ended, undefined);
  speech.push(Buffer.from([3]));
  speech.complete(true);
  assert.deepEqual(played, [1, 2, 3]);
  assert.deepEqual(ended, [true, 3]);
  assert.equal(speech.isReady(), true);
});

test("prefetched speech without audio is reported as unusable", () => {
  const speech = new PrefetchedSpeech("Guten Tag");
  speech.complete(true);
  assert.equal(speech.isUsable(), false);
  let ended: boolean | undefined;
  speech.play({ onChunk: () => undefined, onEnd: (ok) => { ended = ok; } });
  assert.equal(ended, false);
});
