import { decideAppointment } from "./appointment-controller.js";
import { advanceContactRouting, createContactRoutingState, type ContactRoutingStage } from "./contact-routing-controller.js";
import { classifyConversationEvent, type ConversationEvent } from "./conversation-event-controller.js";
import { assessPkvConversation, type ConversationTurn, type PkvConversationStage } from "./pkv-conversation-controller.js";

export type EvaluationViolationCode =
  | "multiple_questions"
  | "repeated_question"
  | "early_scheduling"
  | "high_latency";

export type EvaluationTurn = ConversationTurn & { latencyMs?: number };

export type DialogScenario = {
  id: string;
  category: string;
  turns: EvaluationTurn[];
  targetName?: string;
  negativeControl?: boolean;
  latencyLimitMs?: number;
  appointment?: {
    freeSlotsPrompt?: string;
    slotPhrase?: string;
  };
  expected: {
    pkvStage?: PkvConversationStage;
    eventType?: ConversationEvent["type"];
    eventKind?: "no_time" | "existing_advisor" | "send_information" | "skepticism" | "other";
    routingStage?: ContactRoutingStage;
    appointmentAllowed?: boolean;
    violationCodes?: EvaluationViolationCode[];
  };
};

export type DialogEvaluationResult = {
  id: string;
  category: string;
  passed: boolean;
  mismatches: string[];
  violationCodes: EvaluationViolationCode[];
};

export type DialogEvaluationSummary = {
  scenarios: number;
  passed: number;
  failed: number;
  qualityScore: number;
  byCategory: Record<string, { scenarios: number; passed: number }>;
  results: DialogEvaluationResult[];
};

function normalizedQuestions(text: string): string[] {
  return (text.match(/[^?]+\?/g) || [])
    .map((question) => question.toLowerCase().replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function collectViolations(scenario: DialogScenario): EvaluationViolationCode[] {
  const violations = new Set<EvaluationViolationCode>();
  const seenQuestions = new Set<string>();
  const latencyLimitMs = scenario.latencyLimitMs ?? 2500;

  for (let index = 0; index < scenario.turns.length; index += 1) {
    const turn = scenario.turns[index];
    if (turn.role !== "assistant") continue;
    const questions = normalizedQuestions(turn.text);
    if (questions.length > 1) violations.add("multiple_questions");
    for (const question of questions) {
      if (seenQuestions.has(question)) violations.add("repeated_question");
      seenQuestions.add(question);
    }
    if ((turn.latencyMs ?? 0) > latencyLimitMs) violations.add("high_latency");

    const scheduling = /\b(?:termin\s+(?:anbieten|vereinbaren|abstimmen)|vormittag\s+oder\s+nachmittag|welcher\s+termin|wann\s+passt|zwei\s+(?:termine|vorschläge))\b/i.test(turn.text);
    if (scheduling) {
      const priorTurns = scenario.turns.slice(0, index);
      if (assessPkvConversation(priorTurns).stage !== "ready_to_schedule") {
        violations.add("early_scheduling");
      }
    }
  }

  return [...violations].sort();
}

function evaluateRouting(scenario: DialogScenario): ContactRoutingStage {
  let state = createContactRoutingState(scenario.targetName);
  for (const turn of scenario.turns) {
    if (turn.role === "user") state = advanceContactRouting(state, turn.text);
  }
  return state.stage;
}

export function evaluateDialogScenario(scenario: DialogScenario): DialogEvaluationResult {
  const mismatches: string[] = [];
  const violationCodes = collectViolations(scenario);
  const expectedViolations = [...(scenario.expected.violationCodes || [])].sort();
  if (JSON.stringify(violationCodes) !== JSON.stringify(expectedViolations)) {
    mismatches.push(`violations expected=${expectedViolations.join(",") || "none"} actual=${violationCodes.join(",") || "none"}`);
  }

  if (scenario.expected.pkvStage) {
    const stage = assessPkvConversation(scenario.turns).stage;
    if (stage !== scenario.expected.pkvStage) mismatches.push(`pkvStage expected=${scenario.expected.pkvStage} actual=${stage}`);
  }

  const lastUserText = [...scenario.turns].reverse().find((turn) => turn.role === "user")?.text;
  if (scenario.expected.eventType && lastUserText !== undefined) {
    const event = classifyConversationEvent(lastUserText);
    if (event.type !== scenario.expected.eventType) mismatches.push(`eventType expected=${scenario.expected.eventType} actual=${event.type}`);
    if (scenario.expected.eventKind) {
      const actualKind = event.type === "objection" ? event.kind : "none";
      if (actualKind !== scenario.expected.eventKind) mismatches.push(`eventKind expected=${scenario.expected.eventKind} actual=${actualKind}`);
    }
  }

  if (scenario.expected.routingStage) {
    const routingStage = evaluateRouting(scenario);
    if (routingStage !== scenario.expected.routingStage) mismatches.push(`routingStage expected=${scenario.expected.routingStage} actual=${routingStage}`);
  }

  if (scenario.expected.appointmentAllowed !== undefined) {
    const appointment = decideAppointment({
      turns: scenario.turns,
      topicKind: "pkv",
      freeSlotsPrompt: scenario.appointment?.freeSlotsPrompt,
      slotPhrase: scenario.appointment?.slotPhrase,
    });
    if (appointment.ok !== scenario.expected.appointmentAllowed) {
      mismatches.push(`appointmentAllowed expected=${scenario.expected.appointmentAllowed} actual=${appointment.ok}`);
    }
  }

  return {
    id: scenario.id,
    category: scenario.category,
    passed: mismatches.length === 0,
    mismatches,
    violationCodes,
  };
}

export function evaluateDialogScenarios(scenarios: DialogScenario[]): DialogEvaluationSummary {
  const results = scenarios.map(evaluateDialogScenario);
  const byCategory: DialogEvaluationSummary["byCategory"] = {};
  for (const result of results) {
    const category = byCategory[result.category] || { scenarios: 0, passed: 0 };
    category.scenarios += 1;
    if (result.passed) category.passed += 1;
    byCategory[result.category] = category;
  }
  const qualityResults = results.filter((_, index) => !scenarios[index].negativeControl);
  const qualityPassed = qualityResults.filter((result) => result.passed && result.violationCodes.length === 0).length;
  return {
    scenarios: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    qualityScore: qualityResults.length ? Math.round((qualityPassed / qualityResults.length) * 100) : 100,
    byCategory,
    results,
  };
}