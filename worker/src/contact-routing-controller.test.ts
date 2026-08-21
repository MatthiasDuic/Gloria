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

test("makes voicemail a terminal routing state", () => {
  let state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Bitte hinterlassen Sie eine Nachricht nach dem Signalton.",
  );
  assert.equal(state.stage, "voicemail");

  state = advanceContactRouting(state, "Neumann am Apparat.");
  assert.equal(state.stage, "voicemail");
});