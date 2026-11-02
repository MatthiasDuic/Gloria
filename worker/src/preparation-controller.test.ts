import assert from "node:assert/strict";
import test from "node:test";
import { APPOINTMENT_FAREWELL_TEXT, advancePreparation, beginPreparation, buildPreparationQuestions, createPreparationState, createPreparationStateForCall } from "./preparation-controller.js";
import type { ConversationTurn } from "./pkv-conversation-controller.js";

const policy = {
  topic: "private Krankenversicherung",
};
const knownStatusTurns: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert." }];

test("digital bookings mention the meeting link once while personal bookings continue unchanged", () => {
  for (const questions of ["", "Welche Themen sind Ihnen wichtig?"]) {
    const state = createPreparationState({ topic: "Test", preparationQuestions: questions });
    const personal = beginPreparation(state, "Montag um zehn Uhr", [], "Beim Kunden vor Ort");
    const digital = beginPreparation(state, "Montag um zehn Uhr", [], "Microsoft Teams");
    const unchanged = beginPreparation(state, "Montag um zehn Uhr", []);
    assert.deepEqual(personal, unchanged);
    assert.equal(digital.state.stage, personal.state.stage);
    assert.match(digital.speechText || "", /ist bestätigt\. Den Link zum Meeting erhalten Sie in der Bestätigungsmail\./);
    assert.equal(digital.speechText?.replace(" Den Link zum Meeting erhalten Sie in der Bestätigungsmail.", ""), personal.speechText);
    assert.doesNotMatch(personal.speechText || "", /Meeting|Link/);
  }
  const state = createPreparationState({
    topic: "Test", preparationQuestions: "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
  });
  const digital = beginPreparation(state, "Montag um zehn Uhr", knownStatusTurns, "Microsoft Teams");
  assert.equal(digital.state.stage, "awaiting_email");
  assert.match(digital.speechText || "", /Link zum Meeting.*bereits geklärten Angaben/);
});

test("completes configured closing questions after booking without reasking the known 480 Euro contribution", () => {
  const turns: ConversationTurn[] = [
    { role: "assistant", text: "Welchen monatlichen Beitrag wenden Sie aktuell auf?" },
    { role: "user", text: "480 Euro." },
  ];
  const state = createPreparationStateForCall("pkv", "private Krankenversicherung", {
    preparationQuestions: [
      "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
      "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
      "Wie hoch ist Ihr aktueller Monatsbeitrag?",
      "Darf ich Ihr Geburtsdatum aufnehmen?",
      "Gibt es aktuell laufende Behandlungen?",
      "Gibt es bestehende Diagnosen, die wir berücksichtigen sollten?",
    ].join("\n"),
  });
  let transition = beginPreparation(state, "Donnerstag um elf Uhr", turns);
  assert.equal(transition.state.stage, "awaiting_consent");
  assert.match(transition.speechText || "", /freiwillige|Gesundheitsangaben/);
  const answers = ["Ja.", "Privat.", "Bei der Allianz versichert.", "12. Juli 1974", "Nein.", "Nein."];
  const questions: string[] = [];
  for (const answer of answers) {
    turns.push({ role: "user", text: answer });
    transition = advancePreparation(transition.state, answer, turns);
    if (transition.speechText) questions.push(transition.speechText);
  }
  assert.equal(transition.state.stage, "awaiting_email");
  assert.match(questions.join("\n"), /Geburtsdatum/);
  assert.match(questions.join("\n"), /Behandlungen/);
  assert.match(questions.join("\n"), /Diagnosen/);
  assert.doesNotMatch(questions.join("\n"), /Monatsbeitrag/);
  transition = advancePreparation(transition.state, "neumann@example.org", turns);
  assert.equal(transition.state.stage, "completed");
  assert.equal(transition.speechText, APPOINTMENT_FAREWELL_TEXT);
});

test("uses campaign-specific questions in their configured order", () => {
  assert.deepEqual(buildPreparationQuestions({
    topic: "private Krankenversicherung",
    preparationQuestions: "1. Wie hoch ist Ihr Monatsbeitrag?\n2. Gibt es bekannte Diagnosen?\n- Nehmen Sie Medikamente?",
  }), [
    "Wie hoch ist Ihr Monatsbeitrag?",
    "Gibt es bekannte Diagnosen?",
    "Nehmen Sie Medikamente?",
  ]);
});

