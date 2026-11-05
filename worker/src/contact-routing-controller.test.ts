import assert from "node:assert/strict";
import test from "node:test";
import { advanceContactRouting, buildGatekeeperReason, createContactRoutingState, instructionForContactRouting, isGatekeeperReasonQuestion } from "./contact-routing-controller.js";

test("recognizes initial recorded welcomes, hold music and advertising without starting a conversation", () => {
  let state = createContactRoutingState("Herr Neumann");
  for (const text of [
    "Herzlich willkommen bei Beispiel.",
    "Vielen Dank für Ihren Anruf.",
    "[Musik]",
    "Informieren Sie sich inzwischen über unsere günstigen Angebote.",
    "Ihr Anruf ist uns wichtig.",
  ]) {
    state = advanceContactRouting(state, text);
    assert.equal(state.stage, "waiting_for_transfer", text);
  }
  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("machine detection remains active after an apparent human greeting or confirmed decision maker", () => {
  for (const stage of ["confirming_decision_maker", "decision_maker"] as const) {
    const state = { ...createContactRoutingState("Herr Neumann"), stage };
    assert.equal(advanceContactRouting(state, "Bitte sprechen Sie nach dem Ton.").stage, "voicemail");
    assert.equal(advanceContactRouting(state, "Alle Mitarbeiter sind im Gespräch. Bitte warten Sie.").stage, "waiting_for_transfer");
  }
});

test("a new receptionist after a transfer is not dismissed for the previous receptionist's request", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Neumann"), stage: "waiting_for_transfer",
    gatekeeperRequestMade: true, gatekeeperReasonGiven: true,
  }, "Empfang, hier ist Frau Müller. Guten Tag.");
  assert.equal(state.stage, "gatekeeper");
  assert.equal(state.gatekeeperRequestMade, false);
  assert.equal(state.gatekeeperReasonGiven, false);
});

test("uses the healthcare contribution reason at reception without disclosing a private insurance status", () => {
  const reason = buildGatekeeperReason("private Krankenversicherung", "Herr Schneider");
  assert.equal(reason, "Es geht um die langfristige Beitragsentwicklung in der Gesundheitsversorgung. Ist Herr Schneider gerade erreichbar?");
  assert.doesNotMatch(reason, /privat|krankenversicherung/i);
  assert.equal(buildGatekeeperReason("PKV"), "Es geht um die langfristige Beitragsentwicklung in der Gesundheitsversorgung.");
  assert.equal(buildGatekeeperReason("Energie"), "Es geht um das Thema Energie.");
});

test("recognizes a gatekeeper's reason question without confusing availability or refusal", () => {
  for (const text of ["Worum geht es?", "Um was geht es denn?", "Was ist der Anlass?", "Was ist denn Ihr Anliegen?", "Weshalb rufen Sie an?"]) {
    assert.equal(isGatekeeperReasonQuestion(text), true, text);
  }
  for (const text of ["Herr Schneider ist nicht da.", "Kein Interesse.", "Einen Moment, ich verbinde."]) {
    assert.equal(isGatekeeperReasonQuestion(text), false, text);
  }
});

test("a reason question after the transfer request stays at reception without another identity check", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Schneider"),
    stage: "gatekeeper",
    gatekeeperRequestMade: true,
  }, "Worum geht es denn?");
  assert.equal(state.stage, "gatekeeper");
  assert.equal(state.gatekeeperRequestMade, true);
});

