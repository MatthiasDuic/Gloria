export const CALL_FLOW_STATES = [
  "CALL_START",
  "RECEPTION",
  "DECIDER_INTRO",
  "PROBLEM",
  "BEDARF",
  "KONZEPT",
  "DATEN",
  "TERMINIERUNG",
  "CALL_END",
] as const;

export type CallFlowState = (typeof CALL_FLOW_STATES)[number];
