import assert from "node:assert/strict";
import test from "node:test";
import { advancePreparation, beginPreparation, buildPreparationQuestions, createPreparationState } from "./preparation-controller.js";
import type { ConversationTurn } from "./pkv-conversation-controller.js";

const policy = {
  topic: "private Krankenversicherung",
  pkvHealthQuestions: "1. Wie hoch ist Ihr Monatsbeitrag?\n2. Gibt es bekannte Diagnosen?\n- Nehmen Sie Medikamente?",
};
const knownStatusTurns: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert." }];

test("normalizes configured preparation questions", () => {
  assert.deepEqual(buildPreparationQuestions(policy), [
    "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
    "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
    "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
    "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
    "Gibt es aktuell laufende Behandlungen?",
    "Gibt es bestehende Diagnosen, die wir berücksichtigen sollten?",
  ]);
});

test("asks for consent and skips facts already answered in the call", () => {
  const turns: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert und zahle 1000 Euro im Monat." }];
  let transition = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", turns);
  assert.equal(transition.state.stage, "awaiting_consent");

  transition = advancePreparation(transition.state, "Ja, gerne.", turns);
  assert.equal(transition.state.stage, "asking");
  assert.equal(transition.state.currentQuestionIndex, 1);
  assert.match(transition.instruction, /Krankenversicherer/);
  assert.match(transition.instruction, /Sage keine Einleitung/);
});

test("does not confuse insurance status with the current insurer", () => {
  const insurerPolicy = {
    topic: "private Krankenversicherung",
    requiredQuestions: "Bei welchem Krankenversicherer sind Sie aktuell versichert?",
  };
  const turns: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert." }];
  let transition = beginPreparation(createPreparationState(insurerPolicy), "Montag um 13 Uhr", turns);
  transition = advancePreparation(transition.state, "Ja.", turns);
  assert.match(transition.instruction, /Krankenversicherer/);
});

test("uses the same compact health precheck regardless of insurance status", () => {
  assert.deepEqual(buildPreparationQuestions({ topic: "private Krankenversicherung" }), [
    "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
    "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
    "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
    "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
    "Gibt es aktuell laufende Behandlungen?",
    "Gibt es bestehende Diagnosen, die wir berücksichtigen sollten?",
  ]);
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

test("requires a complete birth date before continuing", () => {
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "gesetzlich.", []);
  transition = advancePreparation(transition.state, "AOK.", []);
  transition = advancePreparation(transition.state, "700 Euro.", []);
  assert.match(transition.instruction, /Geburtsdatum/);

  transition = advancePreparation(transition.state, "Mai 1987.", []);
  assert.match(transition.instruction, /dieselbe Vorbereitungsfrage/);

  transition = advancePreparation(transition.state, "2. Mai 1987.", []);
  assert.match(transition.instruction, /laufende Behandlungen/);
});

test("completes only the six required PKV questions before email", () => {
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  for (const answer of ["gesetzlich", "AOK", "700 Euro", "2. Mai 1987", "Nein", "Nein"]) {
    transition = advancePreparation(transition.state, answer, []);
  }
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(transition.instruction, /E-Mail-Adresse/);
});