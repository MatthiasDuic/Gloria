import assert from "node:assert/strict";
import test from "node:test";
import { advancePkvStep, assessPkvConversation, extractContributionPhrase, extractCurrentContributionPhrase, instructionForPkvStage, instructionForPkvStep, isClearPkvInterest, responseTextForPkvStep, type ConversationTurn } from "./pkv-conversation-controller.js";

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
  assert.match(instructionForPkvStage(projection), /1000 Euro/);

  turns.push({ role: "assistant", text: "Bei vier Prozent pro Jahr werden aus 1000 Euro in zehn Jahren ungefähr 1480 Euro." });
  assert.equal(assessPkvConversation(turns).stage, "need_concept");

  turns.push({ role: "assistant", text: "Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?" });
  turns.push({ role: "user", text: "Das wäre auf Dauer schon viel." });
  assert.equal(assessPkvConversation(turns).stage, "need_interest");

  turns.push({ role: "assistant", text: "Herr Duic zeigt Ihnen Ihre persönliche Entwicklung und prüfbare Optionen. Wäre diese Klarheit für Sie hilfreich?" });
  turns.push({ role: "user", text: "Ja, das wäre hilfreich." });
  assert.equal(assessPkvConversation(turns).stage, "ready_to_schedule");
});

test("provides ready-to-speak text for deterministic PKV turns", () => {
  assert.equal(responseTextForPkvStep(2), "Und welchen Beitrag zahlen Sie heute?");
  assert.match(responseTextForPkvStep(3, "1280 Euro") || "", /615 Euro mehr.*1895 Euro monatlich.*hochgerechnet\?/);
  assert.equal(responseTextForPkvStep(4), undefined);
});

