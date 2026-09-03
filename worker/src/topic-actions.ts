export type TopicAction =
  | { type: "continue"; instruction?: string }
  | { type: "update_objective"; objective: string }
  | { type: "schedule" }
  | { type: "handover" }
  | { type: "close" };

export function detectTopicAction(text: string): TopicAction {
  const normalized = text.trim().toLocaleLowerCase("de-DE");
  if (/gloria.*(?:diesem thema|thema).*erreichen|wechseln wir.*thema/.test(normalized)) {
     const objective = text.replace(/^.*?(?:erreichen|möchte ich)\s*/i, "").trim();
    return { type: "update_objective", objective: objective || text.trim() };
  }
  if (/(?:termin|kalender|zeit vereinbaren|rückruf)/.test(normalized)) return { type: "schedule" };
  if (/(?:berater|mitarbeiter|mensch|weiterverbinden)/.test(normalized)) return { type: "handover" };
  if (/(?:auf wiederhören|gespräch beenden|kein interesse)/.test(normalized)) return { type: "close" };
  return { type: "continue" };
}