import assert from "node:assert/strict";
import test from "node:test";
import { advancePreparation, beginPreparation, buildPreparationQuestions, createPreparationState } from "./preparation-controller.js";
import type { ConversationTurn } from "./pkv-conversation-controller.js";

const policy = {
  topic: "private Krankenversicherung",
  pkvHealthQuestions: "1. Wie hoch ist Ihr Monatsbeitrag?\n2. Gibt es bekannte Diagnosen?\n- Nehmen Sie Medikamente?",
};

test("normalizes configured preparation questions", () => {
  assert.deepEqual(buildPreparationQuestions(policy), [
    "Wie hoch ist Ihr Monatsbeitrag?",
    "Gibt es bekannte Diagnosen?",
    "Nehmen Sie Medikamente?",
  ]);
});

test("asks for consent and skips facts already answered in the call", () => {
  const turns: ConversationTurn[] = [{ role: "user", text: "Ich zahle 1000 Euro im Monat." }];
  let transition = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", turns);
  assert.equal(transition.state.stage, "awaiting_consent");

  transition = advancePreparation(transition.state, "Ja, gerne.", turns);
  assert.equal(transition.state.stage, "asking");
  assert.equal(transition.state.currentQuestionIndex, 1);
  assert.match(transition.instruction, /bekannte Diagnosen/);
});

test("repeats only the consent request when the answer is unclear", () => {
  const started = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", []);
  const transition = advancePreparation(started.state, "Vielleicht.", []);
  assert.equal(transition.state.stage, "awaiting_consent");
  assert.match(transition.instruction, /noch einmal/);
});

test("stops immediately when the customer declines during the questions", () => {
  let transition = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Das möchte ich nicht beantworten.", []);
  assert.equal(transition.state.stage, "asking");
  assert.match(transition.instruction, /nächste Frage/);
});

test("repeats the current question when the answer does not fit", () => {
  let transition = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Hallo.", []);
  assert.equal(transition.state.stage, "asking");
  assert.match(transition.instruction, /dieselbe Vorbereitungsfrage noch einmal/);
});

test("completes the list and moves to the confirmation email", () => {
  const oneQuestionPolicy = { topic: "PKV", requiredQuestions: "Wie groß sind Sie?" };
  let transition = beginPreparation(createPreparationState(oneQuestionPolicy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Einen Meter achtzig.", []);
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(transition.instruction, /E-Mail-Adresse/);

  transition = advancePreparation(transition.state, "kunde@example.de", []);
  assert.equal(transition.state.stage, "completed");
  assert.match(transition.instruction, /verabschiede dich freundlich/);
  assert.match(transition.instruction, /keine weitere Frage/);
});