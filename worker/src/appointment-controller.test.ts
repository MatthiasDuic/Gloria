import assert from "node:assert/strict";
import test from "node:test";
import { decideAppointment, detectAppointmentPreference, isSuppliedAppointmentSlot } from "./appointment-controller.js";
import type { ConversationTurn } from "./pkv-conversation-controller.js";

const freeSlots = "FREIE TERMIN-VORSCHLÄGE:\n- Mittwoch, 26. August um 11:00 Uhr\n- Donnerstag, 27. August um 15:30 Uhr";

function readyPkvTurns(): ConversationTurn[] {
  return [
    { role: "assistant", text: "Wie nehmen Sie diese Entwicklung wahr?" },
    { role: "user", text: "Ja, die Beiträge steigen jedes Jahr." },
    { role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." },
    { role: "assistant", text: "Bei vier Prozent pro Jahr sind es in zehn Jahren ungefähr 1480 Euro." },
    { role: "assistant", text: "Wie fühlt sich diese Entwicklung bis zum Ruhestand für Sie und Ihre Planung an?" },
    { role: "user", text: "Das wäre langfristig zu viel." },
    { role: "assistant", text: "Wäre diese Klarheit für Sie hilfreich?" },
    { role: "user", text: "Ja, das wäre hilfreich. Nachmittags wäre mir lieber." },
  ];
}

test("detects the latest explicit appointment preference", () => {
  assert.equal(detectAppointmentPreference(readyPkvTurns()), "afternoon");
});

test("accepts only slots supplied by the calendar", () => {
  assert.equal(isSuppliedAppointmentSlot(freeSlots, "Mittwoch, 26. August um 11:00 Uhr"), true);
  assert.equal(isSuppliedAppointmentSlot(freeSlots, "Mittwoch, 26. August um 09:00 Uhr"), false);
});

test("blocks appointment tools before the PKV flow is complete", () => {
  const decision = decideAppointment({
    turns: [{ role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." }],
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Mittwoch, 26. August um 11:00 Uhr",
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.error, "conversation_not_ready");
});

test("returns one successful decision for a supplied slot", () => {
  assert.deepEqual(
    decideAppointment({
      turns: readyPkvTurns(),
      topicKind: "pkv",
      freeSlotsPrompt: freeSlots,
      slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
    }),
    {
      ok: true,
      preference: "afternoon",
      slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
    },
  );
});

test("does not lock a slot from a delayed greeting transcript", () => {
  const decision = decideAppointment({
    turns: [...readyPkvTurns(), { role: "assistant", text: "Meinen Sie Donnerstag, 27. August um 15:30 Uhr?" }, { role: "user", text: "Hallo?" }],
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.error, "conversation_not_ready");
});