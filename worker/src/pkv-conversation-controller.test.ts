import assert from "node:assert/strict";
import test from "node:test";
import { assessPkvConversation, buildTenYearProjectionSentence, extractContributionPhrase, extractCurrentContributionPhrase, type ConversationTurn } from "./pkv-conversation-controller.js";

test("derives one deterministic next step from the PKV transcript", () => {
  const turns: ConversationTurn[] = [];
  assert.equal(assessPkvConversation(turns).stage, "need_relevance");

  turns.push({ role: "user", text: "Ich bin privat versichert." });
  turns.push({ role: "assistant", text: "Wie nehmen Sie diese Entwicklung wahr?" });
  turns.push({ role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." });
  assert.equal(assessPkvConversation(turns).stage, "need_contribution");

  turns.push({ role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?" });
  turns.push({ role: "user", text: "Ich zahle 1000 Euro im Monat." });
  const projection = assessPkvConversation(turns);
  assert.equal(projection.stage, "need_projection");
  assert.equal(projection.contributionPhrase, "1000 Euro");

  turns.push({ role: "assistant", text: "Bei vier Prozent pro Jahr werden aus 1000 Euro in zehn Jahren ungefähr 1480 Euro." });
  assert.equal(assessPkvConversation(turns).stage, "need_concept");

  turns.push({ role: "assistant", text: "Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?" });
  turns.push({ role: "user", text: "Das wäre auf Dauer schon viel." });
  assert.equal(assessPkvConversation(turns).stage, "need_interest");

  turns.push({ role: "assistant", text: "Herr Duic zeigt Ihnen Ihre persönliche Entwicklung und prüfbare Optionen. Wäre diese Klarheit für Sie hilfreich?" });
  turns.push({ role: "user", text: "Ja, das wäre hilfreich." });
  assert.equal(assessPkvConversation(turns).stage, "ready_to_schedule");
});

test("does not treat an earlier yes as scheduling consent", () => {
  const assessment = assessPkvConversation([
    { role: "user", text: "Ja, ich bin privat versichert und zahle 900 Euro." },
    { role: "assistant", text: "Wie nehmen Sie diese Entwicklung wahr?" },
    { role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." },
    { role: "assistant", text: "Bei vier Prozent pro Jahr sind das in zehn Jahren ungefähr 1330 Euro." },
    { role: "assistant", text: "Wie fühlt sich diese Entwicklung bis zum Ruhestand für Sie und Ihre Planung an?" },
    { role: "user", text: "Das gefällt mir nicht." },
  ]);

  assert.equal(assessment.stage, "need_interest");
  assert.equal(assessment.interestConfirmed, false);
});

test("does not unlock scheduling after a concept yes when the projection was skipped", () => {
  const assessment = assessPkvConversation([
    { role: "user", text: "Ich zahle 900 Euro." },
    { role: "assistant", text: "Herr Duic zeigt Ihnen Möglichkeiten, den Beitrag im Alter planbar zu halten. Wäre ein Termin interessant?" },
    { role: "user", text: "Ja, gerne." },
  ]);

  assert.equal(assessment.projectionDelivered, false);
  assert.equal(assessment.interestConfirmed, false);
  assert.notEqual(assessment.stage, "ready_to_schedule");
});

test("uses a deterministic 10-year projection instead of inventing a wrong value", () => {
  const instruction = buildTenYearProjectionSentence("1000 Euro");
  assert.match(instruction, /480 Euro mehr pro Monat.*1480 Euro/i);
  assert.match(instruction, /vier Prozent Steigerung pro Jahr/i);
  assert.doesNotMatch(instruction, /25 Euro mehr|rund 25|rund X Euro/i);
});

test("uses the latest contribution when the customer gives an initial and current amount", () => {
  assert.equal(extractContributionPhrase("Damals waren es 450 Euro, heute zahle ich 980 Euro."), "980 Euro");
  assert.equal(extractContributionPhrase("Heute zahle ich Tausend zweihundert Euro."), "Tausend zweihundert Euro");
  const turns: ConversationTurn[] = [
    { role: "user", text: "Damals waren es 450 Euro." },
    { role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?" },
    { role: "user", text: "Den möchte ich gerade nicht nennen." },
  ];
  assert.equal(extractCurrentContributionPhrase(turns), undefined);
});

test("never treats the initial contribution as the current contribution", () => {
  const onlyInitialContribution: ConversationTurn[] = [
    { role: "assistant", text: "Mit welchem Beitrag haben Sie einmal angefangen?" },
    { role: "user", text: "Damals waren es 450 Euro." },
  ];
  assert.equal(extractCurrentContributionPhrase(onlyInitialContribution), undefined);
  assert.match(buildTenYearProjectionSentence(extractCurrentContributionPhrase(onlyInitialContribution)), /eineinhalbmal so hoch/i);
  assert.doesNotMatch(buildTenYearProjectionSentence(extractCurrentContributionPhrase(onlyInitialContribution)), /450 Euro|665 Euro/i);

  const withCurrentContribution: ConversationTurn[] = [
    ...onlyInitialContribution,
    { role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?" },
    { role: "user", text: "Aktuell sind es 1280 Euro." },
  ];
  assert.equal(extractCurrentContributionPhrase(withCurrentContribution), "1280 Euro");
  assert.match(buildTenYearProjectionSentence(extractCurrentContributionPhrase(withCurrentContribution)), /615 Euro mehr.*1895 Euro/i);

  assert.equal(
    extractCurrentContributionPhrase([{ role: "user", text: "Aktuell zahle ich 1280 Euro." }]),
    "1280 Euro",
  );
});

test("accepts a bare amount as the answer to the current contribution question", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "Angefangen habe ich mit circa 450 Euro." },
    { role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?" },
    { role: "user", text: "1280." },
  ];
  assert.equal(extractCurrentContributionPhrase(turns), "1280 Euro");
  assert.match(buildTenYearProjectionSentence(extractCurrentContributionPhrase(turns)), /615 Euro mehr.*1895 Euro/i);
});

test("projects spoken contributions over ten years", () => {
  assert.match(buildTenYearProjectionSentence("knapp neunhundert Euro"), /430 Euro mehr.*1330 Euro monatlich/);
  assert.match(buildTenYearProjectionSentence("Tausend zweihundert Euro"), /575 Euro mehr.*1775 Euro monatlich/);
  assert.match(buildTenYearProjectionSentence(), /eineinhalbmal so hoch/i);
  assert.doesNotMatch(buildTenYearProjectionSentence(), /rund hundert Euro mehr/i);
});
