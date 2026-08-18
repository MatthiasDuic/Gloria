import type { DialogScenario, EvaluationTurn } from "./dialog-evaluation.js";

const FREE_SLOTS = "FREIE TERMIN-VORSCHLÄGE:\n- Mittwoch, 26. August um 11:00 Uhr\n- Donnerstag, 27. August um 15:30 Uhr";

function readyPkvTurns(extra: EvaluationTurn[] = []): EvaluationTurn[] {
  return [
    { role: "user", text: "Ich bin privat versichert und zahle 1000 Euro im Monat." },
    { role: "assistant", text: "Bei rund vier Prozent pro Jahr wären es in zehn Jahren ungefähr 1480 Euro." },
    { role: "assistant", text: "Wie fühlt sich diese Entwicklung bis zum Ruhestand für Sie und Ihre Planung an?" },
    { role: "user", text: "Das wäre langfristig eine deutliche Belastung." },
    { role: "assistant", text: "Herr Duic zeigt Ihre persönliche Entwicklung und prüfbare Optionen. Wäre diese Klarheit für Sie hilfreich?" },
    { role: "user", text: "Ja, das wäre für mich hilfreich." },
    ...extra,
  ];
}

export const DIALOG_EVALUATION_SCENARIOS: DialogScenario[] = [
  { id: "flow-empty", category: "pkv-flow", turns: [], expected: { pkvStage: "need_concept" } },
  { id: "flow-pkv-status", category: "pkv-flow", turns: [{ role: "user", text: "Ich bin privat versichert." }, { role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." }], expected: { pkvStage: "need_contribution" } },
  { id: "flow-gkv-status", category: "pkv-flow", turns: [{ role: "user", text: "Ich bin gesetzlich versichert." }, { role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." }], expected: { pkvStage: "need_contribution" } },
  { id: "flow-amount-first", category: "pkv-flow", turns: [{ role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." }, { role: "user", text: "Ich zahle 950 Euro." }], expected: { pkvStage: "need_projection" } },
  { id: "flow-status-and-amount", category: "pkv-flow", turns: [{ role: "user", text: "Privat versichert, aktuell 1200 Euro." }, { role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." }], expected: { pkvStage: "need_projection" } },
  { id: "flow-after-projection", category: "pkv-flow", turns: [
    { role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." },
    { role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter." },
    { role: "assistant", text: "Bei vier Prozent pro Jahr wären es in zehn Jahren ungefähr 1480 Euro." },
  ], expected: { pkvStage: "need_retirement_reflection" } },
  { id: "flow-after-retirement-answer", category: "pkv-flow", turns: [
    { role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." },
    { role: "assistant", text: "Bei vier Prozent pro Jahr wären es in zehn Jahren ungefähr 1480 Euro." },
    { role: "assistant", text: "Was bedeutet diese Entwicklung bis zum Ruhestand für Ihre Planung?" },
    { role: "user", text: "Das wäre mir auf Dauer zu hoch." },
  ], expected: { pkvStage: "need_interest" } },
  { id: "flow-interest-unanswered", category: "pkv-flow", turns: readyPkvTurns().slice(0, -1), expected: { pkvStage: "need_interest" } },
  { id: "flow-earlier-yes-not-consent", category: "pkv-flow", turns: [
    { role: "user", text: "Ja, ich bin privat versichert und zahle 1000 Euro." },
    { role: "assistant", text: "Bei vier Prozent pro Jahr wären es in zehn Jahren ungefähr 1480 Euro." },
    { role: "assistant", text: "Wie fühlt sich das bis zum Ruhestand für Ihre Planung an?" },
    { role: "user", text: "Das ist viel." },
  ], expected: { pkvStage: "need_interest" } },
  { id: "flow-ready", category: "pkv-flow", turns: readyPkvTurns(), expected: { pkvStage: "ready_to_schedule" } },
  { id: "flow-gkv-ready", category: "pkv-flow", turns: readyPkvTurns().map((turn, index) => index === 0 ? { ...turn, text: "Ich bin gesetzlich versichert und zahle 1000 Euro im Monat." } : turn), expected: { pkvStage: "ready_to_schedule" } },

  { id: "event-projection-question", category: "customer-events", turns: [{ role: "user", text: "Warum rechnen Sie mit vier Prozent?" }], expected: { eventType: "customer_question" } },
  { id: "event-identity-question", category: "customer-events", turns: [{ role: "user", text: "Wer ist Herr Duic?" }], expected: { eventType: "customer_question" } },
  { id: "event-no-time", category: "customer-events", turns: [{ role: "user", text: "Ich habe gerade wirklich keine Zeit." }], expected: { eventType: "objection", eventKind: "no_time" } },
  { id: "event-existing-advisor", category: "customer-events", turns: [{ role: "user", text: "Mein Makler kümmert sich bereits darum." }], expected: { eventType: "objection", eventKind: "existing_advisor" } },
  { id: "event-send-email", category: "customer-events", turns: [{ role: "user", text: "Schicken Sie mir das bitte per E-Mail." }], expected: { eventType: "objection", eventKind: "send_information" } },
  { id: "event-skepticism", category: "customer-events", turns: [{ role: "user", text: "Das klingt für mich unrealistisch." }], expected: { eventType: "objection", eventKind: "skepticism" } },
  { id: "event-rejection", category: "customer-events", turns: [{ role: "user", text: "Ich habe kein Interesse, rufen Sie nicht mehr an." }], expected: { eventType: "clear_rejection" } },
  { id: "event-farewell", category: "customer-events", turns: [{ role: "user", text: "Danke, auf Wiederhören." }], expected: { eventType: "clear_rejection" } },
  { id: "event-factual-no", category: "customer-events", turns: [{ role: "user", text: "Nein, ich bin gesetzlich versichert." }], expected: { eventType: "answer" } },
  { id: "event-unclear-mhm", category: "customer-events", turns: [{ role: "user", text: "Mhm." }], expected: { eventType: "unclear" } },
  { id: "event-unclear-asr", category: "customer-events", turns: [{ role: "user", text: "Anlıyorum." }], expected: { eventType: "unclear" } },
  { id: "event-normal-answer", category: "customer-events", turns: [{ role: "user", text: "Das wäre langfristig eine Belastung." }], expected: { eventType: "answer" } },

  { id: "routing-gatekeeper", category: "routing", targetName: "Herr Neumann", turns: [{ role: "user", text: "Zentrale der Beispiel GmbH, guten Tag." }], expected: { routingStage: "gatekeeper" } },
  { id: "routing-queue", category: "routing", targetName: "Herr Neumann", turns: [{ role: "user", text: "Einen Moment bitte, ich verbinde Sie." }], expected: { routingStage: "waiting_for_transfer" } },
  { id: "routing-name", category: "routing", targetName: "Herr Neumann", turns: [{ role: "user", text: "Neumann am Apparat, guten Tag." }], expected: { routingStage: "decision_maker" } },
  { id: "routing-self", category: "routing", targetName: "Frau Wagner", turns: [{ role: "user", text: "Ja, das bin ich selbst." }], expected: { routingStage: "decision_maker" } },
  { id: "routing-voicemail", category: "routing", targetName: "Herr Neumann", turns: [{ role: "user", text: "Bitte hinterlassen Sie eine Nachricht nach dem Signalton." }], expected: { routingStage: "voicemail" } },

  { id: "appointment-too-early", category: "appointments", turns: [{ role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." }], appointment: { freeSlotsPrompt: FREE_SLOTS, slotPhrase: "Mittwoch, 26. August um 11:00 Uhr" }, expected: { appointmentAllowed: false } },
  { id: "appointment-invented", category: "appointments", turns: readyPkvTurns(), appointment: { freeSlotsPrompt: FREE_SLOTS, slotPhrase: "Mittwoch, 26. August um 09:00 Uhr" }, expected: { appointmentAllowed: false } },
  { id: "appointment-valid", category: "appointments", turns: readyPkvTurns(), appointment: { freeSlotsPrompt: FREE_SLOTS, slotPhrase: "Mittwoch, 26. August um 11:00 Uhr" }, expected: { appointmentAllowed: true } },
  { id: "appointment-morning", category: "appointments", turns: readyPkvTurns([{ role: "user", text: "Vormittags passt es besser." }]), appointment: { freeSlotsPrompt: FREE_SLOTS, slotPhrase: "Mittwoch, 26. August um 11:00 Uhr" }, expected: { appointmentAllowed: true } },
  { id: "appointment-afternoon", category: "appointments", turns: readyPkvTurns([{ role: "user", text: "Nachmittags wäre ideal." }]), appointment: { freeSlotsPrompt: FREE_SLOTS, slotPhrase: "Donnerstag, 27. August um 15:30 Uhr" }, expected: { appointmentAllowed: true } },

  { id: "control-multiple-questions", category: "quality-controls", negativeControl: true, turns: [{ role: "assistant", text: "Sind Sie privat versichert? Wie hoch ist Ihr Beitrag?" }], expected: { violationCodes: ["multiple_questions"] } },
  { id: "control-repeated-question", category: "quality-controls", negativeControl: true, turns: [
    { role: "assistant", text: "Wie hoch ist Ihr Beitrag?" },
    { role: "user", text: "Das weiß ich nicht genau." },
    { role: "assistant", text: "Wie hoch ist Ihr Beitrag?" },
  ], expected: { violationCodes: ["repeated_question"] } },
  { id: "control-early-scheduling", category: "quality-controls", negativeControl: true, turns: [
    { role: "user", text: "Ich bin privat versichert." },
    { role: "assistant", text: "Dann können wir einen Termin abstimmen." },
  ], expected: { violationCodes: ["early_scheduling"] } },
  { id: "control-high-latency", category: "quality-controls", negativeControl: true, turns: [{ role: "assistant", text: "Guten Tag.", latencyMs: 4100 }], expected: { violationCodes: ["high_latency"] } },
  { id: "quality-clean-turn", category: "quality-controls", turns: [{ role: "assistant", text: "Sind Sie aktuell privat oder gesetzlich versichert?", latencyMs: 900 }], expected: {} },
];