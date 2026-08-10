import assert from "node:assert/strict";
import test from "node:test";
import { shouldInterruptOnPartialSpeech } from "./telnyx-stream.js";

test("does not interrupt on short acknowledgements or rejections", () => {
  assert.equal(shouldInterruptOnPartialSpeech("Ja."), false);
  assert.equal(shouldInterruptOnPartialSpeech("Nein danke."), false);
  assert.equal(shouldInterruptOnPartialSpeech("Okay."), false);
});

test("interrupts on meaningful follow-up speech", () => {
  assert.equal(shouldInterruptOnPartialSpeech("Ich habe noch eine Frage"), true);
  assert.equal(shouldInterruptOnPartialSpeech("Können Sie das bitte noch einmal erklären?"), true);
});
