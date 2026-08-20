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

test("asks the configured follow-up after yes to a hospital question", () => {
  const hospitalPolicy = { topic: "PKV", requiredQuestions: "Gab es stationäre Aufenthalte im Krankenhaus?" };
  let transition = beginPreparation(createPreparationState(hospitalPolicy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.equal(transition.state.stage, "asking");
  assert.match(transition.instruction, /Grund für den stationären Aufenthalt/);
});

test("collects multiple allergies adaptively before continuing", () => {
  const allergyPolicy = { topic: "PKV", requiredQuestions: "Bestehen bei Ihnen bekannte Allergien?\nWie hoch ist Ihr Monatsbeitrag?" };
  let transition = beginPreparation(createPreparationState(allergyPolicy), "Freitag um 10 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welche Allergie/);

  transition = advancePreparation(transition.state, "Pollenallergie", []);
  assert.match(transition.instruction, /weitere Allergien/);

  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welche Allergie/);

  transition = advancePreparation(transition.state, "Hausstaub", []);
  assert.match(transition.instruction, /weitere Allergien/);

  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Monatsbeitrag/);
});

test("collects multiple medications adaptively", () => {
  const policyWithMeds = { topic: "PKV", requiredQuestions: "Nehmen Sie regelmäßig Medikamente ein?\nWie hoch ist Ihr Monatsbeitrag?" };
  let transition = beginPreparation(createPreparationState(policyWithMeds), "Freitag um 10 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welche Medikamente/);

  transition = advancePreparation(transition.state, "L-Thyroxin", []);
  assert.match(transition.instruction, /weitere Medikamente/);

  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welche Medikamente/);

  transition = advancePreparation(transition.state, "Metformin", []);
  assert.match(transition.instruction, /weitere Medikamente/);

  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Monatsbeitrag/);
});

test("collects multiple inpatient stays adaptively", () => {
  const policyWithInpatient = { topic: "PKV", requiredQuestions: "Gab es stationäre Aufenthalte im Krankenhaus?\nWie hoch ist Ihr Monatsbeitrag?" };
  let transition = beginPreparation(createPreparationState(policyWithInpatient), "Freitag um 10 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Grund für den stationären Aufenthalt/);

  transition = advancePreparation(transition.state, "Blinddarm", []);
  assert.match(transition.instruction, /weitere stationäre Aufenthalte/);

  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Grund für den stationären Aufenthalt/);

  transition = advancePreparation(transition.state, "Knie-OP", []);
  assert.match(transition.instruction, /weitere stationäre Aufenthalte/);

  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Monatsbeitrag/);
});

test("collects multiple psychological treatments adaptively", () => {
  const policyWithPsych = { topic: "PKV", requiredQuestions: "Gab es in den letzten zehn Jahren psychische Behandlungen?\nWie hoch ist Ihr Monatsbeitrag?" };
  let transition = beginPreparation(createPreparationState(policyWithPsych), "Freitag um 10 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /psychischen Behandlung/);

  transition = advancePreparation(transition.state, "Verhaltenstherapie", []);
  assert.match(transition.instruction, /weitere psychische Behandlungen/);

  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /psychischen Behandlung/);

  transition = advancePreparation(transition.state, "Coaching", []);
  assert.match(transition.instruction, /weitere psychische Behandlungen/);

  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Monatsbeitrag/);
});

test("collects multiple dental entries adaptively", () => {
  const policyWithDental = { topic: "PKV", requiredQuestions: "Fehlen aktuell Zähne oder ist Zahnersatz geplant?\nWie hoch ist Ihr Monatsbeitrag?" };
  let transition = beginPreparation(createPreparationState(policyWithDental), "Freitag um 10 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welcher Zahnersatz/);

  transition = advancePreparation(transition.state, "Implantat im Oberkiefer", []);
  assert.match(transition.instruction, /weiteren fehlenden oder geplanten Zahnersatz/);

  transition = advancePreparation(transition.state, "Ja.", []);
  assert.match(transition.instruction, /Welcher Zahnersatz/);

  transition = advancePreparation(transition.state, "Brücke links", []);
  assert.match(transition.instruction, /weiteren fehlenden oder geplanten Zahnersatz/);

  transition = advancePreparation(transition.state, "Nein.", []);
  assert.match(transition.instruction, /Monatsbeitrag/);
});

test("completes the list and moves to the confirmation email", () => {
  const oneQuestionPolicy = { topic: "PKV", requiredQuestions: "Wie groß sind Sie?" };
  let transition = beginPreparation(createPreparationState(oneQuestionPolicy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  transition = advancePreparation(transition.state, "Einen Meter achtzig.", []);
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(transition.instruction, /E-Mail-Adresse/);

  transition = advancePreparation(transition.state, "kunde@example.de", []);
  assert.equal(transition.state.stage, "awaiting_final_questions");
  assert.match(transition.instruction, /Haben Sie noch eine Frage/);

  transition = advancePreparation(transition.state, "Nein, keine Fragen.", []);
  assert.equal(transition.state.stage, "completed");
  assert.match(transition.instruction, /verabschiede dich höflich/);
  assert.match(transition.instruction, /end_call/);
});

test("completes the full health preparation flow through farewell", () => {
  const fullPolicy = {
    topic: "private Krankenversicherung",
    pkvHealthQuestions: [
      "Darf ich Ihr Geburtsdatum aufnehmen?",
      "Könnten Sie mir Ihre Körpergröße nennen?",
      "Wie ist Ihr aktuelles Gewicht?",
      "Bei welchem Krankenversicherer sind Sie versichert?",
      "Wie hoch ist Ihr Monatsbeitrag?",
      "Gibt es laufende Behandlungen oder Diagnosen?",
      "Nehmen Sie regelmäßig Medikamente ein?",
      "Gab es stationäre Aufenthalte im Krankenhaus?",
      "Gab es psychische Behandlungen?",
      "Fehlen Zähne oder ist Zahnersatz geplant?",
      "Bestehen bekannte Allergien?",
    ].join("\n"),
  };
  let transition = beginPreparation(createPreparationState(fullPolicy), "Donnerstag um 15 Uhr", []);
  transition = advancePreparation(transition.state, "Ja.", []);
  const answers = [
    "2. Mai 1987",
    "Ein Meter achtzig",
    "80 Kilogramm",
    "Debeka",
    "1200 Euro",
    "Nein",
    "Nein",
    "Nein",
    "Nein",
    "Nein",
    "Nein",
  ];
  for (const answer of answers) {
    transition = advancePreparation(transition.state, answer, []);
  }
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(transition.instruction, /E-Mail-Adresse/);

  transition = advancePreparation(transition.state, "neumann@example.de", []);
  assert.equal(transition.state.stage, "awaiting_final_questions");
  assert.match(transition.instruction, /Haben Sie noch eine Frage/);

  transition = advancePreparation(transition.state, "Nein, wir können das Gespräch beenden.", []);
  assert.equal(transition.state.stage, "completed");
  assert.match(transition.instruction, /verabschiede dich höflich/);
});