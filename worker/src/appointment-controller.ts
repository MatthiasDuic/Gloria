import { assessPkvConversation, instructionForPkvStage, type ConversationTurn } from "./pkv-conversation-controller.js";

export type AppointmentPreference = "morning" | "afternoon" | "unknown";

export type AppointmentDecision =
  | { ok: true; preference: AppointmentPreference; slotPhrase: string }
  | { ok: false; error: "conversation_not_ready" | "missing_slot_phrase" | "slot_not_offered"; instruction: string };

function normalizeSlot(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-zäöüß0-9:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectAppointmentPreference(turns: ConversationTurn[]): AppointmentPreference {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role !== "user") continue;
    if (/\b(?:vormittag|vormittags|morgens|früh)\b/i.test(turn.text)) return "morning";
    if (/\b(?:nachmittag|nachmittags|mittags|später)\b/i.test(turn.text)) return "afternoon";
  }
  return "unknown";
}

export function isSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): boolean {
  const normalizedPhrase = normalizeSlot(phrase);
  const offeredText = normalizeSlot(freeSlotsPrompt || "");
  return normalizedPhrase.length > 10 && offeredText.includes(normalizedPhrase);
}

export function decideAppointment(params: {
  turns: ConversationTurn[];
  topicKind: "pkv" | "other";
  freeSlotsPrompt?: string;
  slotPhrase?: string;
}): AppointmentDecision {
  if (params.topicKind === "pkv") {
    const assessment = assessPkvConversation(params.turns);
    if (assessment.stage !== "ready_to_schedule") {
      return {
        ok: false,
        error: "conversation_not_ready",
        instruction: instructionForPkvStage(assessment),
      };
    }
  }

  const slotPhrase = params.slotPhrase?.trim() || "";
  if (!slotPhrase) {
    return {
      ok: false,
      error: "missing_slot_phrase",
      instruction: "Es fehlt ein eindeutig ausgewählter Termin.",
    };
  }
  if (!isSuppliedAppointmentSlot(params.freeSlotsPrompt, slotPhrase)) {
    return {
      ok: false,
      error: "slot_not_offered",
      instruction: "Dieser Termin steht nicht in der bereitgestellten freien Slotliste. Biete nur zwei echte freie Slots aus der Liste an.",
    };
  }

  return {
    ok: true,
    preference: detectAppointmentPreference(params.turns),
    slotPhrase,
  };
}