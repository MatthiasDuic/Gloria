import assert from "node:assert/strict";
import test from "node:test";
import { advanceContactRouting, createContactRoutingState, instructionForContactRouting } from "./contact-routing-controller.js";

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