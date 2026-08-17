import { DIALOG_EVALUATION_SCENARIOS } from "./dialog-evaluation-scenarios.js";
import { evaluateDialogScenarios } from "./dialog-evaluation.js";

const summary = evaluateDialogScenarios(DIALOG_EVALUATION_SCENARIOS);
console.log(`Dialog evaluation: ${summary.passed}/${summary.scenarios} scenarios passed`);
console.log(`Quality score: ${summary.qualityScore}/100`);
for (const [category, result] of Object.entries(summary.byCategory)) {
  console.log(`- ${category}: ${result.passed}/${result.scenarios}`);
}
for (const result of summary.results.filter((entry) => !entry.passed)) {
  console.error(`FAIL ${result.id}: ${result.mismatches.join("; ")}`);
}
if (summary.failed > 0) process.exitCode = 1;