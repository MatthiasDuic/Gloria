import assert from "node:assert/strict";
import test from "node:test";
import { linearToAlaw, linearToUlaw, Pcm24kToG711Encoder } from "./fallback-tts.js";

function alawToLinear(value: number): number {
  const a = value ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

function ulawToLinear(value: number): number {
  const u = ~value & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

test("G.711 encoders produce the standard silence and clipping codes", () => {
  assert.equal(linearToAlaw(0), 0xd5);
  assert.equal(linearToAlaw(32767), 0xaa);
  assert.equal(linearToAlaw(-32768), 0x2a);
  assert.equal(linearToUlaw(0), 0xff);
  assert.equal(linearToUlaw(32767), 0x80);
  assert.equal(linearToUlaw(-32768), 0x00);
});

test("G.711 encoders round-trip speech amplitudes within the codec's quantisation error", () => {
  for (let sample = -30_000; sample <= 30_000; sample += 997) {
    const tolerance = Math.max(80, Math.abs(sample) * 0.07);
    assert.ok(Math.abs(alawToLinear(linearToAlaw(sample)) - sample) <= tolerance, `A-law ${sample}`);
    assert.ok(Math.abs(ulawToLinear(linearToUlaw(sample)) - sample) <= tolerance, `mu-law ${sample}`);
  }
});

test("the fallback voice encoder downsamples 24 kHz PCM to 8 kHz across chunk boundaries", () => {
  const encoder = new Pcm24kToG711Encoder("alaw_8000");
  const pcm = Buffer.alloc(12);
  for (let index = 0; index < 6; index += 1) pcm.writeInt16LE(index < 3 ? 1000 : -2000, index * 2);

  const first = encoder.push(pcm.subarray(0, 4));
  assert.equal(first.length, 0);
  const second = encoder.push(pcm.subarray(4, 9));
  assert.deepEqual([...second], [linearToAlaw(1000)]);
  const third = encoder.push(pcm.subarray(9));
  assert.deepEqual([...third], [linearToAlaw(-2000)]);

  const ulaw = new Pcm24kToG711Encoder("ulaw_8000").push(pcm);
  assert.deepEqual([...ulaw], [linearToUlaw(1000), linearToUlaw(-2000)]);
});