test("keeps the fachgespraech behind the gatekeeper boundary", () => {
  let state = createContactRoutingState("Herr Neumann");
  state = advanceContactRouting(state, "Guten Tag, Zentrale der Beispiel GmbH.");
  assert.equal(state.stage, "gatekeeper");
  assert.match(instructionForContactRouting(state), /Noch kein PKV-Fachgespräch/);

  state = advanceContactRouting(state, "Einen Moment bitte, ich verbinde Sie.");
  assert.equal(state.stage, "waiting_for_transfer");

  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("stays silent throughout queue announcements until a person answers", () => {
  let state = createContactRoutingState("Herr Neumann");
  state = advanceContactRouting(state, "Guten Tag, Zentrale der Beispiel GmbH.");
  assert.equal(state.stage, "gatekeeper");

  state = advanceContactRouting(state, "Einen Moment bitte, ich verbinde Sie.");
  assert.equal(state.stage, "waiting_for_transfer");
  assert.match(instructionForContactRouting(state), /Sprich nicht/);

  state = advanceContactRouting(state, "Alle Mitarbeiter sind im Gespräch. Bitte warten Sie.");
  assert.equal(state.stage, "waiting_for_transfer");

  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("answers a digital receptionist that asks for the caller's name instead of waiting as in a queue", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Schwab"),
    "Herzlich willkommen und Glück auf! Mein Name ist Rosi Ruhrpott. Ich bin die digitale Assistentin von RAVES Immobilien und Schwab Hausverwaltung und helfe Ihnen dabei, Sie schnell mit dem richtigen Ansprechpartner zu verbinden. Wie lautet Ihr Name und wie kann ich Ihnen weiterhelfen?",
  );
  assert.equal(state.stage, "gatekeeper");
  assert.equal(advanceContactRouting(createContactRoutingState("Herr Schwab"), "Herzlich willkommen. Bitte warten Sie, wie kann ich Ihnen helfen?").stage, "waiting_for_transfer");
});

test("treats common short German phone greetings as a human contact", () => {
  for (const text of ["Ja, Müller?", "Müller, ja?", "Hallo, Schmidt.", "Ja bitte?"]) {
    assert.equal(advanceContactRouting(createContactRoutingState("Herr Neumann"), text).stage, "confirming_decision_maker", text);
  }
});

test("recognizes a self-identified decision maker without repeating the pitch", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Frau Wagner"),
    "Ja, das bin ich selbst.",
  );
  assert.equal(state.stage, "decision_maker");
});

test("does not treat a bare target-name mention as self-identification", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Ich stelle Sie zu Herrn Neumann durch.",
  );
  assert.equal(state.stage, "gatekeeper");
});

test("confirms an unclear name match once and accepts a clear yes", () => {
  const initial = advanceContactRouting(
    createContactRoutingState("Herr Biletzki"),
    "Biletzki, guten Tag.",
  );
  assert.equal(initial.stage, "confirming_decision_maker");
  assert.match(instructionForContactRouting(initial), /genau einmal höflich/);

  const confirmed = advanceContactRouting(initial, "Ja, genau, den haben Sie am Apparat.");
  assert.equal(confirmed.stage, "decision_maker");
});

test("routes a denied identity check to the gatekeeper without repeating the name check", () => {
  const initial = advanceContactRouting(
    createContactRoutingState("Herr Biletzki"),
    "Biletzki, guten Tag.",
  );
  const denied = advanceContactRouting(initial, "Nein, ich bin aus dem Empfang.");

  assert.equal(denied.stage, "gatekeeper");
  assert.match(instructionForContactRouting(denied), /freundlich um die Verbindung/);
});

test("does not repeat an already made transfer request", () => {
  const state = {
    ...createContactRoutingState("Herr Biletzki"),
    stage: "gatekeeper" as const,
    gatekeeperRequestMade: true,
  };

  assert.match(instructionForContactRouting(state), /Wiederhole die Bitte nicht wortgleich/);
});

test("does not identify a target who is mentioned as unavailable", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Herr Neumann ist gerade nicht da.",
  );
  assert.equal(state.stage, "gatekeeper");
});

test("recognizes a direct name-based decision maker phrase", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Ja, hier ist Herr Neumann.",
  );
  assert.equal(state.stage, "decision_maker");

  const state2 = advanceContactRouting(
    createContactRoutingState("Frau Wagner"),
    "Ich bin Frau Wagner.",
  );
  assert.equal(state2.stage, "decision_maker");
});

test("treats a company greeting from another named person as a gatekeeper", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Musterbau GmbH, mein Name ist Müller. Was kann ich für Sie tun?",
  );
  assert.equal(state.stage, "gatekeeper");
});

test("makes voicemail a terminal routing state", () => {
  let state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Bitte hinterlassen Sie eine Nachricht nach dem Signalton.",
  );
  assert.equal(state.stage, "voicemail");

  state = advanceContactRouting(state, "Neumann am Apparat.");
  assert.equal(state.stage, "voicemail");
});