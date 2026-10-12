import assert from "node:assert/strict";
import test from "node:test";
import { appointmentOfferInstruction, decideAppointment, detectAppointmentMode, detectAppointmentPreference, getAppointmentOfferSlots, isSuppliedAppointmentSlot, matchOfferedAppointmentSelection } from "./appointment-controller.js";
import { computeFreeSlots } from "./busy.js";
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
  assert.equal(detectAppointmentPreference([{ role: "user", text: "Das ist mir egal." }]), "unknown");
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

test("requires explicit confirmation after a slot clarification question", () => {
  const turns: ConversationTurn[] = [
    ...readyPkvTurns(),
    { role: "assistant", text: "Meinen Sie Donnerstag, 27. August um 15:30 Uhr?" },
    { role: "user", text: "Ja, das passt." },
  ];
  const decision = decideAppointment({
    turns,
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
  });
  assert.equal(decision.ok, true);
});

test("accepts selected offered slot without re-asking when latest turn is appointment mode", () => {
  const turns: ConversationTurn[] = [
    ...readyPkvTurns(),
    { role: "assistant", text: "Welcher Termin passt Ihnen besser: Mittwoch, 26. August um 11:00 Uhr oder Donnerstag, 27. August um 15:30 Uhr?" },
    { role: "user", text: "Der zweite Termin passt besser." },
    { role: "assistant", text: "Soll der Termin bei Ihnen vor Ort, in unserer Agentur oder per Microsoft Teams stattfinden?" },
    { role: "user", text: "Bei mir vor Ort." },
  ];
  const decision = decideAppointment({
    turns,
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
  });
  assert.equal(decision.ok, true);
});

test("requires asking for customer-proposed slot when both offered slots are rejected", () => {
  const turns: ConversationTurn[] = [
    ...readyPkvTurns(),
    { role: "assistant", text: "Welcher Termin passt Ihnen besser: Mittwoch, 26. August um 11:00 Uhr oder Donnerstag, 27. August um 15:30 Uhr?" },
    { role: "user", text: "Beide passen leider nicht." },
  ];
  const decision = decideAppointment({
    turns,
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Donnerstag, 27. August um 15:30 Uhr",
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.error, "conversation_not_ready");
    assert.match(decision.instruction, /Welchen Termin würden Sie vorschlagen\?/i);
  }
});

test("detects the selected appointment mode from the customer answer", () => {
  assert.equal(detectAppointmentMode([{ role: "user", text: "Am liebsten bei mir vor Ort." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Ich komme zu Ihnen in die Agentur." }]), "In der Agentur");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Machen wir das per Teams." }]), "Microsoft Teams");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Vor Ort." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Herr Duic kann zu mir kommen." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Der Montag passt besser." }]), undefined);
  assert.equal(detectAppointmentMode([
    { role: "user", text: "Bei mir." },
    { role: "user", text: "Der Montag passt besser." },
  ]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Bei uns steigen die Beiträge jedes Jahr." }]), undefined);
});

test("offers only two different-day calendar slots within the requested time window", () => {
  const slots = [
    "- Montag, 19. Oktober um 08:30 Uhr",
    "- Montag, 19. Oktober um 10:00 Uhr",
    "- Dienstag, 20. Oktober um 11:00 Uhr",
    "- Dienstag, 20. Oktober um 12:30 Uhr",
    "- Mittwoch, 21. Oktober um 13:00 Uhr",
    "- Donnerstag, 22. Oktober um 17:30 Uhr",
    "- Freitag, 23. Oktober um 18:00 Uhr",
    "- Freitag, 23. Oktober um 18:30 Uhr",
  ].join("\n");

  assert.deepEqual(getAppointmentOfferSlots(slots, "morning"), [
    "Montag, 19. Oktober um 08:30 Uhr",
    "Dienstag, 20. Oktober um 11:00 Uhr",
  ]);
  assert.deepEqual(getAppointmentOfferSlots(slots, "afternoon"), [
    "Mittwoch, 21. Oktober um 13:00 Uhr",
    "Donnerstag, 22. Oktober um 17:30 Uhr",
  ]);
  assert.equal(appointmentOfferInstruction("- Montag, 19. Oktober um 09:00 Uhr", "morning"), undefined);
  assert.deepEqual(getAppointmentOfferSlots(slots, "unknown"), []);
});

test("resolves a clear slot choice once without requiring another confirmation", () => {
  const offered = [
    "Montag, 19. Oktober um 08:30 Uhr",
    "Dienstag, 20. Oktober um 11:00 Uhr",
  ];
  assert.equal(matchOfferedAppointmentSelection("Der zweite passt.", offered), offered[1]);
  assert.equal(matchOfferedAppointmentSelection("Montag wäre gut.", offered), offered[0]);
  assert.equal(matchOfferedAppointmentSelection("Um 11:00 Uhr bitte.", offered), offered[1]);
  assert.equal(matchOfferedAppointmentSelection("Vielleicht.", offered), undefined);
});

test("calendar generates only weekday slots within the requested business windows", () => {
  const slots = computeFreeSlots([], { daysAhead: 21, maxCount: 300, minLeadDays: 7 });
  assert.ok(slots.length > 0);
  for (const slot of slots) {
    const time = slot.phrase.match(/um (\d{2}):(\d{2}) Uhr/)?.slice(1).map(Number);
    assert.ok(time, `expected a numeric time in ${slot.phrase}`);
    const minutes = time![0] * 60 + time![1];
    assert.ok(
      (minutes >= 8 * 60 + 30 && minutes <= 11 * 60) || (minutes >= 13 * 60 && minutes <= 18 * 60),
      `slot outside allowed windows: ${slot.phrase}`,
    );
  }
});