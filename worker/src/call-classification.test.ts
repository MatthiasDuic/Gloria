import assert from "node:assert/strict";
import test from "node:test";
import { classifyInboundSpeech, looksLikeMeaningfulHumanTurn } from "./call-classification.js";

test("classifies voicemail prompts", () => {
  assert.equal(
    classifyInboundSpeech("Bitte hinterlassen Sie eine Nachricht nach dem Signalton."),
    "voicemail",
  );
});

test("classifies transfer queue prompts", () => {
  assert.equal(
    classifyInboundSpeech("Einen Moment bitte, ich verbinde Sie. Bitte bleiben Sie in der Leitung."),
    "queue",
  );
});

test("detects meaningful human turns", () => {
  assert.equal(looksLikeMeaningfulHumanTurn("Ja."), false);
  assert.equal(looksLikeMeaningfulHumanTurn("Wir sind naechste Woche im Urlaub, bitte uebernaechste Woche."), true);
});
