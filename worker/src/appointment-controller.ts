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
  return Boolean(findSuppliedAppointmentSlot(freeSlotsPrompt, phrase));
}

export function findSuppliedAppointmentSlot(freeSlotsPrompt: string | undefined, phrase: string): string | undefined {
  const normalizedPhrase = normalizeSlot(phrase);
  const offeredText = normalizeSlot(freeSlotsPrompt || "");
  if (normalizedPhrase.length > 10 && offeredText.includes(normalizedPhrase)) return phrase.trim();
  const time = normalizedPhrase.match(/\b(?:um\s*)?(\d{1,2})(?::|\s+uhr\s*)(\d{2})?\b/);
  if (!time) return undefined;
  const weekday = normalizedPhrase.match(/\b(montag|dienstag|mittwoch|donnerstag|freitag)\b/i)?.[1];
  const day = normalizedPhrase.match(/\b(\d{1,2})\.?\b/)?.[1];
  const offeredLines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean);
  return offeredLines.find((line) => {
    const normalizedLine = normalizeSlot(line);
    const lineHour = normalizedLine.match(/\b(?:um\s*)?(\d{1,2}):?(\d{2})\s*uhr\b/)?.[1];
    return (!weekday || normalizedLine.includes(weekday.toLowerCase()))
      && (!day || new RegExp(`\\b${day}\\.?\\b`).test(normalizedLine))
      && lineHour === time[1]
      && (!time[2] || normalizedLine.includes(`:${time[2]}`));
  });
}

export function appointmentOfferInstruction(freeSlotsPrompt: string | undefined, preference: AppointmentPreference): string | undefined {
  const lines = (freeSlotsPrompt || "").split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter((line) => /\b(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag)\b/i.test(line));
  const preferred = lines.filter((line) => preference === "morning" ? /\bum\s+(?:0?9|1[0-2]):/i.test(line) : /\bum\s+(?:1[3-8]):/i.test(line));
  const choices = (preferred.length >= 2 ? preferred : lines).slice(0, 2);
  if (choices.length < 2) return undefined;
  return `Biete jetzt ausschließlich diese zwei echten freien Termine an: ${choices[0]} oder ${choices[1]}. Frage, welcher Termin besser passt. Erfinde keine gekürzten oder anderen Termine.`;
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
  const suppliedSlot = findSuppliedAppointmentSlot(params.freeSlotsPrompt, slotPhrase);
  if (!suppliedSlot) {
    return {
      ok: false,
      error: "slot_not_offered",
      instruction: "Dieser Termin steht nicht in der bereitgestellten freien Slotliste. Biete nur zwei echte freie Slots aus der Liste an.",
    };
  }

  return {
    ok: true,
    preference: detectAppointmentPreference(params.turns),
    slotPhrase: suppliedSlot,
  };
}