test("uses generic required questions as preparation questions when no override exists", () => {
  assert.deepEqual(buildPreparationQuestions({
    topic: "Betriebliche Krankenversicherung",
    requiredQuestions: "Wie viele Mitarbeitende beschäftigen Sie?\nWelche E-Mail-Adresse sollen wir für die Terminbestätigung nutzen?",
  }), ["Wie viele Mitarbeitende beschäftigen Sie?"]);
});

test("asks for consent and skips facts already answered in the call", () => {
  const turns: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert und zahle 1000 Euro im Monat." }];
  let transition = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", turns);
  assert.equal(transition.state.stage, "awaiting_consent");
  assert.match(transition.speechText || "", /Termin Mittwoch um 11 Uhr ist bestätigt/);

  transition = advancePreparation(transition.state, "Ja, gerne.", turns);
  assert.equal(transition.state.stage, "asking");
  assert.equal(transition.state.currentQuestionIndex, 1);
  assert.match(transition.instruction, /Krankenversicherer/);
  assert.match(transition.instruction, /Sage keine Einleitung/);
  assert.equal(transition.speechText, "Bei welchem Krankenversicherer sind Sie derzeit versichert?");
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

test("accepts natural consent phrasing without asking for another confirmation", () => {
  const started = beginPreparation(createPreparationState(policy), "Mittwoch um 11 Uhr", []);
  const transition = advancePreparation(started.state, "Wie gesagt, es passt, wenn es schnell geht.", []);
  assert.equal(transition.state.stage, "asking");
  assert.match(transition.speechText || "", /privat oder gesetzlich/);
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

test("accepts naturally spoken German birth dates", () => {
  const knownInsurance: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert und bei der Debeka." }];
  for (const birthDate of [
    "Zwölfter Siebter neunzehnhundertvierundsiebzig.",
    "Zwölfter Juli neunzehnhundertvierundsiebzig.",
  ]) {
    let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", knownInsurance);
    transition = advancePreparation(transition.state, "Ja.", knownInsurance);
    transition = advancePreparation(transition.state, birthDate, []);
    assert.match(transition.speechText || "", /Wie groß sind Sie/);
  }
});

test("asks for explicit consent when configured preparation questions include health data", () => {
  const transition = beginPreparation(createPreparationState({
    topic: "Krankenversicherung",
    preparationQuestions: "Gibt es bekannte Diagnosen?",
  }), "Montag um 10 Uhr", []);

  assert.match(transition.speechText || "", /Gesundheitsangaben/);
  assert.match(transition.speechText || "", /freiwillig/);
});

test("skips an invalid preparation answer after three attempts", () => {
  const knownInsurance: ConversationTurn[] = [{ role: "user", text: "Ich bin privat versichert und bei der Debeka." }];
  let transition = beginPreparation(createPreparationState(policy), "Donnerstag um 15 Uhr", knownInsurance);
  transition = advancePreparation(transition.state, "Ja.", knownInsurance);
  transition = advancePreparation(transition.state, "Zwölf.", []);
  assert.equal(transition.state.questionRetryCount, 1);
  transition = advancePreparation(transition.state, "Ja.", []);
  assert.equal(transition.state.questionRetryCount, 2);
  transition = advancePreparation(transition.state, "Nein.", []);
  assert.equal(transition.state.questionRetryCount, 0);
  assert.match(transition.speechText || "", /Das überspringen wir.*Wie groß sind Sie/);
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
  assert.match(transition.instruction, /Terminbestätigung zukommen/);
  assert.equal(
    transition.speechText,
    "Vielen Dank für das Gespräch, ich lasse Ihnen die Terminbestätigung zukommen. Sollten Sie vorab Fragen haben, können Sie gerne auf die Mail antworten. Auf Wiederhören.",
  );
  assert.doesNotMatch(transition.instruction, /Haben Sie noch eine Frage zum Ablauf oder zum Termin/);
});

test("initializes PKV completion questions synchronously from the call topic", () => {
  const state = createPreparationStateForCall("pkv", "Beitragsentwicklung in der Gesundheitsversorgung");
  assert.equal(state.stage, "inactive");
  assert.equal(state.questions.length, 7);
  assert.match(state.questions[0], /privat oder gesetzlich/);
  assert.match(state.questions[6], /Diagnosen/);
});