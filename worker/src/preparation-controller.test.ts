import assert from "node:assert/strict";
import test from "node:test";
import { advancePreparation, beginPreparation, buildPreparationQuestions, createPreparationState, createPreparationStateForCall } from "./preparation-controller.js";
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
    "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
    "Wie groß sind Sie?",
    "Wie viel wiegen Sie derzeit?",
    "Sind Sie derzeit in Behandlung?",
    "Bestehen bekannte Diagnosen?",
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

test("does not mistake appointment location for a known health insurer", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "Ich bin gesetzlich versichert." },
    { role: "user", text: "Der Termin kann bei mir vor Ort stattfinden." },
  ];
  let transition = beginPreparation(createPreparationState(policy), "Montag um 10 Uhr", turns);
  transition = advancePreparation(transition.state, "Ja, gerne.", turns);
  assert.equal(transition.state.currentQuestionIndex, 1);
  assert.match(transition.instruction, /Krankenversicherer/);
});

test("asks for insurance status, insurer, and all required health details", () => {
  assert.deepEqual(buildPreparationQuestions({ topic: "private Krankenversicherung" }), [
    "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
    "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
    "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
    "Wie groß sind Sie?",
    "Wie viel wiegen Sie derzeit?",
    "Sind Sie derzeit in Behandlung?",
    "Bestehen bekannte Diagnosen?",
  ]);
});

test("uses the same compact health precheck regardless of insurance status", () => {
  assert.deepEqual(buildPreparationQuestions({ topic: "private Krankenversicherung" }), [
    "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
    "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
    "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
    "Wie groß sind Sie?",
    "Wie viel wiegen Sie derzeit?",
    "Sind Sie derzeit in Behandlung?",
    "Bestehen bekannte Diagnosen?",
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
  const knownInsurance: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert und bei der Debeka." }];
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", knownInsurance);
  transition = advancePreparation(transition.state, "Ja.", knownInsurance);
  transition = advancePreparation(transition.state, "Mai 1987.", []);
  assert.match(transition.instruction, /dieselbe Vorbereitungsfrage/);

  transition = advancePreparation(transition.state, "2. Mai 1987.", []);
  assert.match(transition.instruction, /Wie groß sind Sie/);
  transition = advancePreparation(transition.state, "Ja.", knownInsurance);
  assert.match(transition.instruction, /dieselbe Vorbereitungsfrage/);
  transition = advancePreparation(transition.state, "1,75 Meter.", []);
  assert.match(transition.instruction, /Wie viel wiegen Sie/);
  transition = advancePreparation(transition.state, "75 Kilogramm.", []);
  assert.match(transition.instruction, /Sind Sie derzeit in Behandlung/);
  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Bestehen bekannte Diagnosen/);
});

test("accepts naturally spoken height and weight values", () => {
  const knownInsurance: ConversationTurn[] = [
    { role: "user", text: "Ich bin privat versichert." },
    { role: "user", text: "Ich bin bei der Debeka versichert." },
  ];
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", knownInsurance);
  transition = advancePreparation(transition.state, "Ja.", knownInsurance);
  transition = advancePreparation(transition.state, "2. Mai 1987.", []);
  transition = advancePreparation(transition.state, "Ein Meter achtundachtzig.", []);
  assert.match(transition.instruction, /Wie viel wiegen Sie/);
  transition = advancePreparation(transition.state, "Fünfundachtzig Kilo.", []);
  assert.match(transition.instruction, /Sind Sie derzeit in Behandlung/);
});

test("completes all required PKV preparation questions before email", () => {
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  for (const answer of ["privat", "Debeka", "2. Mai 1987", "175 cm", "75 kg", "Nein", "Nein"]) {
    transition = advancePreparation(transition.state, answer, []);
  }
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(transition.instruction, /E-Mail-Adresse/);

  transition = advancePreparation(transition.state, "kunde@example.de", []);
  assert.equal(transition.state.stage, "completed");
  assert.match(transition.instruction, /Vielen Dank für das Gespräch\. Auf Wiederhören\./);
  assert.doesNotMatch(transition.instruction, /Haben Sie noch eine Frage zum Ablauf oder zum Termin/);
});

test("initializes PKV completion questions synchronously from the call topic", () => {
  const state = createPreparationStateForCall("pkv", "Beitragsentwicklung in der Gesundheitsversorgung");
  assert.equal(state.stage, "inactive");
  assert.equal(state.questions.length, 7);
  assert.match(state.questions[0], /privat oder gesetzlich/);
  assert.match(state.questions[6], /Diagnosen/);
});