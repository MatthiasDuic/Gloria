import assert from "node:assert/strict";
import test from "node:test";
import { replaceDiscouragedWords, stripSpokenQuotes } from "./spoken-vocabulary.js";
import { OpeningSpeechStream } from "./opening-speech-stream.js";

test("replaces 'Stellschrauben' with 'Optionen' in everything Gloria says", async () => {
  assert.equal(
    replaceDiscouragedWords("Welche Stellschrauben es für mehr Planbarkeit gibt. Eine Stellschraube ist der Selbstbehalt."),
    "Welche Optionen es für mehr Planbarkeit gibt. Eine Option ist der Selbstbehalt.",
  );
  const spoken: string[] = [];
  const stream = new OpeningSpeechStream(async (text) => { spoken.push(text); });
  stream.append("Sie sehen, welche Stell");
  stream.append("schrauben es gibt. Passt das?");
  await stream.finish();
  assert.deepEqual(spoken, ["Sie sehen, welche Optionen es gibt.", "Passt das?"]);
});

test("never passes quotation marks around a verbatim answer to TTS or the transcript", () => {
  assert.equal(
    stripSpokenQuotes("\"Herr Duic hat eine Liste zusammengestellt.\" \u201EGut\u201C \u2013 geht\u2019s?"),
    "Herr Duic hat eine Liste zusammengestellt. Gut \u2013 geht\u2019s?",
  );
});
