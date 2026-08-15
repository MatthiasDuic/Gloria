import assert from "node:assert/strict";
import test from "node:test";
import { extractConfirmedSlot, likelyIncompleteUserSpeech, shouldInterruptOnPartialSpeech } from "./telnyx-stream.js";

test("does not interrupt on short acknowledgements or rejections", () => {
  assert.equal(shouldInterruptOnPartialSpeech("Ja."), false);
  assert.equal(shouldInterruptOnPartialSpeech("Nein danke."), false);
  assert.equal(shouldInterruptOnPartialSpeech("Okay."), false);
});

test("interrupts on meaningful follow-up speech", () => {
  assert.equal(shouldInterruptOnPartialSpeech("Ich habe noch eine Frage"), true);
  assert.equal(shouldInterruptOnPartialSpeech("Können Sie das bitte noch einmal erklären?"), true);
});

test("holds clipped ASR fragments from the production call", () => {
  assert.equal(likelyIncompleteUserSpeech("I"), true);
  assert.equal(likelyIncompleteUserSpeech("Ich mit der"), true);
  assert.equal(likelyIncompleteUserSpeech("nein, der"), true);
  assert.equal(likelyIncompleteUserSpeech("Nein, bitte."), false);
});

test("locks slot from spoken ordinal date confirmation", () => {
  assert.equal(
    extractConfirmedSlot(
      "Perfekt, ich notiere Donnerstag, den zwanzigsten August um achtzehn Uhr dreißig für Sie.",
    ),
    "Donnerstag, den zwanzigsten August um achtzehn Uhr dreißig",
  );
});
