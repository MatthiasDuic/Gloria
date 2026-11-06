import assert from "node:assert/strict";
import test from "node:test";
import { buildGatekeeperObjectionReply } from "./call-flow-states";
import type { TokenizedCallState } from "./call-state-token";

const state: TokenizedCallState = {
  company: "Beispiel GmbH",
  contactName: "Herr Neumann",
  topic: "Energie",
  step: "intro",
  consent: "no",
  turn: 0,
  transcript: "",
  contactRole: "gatekeeper",
  issuedAt: 0,
  expiresAt: 1,
};

test("answers reception questions without asking again to be connected", () => {
  for (const question of ["Worum geht es?", "Darf ich fragen, worum es geht?", "Um was handelt es sich?"]) {
    const reason = buildGatekeeperObjectionReply(state, question);
    assert.ok(reason);
    assert.match(reason, /Strom- und Gaskonditionen/);
    assert.doesNotMatch(reason, /verbinden|weiterleiten|\?/i);
  }

  const identity = buildGatekeeperObjectionReply(state, "Wer sind Sie?");
  assert.ok(identity);
  assert.match(identity, /Gloria.*Agentur Duic/);
  assert.doesNotMatch(identity, /verbinden|weiterleiten|\?/i);
});
