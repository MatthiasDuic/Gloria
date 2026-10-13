import assert from "node:assert/strict";
import test from "node:test";
import { classifyInboundSpeech, looksLikeMeaningfulHumanTurn } from "./call-classification.js";

test("classifies voicemail prompts", () => {
  for (const prompt of [
    "Bitte hinterlassen Sie eine Nachricht nach dem Signalton.",
    "Sie haben die Mailbox von Herrn Biletzki erreicht.",
    "Sprechen Sie nach dem Piepton.",
    "Piep.",
    "Der Teilnehmer ist momentan nicht erreichbar.",
    "You have reached the voicemail of Mr. Biletzki.",
    "Please leave a message after the tone.",
  ]) {
    assert.equal(classifyInboundSpeech(prompt), "voicemail", prompt);
  }
});

test("classifies transfer queue prompts", () => {
  for (const prompt of [
    "Einen Moment bitte, ich verbinde Sie. Bitte bleiben Sie in der Leitung.",
    "Alle Mitarbeiter sind im Gespräch, bitte haben Sie einen Moment Geduld.",
    "Ihre Verbindung wird gehalten.",
    "Sie befinden sich in unserer Warteschleife.",
    "Drücken Sie bitte die eins, um verbunden zu werden.",
    "Willkommen bei Beispiel GmbH. Bitte warten Sie einen Moment.",
  ]) {
    assert.equal(classifyInboundSpeech(prompt), "queue", prompt);
  }
});

test("prioritizes voicemail announcements when classifying a full prompt", () => {
  assert.equal(
    classifyInboundSpeech("Einen Moment bitte, ich verbinde Sie. Sie haben die Mailbox von Herrn Biletzki erreicht."),
    "voicemail",
  );
});

test("detects meaningful human turns", () => {
  assert.equal(looksLikeMeaningfulHumanTurn("Ja."), false);
  assert.equal(looksLikeMeaningfulHumanTurn("Wir sind naechste Woche im Urlaub, bitte uebernaechste Woche."), true);
});
