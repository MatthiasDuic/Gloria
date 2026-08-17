import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDialogScenario, evaluateDialogScenarios, type DialogScenario } from "./dialog-evaluation.js";
import { DIALOG_EVALUATION_SCENARIOS } from "./dialog-evaluation-scenarios.js";

test("passes a clean deterministic PKV stage scenario", () => {
  const result = evaluateDialogScenario({
    id: "clean-stage",
    category: "flow",
    turns: [{ role: "user", text: "Ich bin privat versichert." }],
    expected: { pkvStage: "need_contribution" },
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.violationCodes, []);
});

test("detects quality violations as explicit negative controls", () => {
  const scenario: DialogScenario = {
    id: "negative-multiple-questions",
    category: "quality-control",
    negativeControl: true,
    turns: [{ role: "assistant", text: "Sind Sie privat versichert? Wie hoch ist Ihr Beitrag?" }],
    expected: { violationCodes: ["multiple_questions"] },
  };
  const summary = evaluateDialogScenarios([scenario]);
  assert.equal(summary.failed, 0);
  assert.deepEqual(summary.results[0].violationCodes, ["multiple_questions"]);
  assert.equal(summary.qualityScore, 100);
});

test("passes the complete realistic dialog evaluation matrix", () => {
  const summary = evaluateDialogScenarios(DIALOG_EVALUATION_SCENARIOS);
  assert.ok(summary.scenarios >= 35);
  assert.equal(summary.failed, 0, summary.results.filter((result) => !result.passed).map((result) => `${result.id}: ${result.mismatches.join("; ")}`).join("\n"));
  assert.equal(summary.qualityScore, 100);
  assert.equal(summary.byCategory["pkv-flow"].passed, summary.byCategory["pkv-flow"].scenarios);
  assert.equal(summary.byCategory.appointments.passed, summary.byCategory.appointments.scenarios);
});