import assert from "node:assert/strict";
import test from "node:test";
import { assessPkvConversation, instructionForPkvStage, type ConversationTurn } from "./pkv-conversation-controller.js";

test("derives one deterministic next step from the PKV transcript", () => {
  const turns: ConversationTurn[] = [];
  assert.equal(assessPkvConversation(turns).stage, "need_relevance");

  turns.push({ role: "user", text: "Ich bin privat versichert." });
  turns.push({ role: "assistant", text: "Wie nehmen Sie diese Entwicklung wahr?" });
  turns.push({ role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." });
  assert.equal(assessPkvConversation(turns).stage, "need_contribution");

  turns.push({ role: "user", text: "Ich zahle 1000 Euro im Monat." });
  const projection = assessPkvConversation(turns);
  assert.equal(projection.stage, "need_projection");
  assert.match(instructionForPkvStage(projection), /1000 Euro/);

  turns.push({ role: "assistant", text: "Bei vier Prozent pro Jahr werden aus 1000 Euro in zehn Jahren ungefähr 1480 Euro." });
  assert.equal(assessPkvConversation(turns).stage, "need_retirement_reflection");

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