test("introduces the contribution trend before asking for the initial contribution", () => {
  const instruction = instructionForPkvStep(1);
  assert.match(instruction, /Laut PKV Verband steigen die Beiträge in der Gesundheitsversorgung jedes Jahr um 3-5%, was auf den ersten Blick noch relativ harmlos wirkt, aber über die Jahre deutlich spürbar ist\. Erinnern Sie sich noch, mit welchem Beitrag Sie einmal angefangen haben\?/);
  assert.doesNotMatch(instruction, /Es geht um die Beitragsentwicklung/);
  assert.deepEqual(advancePkvStep(1, "Damals waren es 420 Euro."), { nextStep: 2, shouldEnd: false });
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

test("does not advance from step 0 on a plain greeting", () => {
  assert.deepEqual(advancePkvStep(0, "Guten Tag."), { nextStep: 0, shouldEnd: false });
  assert.deepEqual(advancePkvStep(0, "Ja, gerne."), { nextStep: 1, shouldEnd: false });
});

test("does not advance PKV stages on unrelated or repeated utterances", () => {
  assert.deepEqual(advancePkvStep(1, "Hallo, willkommen."), { nextStep: 1, shouldEnd: false });
  assert.deepEqual(advancePkvStep(1, "Die Beiträge sind schon stark gestiegen."), { nextStep: 1, shouldEnd: false });
  assert.deepEqual(advancePkvStep(1, "Ja, das tue ich."), { nextStep: 1, shouldEnd: false });
  assert.deepEqual(advancePkvStep(1, "Ich kann mich nicht mehr erinnern."), { nextStep: 2, shouldEnd: false });
  assert.deepEqual(advancePkvStep(2, "Dann lass mich das mal eben fertig machen."), { nextStep: 2, shouldEnd: false });
  assert.deepEqual(advancePkvStep(2, "Weiß ich nicht."), { nextStep: 3, shouldEnd: false });
  assert.deepEqual(advancePkvStep(3, "Nein, so habe ich das noch nie durchgerechnet."), { nextStep: 4, shouldEnd: false });
});

test("uses a deterministic 10-year projection instead of inventing a wrong value", () => {
  const instruction = instructionForPkvStep(3, "1000 Euro");
  assert.match(instruction, /1000 Euro.*480 Euro mehr pro Monat.*1480 Euro/i);
  assert.match(instruction, /vier Prozent Steigerung pro Jahr/i);
  assert.doesNotMatch(instruction, /25 Euro mehr|rund 25|rund X Euro/i);
});

test("uses the latest contribution when the customer gives an initial and current amount", () => {
  assert.equal(extractContributionPhrase("Damals waren es 450 Euro, heute zahle ich 980 Euro."), "980 Euro");
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
  assert.match(instructionForPkvStep(3, extractCurrentContributionPhrase(onlyInitialContribution)), /eineinhalbmal so hoch/i);
  assert.doesNotMatch(instructionForPkvStep(3, extractCurrentContributionPhrase(onlyInitialContribution)), /450 Euro|665 Euro/i);

  const withCurrentContribution: ConversationTurn[] = [
    ...onlyInitialContribution,
    { role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?" },
    { role: "user", text: "Aktuell sind es 1280 Euro." },
  ];
  assert.equal(extractCurrentContributionPhrase(withCurrentContribution), "1280 Euro");
  assert.match(instructionForPkvStep(3, extractCurrentContributionPhrase(withCurrentContribution)), /1280 Euro.*1895 Euro/i);

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
  assert.match(instructionForPkvStep(3, extractCurrentContributionPhrase(turns)), /1280 Euro.*615 Euro mehr.*1895 Euro/i);
});

test("follows the short PKV sequence and asks about each contribution separately", () => {
  assert.match(instructionForPkvStep(0), /Beitragsentwicklung.*kurzen Moment/i);
  assert.match(instructionForPkvStep(1), /um 3-5%.*mit welchem Beitrag Sie einmal angefangen haben/i);
  assert.doesNotMatch(instructionForPkvStep(1), /Es geht um die Beitragsentwicklung/i);
  assert.match(instructionForPkvStep(2), /welchen Beitrag zahlen Sie heute/i);
  assert.match(instructionForPkvStep(2), /ohne Einleitung, Bestätigung oder Dankesfloskel/i);
  assert.match(instructionForPkvStep(3, "980 Euro"), /Haben Sie das schon einmal für sich hochgerechnet\?/i);
  assert.match(instructionForPkvStep(4), /Herr Duic jeden Tag.*Wäre es für Sie interessant/i);
  assert.deepEqual(advancePkvStep(1, "Ja, einen Moment."), { nextStep: 1, shouldEnd: false });
  assert.deepEqual(advancePkvStep(2, "Damals waren es 450 Euro."), { nextStep: 3, shouldEnd: false });
  assert.deepEqual(advancePkvStep(2, "Heute zahle ich 980 Euro."), { nextStep: 3, shouldEnd: false });
  assert.deepEqual(advancePkvStep(3, "Nein, das hatte ich noch nicht berechnet."), { nextStep: 4, shouldEnd: false });
  assert.deepEqual(advancePkvStep(4, "Ja, das wäre interessant."), { nextStep: 6, shouldEnd: false });
});

test("does not invent a personal euro forecast or offer an agency appointment", () => {
  const projection = instructionForPkvStep(3);
  const scheduling = instructionForPkvStep(6);
  assert.match(projection, /eineinhalbmal so hoch/i);
  assert.doesNotMatch(projection, /rund hundert Euro mehr/i);
  assert.match(scheduling, /digital per Microsoft Teams oder bei Ihnen vor Ort/i);
  assert.doesNotMatch(scheduling, /bei Ihnen vor Ort, in (?:unserer )?Agentur|in (?:unserer )?Agentur oder/i);
});

test("requires an unambiguous interest statement before starting appointment scheduling", () => {
  assert.equal(isClearPkvInterest("Ja, gerne."), true);
  assert.equal(isClearPkvInterest("Das würde ich gerne machen."), true);
  assert.equal(isClearPkvInterest("Das klingt interessant."), true);
  assert.equal(isClearPkvInterest("Das macht Sinn."), true);
  assert.equal(isClearPkvInterest("Auf kommt mir aus."), false);
  assert.equal(isClearPkvInterest("Mhm."), false);
});