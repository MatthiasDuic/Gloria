import assert from "node:assert/strict";
import test from "node:test";
import { findTopicPolicy, topicPolicyToSystemPrompt } from "./topic-policy-prompt.js";

test("selects only the requested dynamic topic policy", () => {
  const policies = [
    { topic: "Betriebliche Krankenversicherung" },
    { topic: "Jahresgespräch" },
  ];

  assert.equal(findTopicPolicy(policies, " jahresgespräch ")?.topic, "Jahresgespräch");
  assert.equal(findTopicPolicy(policies, "Unbekannte Kampagne"), null);
  assert.equal(findTopicPolicy(policies, undefined), null);
});

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

test("does not imply that Gloria has read a URL entered as a knowledge source", () => {
  const prompt = topicPolicyToSystemPrompt({
    topic: "Neue Kampagne",
    knowledge: "https://example.org/fachwissen",
  });

  assert.match(prompt, /Reine URLs sind nicht automatisch abgerufene Inhalte/);
  assert.match(prompt, /behaupte nicht, verlinkte Seiten gelesen zu haben/);
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