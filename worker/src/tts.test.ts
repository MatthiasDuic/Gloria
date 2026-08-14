import assert from "node:assert/strict";
import test from "node:test";
import { applyPronunciationFixes, parseWavToPcm16 } from "./tts.js";

function buildWav(samples: number[], sampleRate = 8000): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    data.writeInt16LE(samples[i], i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

test("parses a simple mono wav payload into 16-bit pcm samples", () => {
  const wav = buildWav([0, 1000, -1000, 2000]);
  const parsed = parseWavToPcm16(wav);

  assert.equal(parsed.sampleRate, 8000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitDepth, 16);
  assert.deepEqual(Array.from(parsed.samples), [0, 1000, -1000, 2000]);
});

test("speaks email addresses with German words for symbols", () => {
  const spoken = applyPronunciationFixes("Die Bestätigung geht an muster@muster.de.");
  assert.match(spoken, /muster at muster Punkt de/);
  assert.doesNotMatch(spoken, /muster@muster\.de/);
});
