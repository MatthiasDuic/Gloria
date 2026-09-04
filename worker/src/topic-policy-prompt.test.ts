import assert from "node:assert/strict";
import test from "node:test";
import { topicPolicyToSystemPrompt } from "./topic-policy-prompt.js";

test("includes complete topic guidance for a natural, objection-aware dialog", () => {
  const prompt = topicPolicyToSystemPrompt({
    topic: "Energie",
    callObjective: "Einen kurzen Orientierungstermin vereinbaren.",
    decisionMakerContext: "Wirtschaftliche Einordnung ohne Wechselzwang.",
    problemBuildup: "Bestehende Strom- und Gaskonditionen verständlich einordnen.",
    objectionResponses: "Keine Zeit: Wir halten es bei 15 Minuten.",
    knowledge: "VERBOTEN: Keine Preisgarantien.",
    proofPoints: "Konditionen können je nach Beschaffungszeitpunkt schwanken.",
    transferHandling: "Nur auf ausdrücklichen Wunsch weiterleiten.",
  });

  assert.match(prompt, /FÜHRUNG NACH BESTÄTIGTEM ENTSCHEIDER/);
  assert.match(prompt, /bestehende Strom- und Gaskonditionen/i);
  assert.match(prompt, /EINWÄNDE/);
  assert.match(prompt, /Keine Zeit/);
  assert.match(prompt, /Keine Preisgarantien/);
  assert.match(prompt, /MENSCHLICHE ÜBERGABE/);
  assert.match(prompt, /steuert jedoch fachlichen Anlass, Nutzen, Einwände und Gesprächsführung/);
});

test("keeps long Topic Policy entries compact so worker rules remain dominant", () => {
  const prompt = topicPolicyToSystemPrompt({
    topic: "Energie",
    behavior: Array.from({ length: 8 }, (_, index) => `Regel ${index + 1}`).join("\n"),
  });

  assert.match(prompt, /Regel 1/);
  assert.match(prompt, /Regel 4/);
  assert.doesNotMatch(prompt, /Regel 5/);
});