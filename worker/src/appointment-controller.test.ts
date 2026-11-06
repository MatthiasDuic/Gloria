import assert from "node:assert/strict";
import test from "node:test";
import { advanceAppointmentRouting, appointmentOfferInstruction, decideAppointment, detectAppointmentMode, detectAppointmentPreference, findSuppliedAppointmentSlot, getAppointmentOfferSlots, isSuppliedAppointmentSlot, matchOfferedAppointmentSelection } from "./appointment-controller.js";
import { computeFreeSlots } from "./busy.js";
import { parseSlotPhraseToIso } from "./finalize.js";
import type { ConversationTurn } from "./pkv-conversation-controller.js";

const freeSlots = "FREIE TERMIN-VORSCHLÄGE:\n- Mittwoch, 26. August um 11:00 Uhr\n- Donnerstag, 27. August um 15:30 Uhr";

test("locks the selected Tuesday, retains the location and proceeds to booking without model slot rewriting", () => {
  const slots = "FREIE TERMIN-VORSCHLÄGE:\n- Freitag, 6. November um 08:30 Uhr\n- Dienstag, 10. November um 10:00 Uhr";
  const turns: ConversationTurn[] = [
    { role: "assistant", text: "Passt Ihnen für einen Orientierungstermin eher vormittags oder nachmittags?" },
    { role: "user", text: "Tatsächlich ist es vormittags bei mir besser." },
  ];
  let transition = advanceAppointmentRouting({}, turns, slots);
  assert.equal(transition.state.appointmentOfferedSlots?.length, 2);
  assert.match(transition.speechText || "", /Freitag.*Dienstag/);
  turns.push({ role: "assistant", text: transition.speechText || "" }, { role: "user", text: "Der Dienstag passt sehr gut." });
  transition = advanceAppointmentRouting(transition.state, turns, slots);
  assert.equal(transition.state.selectedAppointmentSlot, "Dienstag, 10. November um 10:00 Uhr");
  assert.equal(transition.speechText, "Soll der Termin persönlich oder digital stattfinden?");
  turns.push({ role: "assistant", text: transition.speechText }, { role: "user", text: "Gerne bei mir vor Ort." });
  transition = advanceAppointmentRouting(transition.state, turns, slots);
  assert.equal(transition.readyToBook, true);
  assert.equal(transition.state.appointmentMode, "Beim Kunden vor Ort");
  assert.equal(transition.state.selectedAppointmentSlot, "Dienstag, 10. November um 10:00 Uhr");
  const decision = decideAppointment({ turns, topicKind: "pkv", freeSlotsPrompt: slots, slotPhrase: transition.state.selectedAppointmentSlot });
  assert.equal(decision.ok, true);
  turns.push({ role: "user", text: "Bei mir." });
  assert.equal(advanceAppointmentRouting(transition.state, turns, slots).state.appointmentMode, "Beim Kunden vor Ort");
});

test("treats a personal choice as an appointment at the customer without asking for a location", () => {
  assert.equal(detectAppointmentMode([{ role: "user", text: "Persönlich bitte." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Gerne persoenlich." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Gerne digital." }]), "Microsoft Teams");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Gerne bei mir vor Ort." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Nicht digital, lieber persönlich." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Nicht persönlich, lieber digital." }]), "Microsoft Teams");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Was meinen Sie mit digital?" }]), undefined);
  assert.equal(detectAppointmentMode([{ role: "user", text: "In Ihrer Agentur." }]), undefined);
});

test("matches numeric and spoken tool times to the canonical calendar slot", () => {
  const slots = "FREIE TERMIN-VORSCHLÄGE:\n- Montag, 9. November um 08:30 Uhr\n- Dienstag, 10. November um 08:30 Uhr";
  assert.equal(findSuppliedAppointmentSlot(slots, "Montag, 9. November um 8:30 Uhr"), "Montag, 9. November um 08:30 Uhr");
  assert.equal(findSuppliedAppointmentSlot(slots, "Montag, den neunten November um acht Uhr dreißig"), "Montag, 9. November um 08:30 Uhr");
  assert.equal(findSuppliedAppointmentSlot(slots, "Montag, 9. November um 09:00 Uhr"), undefined);
  assert.equal(findSuppliedAppointmentSlot(slots, "Montag, 9. Dezember um 08:30 Uhr"), undefined);
});

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
  assert.equal(detectAppointmentPreference([{ role: "user", text: "Vormittags geht es nicht, lieber nachmittags." }]), "afternoon");
  assert.equal(detectAppointmentPreference([{ role: "user", text: "Vormittags oder nachmittags wäre möglich." }]), "unknown");
  assert.equal(detectAppointmentPreference([{ role: "user", text: "Nicht vormittags." }]), "unknown");
});

test("books an in-person appointment directly after the personal choice", () => {
  const slots = [
    "Montag, 9. November um 08:30 Uhr",
    "Dienstag, 10. November um 11:00 Uhr",
  ];
  const turns: ConversationTurn[] = [
    { role: "assistant", text: "Welcher Termin passt Ihnen besser?" },
    { role: "user", text: "Der Montag passt." },
  ];
  const selected = advanceAppointmentRouting({ appointmentOfferedSlots: slots }, turns, freeSlots);
  assert.equal(selected.state.selectedAppointmentSlot, slots[0]);
  assert.equal(selected.state.appointmentMode, undefined);
  assert.equal(selected.speechText, "Soll der Termin persönlich oder digital stattfinden?");

  turns.push(
    { role: "assistant", text: selected.speechText || "" },
    { role: "user", text: "Nicht digital, lieber persönlich." },
  );
  const booked = advanceAppointmentRouting(selected.state, turns, freeSlots);
  assert.equal(booked.readyToBook, true);
  assert.equal(booked.state.appointmentMode, "Beim Kunden vor Ort");
});

test("does not book on a clarification question, vague request, or rejected mode", () => {
  const state = { selectedAppointmentSlot: "Montag, 9. November um 08:30 Uhr" };
  for (const text of ["Was meinen Sie mit digital?", "Bitte?", "Nicht digital."]) {
    const transition = advanceAppointmentRouting(state, [
      { role: "assistant", text: "Soll der Termin persönlich oder digital stattfinden?" },
      { role: "user", text },
    ], freeSlots);
    assert.notEqual(transition.readyToBook, true, text);
    assert.equal(transition.state.appointmentMode, undefined, text);
  }
  const digitalQuestion = advanceAppointmentRouting(state, [
    { role: "user", text: "Was meinen Sie mit digital?" },
  ], freeSlots);
  assert.match(digitalQuestion.speechText || "", /Digital bedeutet eine Beratung per Microsoft Teams/);
  const agencyRequest = advanceAppointmentRouting(state, [
    { role: "user", text: "In Ihrer Agentur." },
  ], freeSlots);
  assert.notEqual(agencyRequest.readyToBook, true);
  assert.match(agencyRequest.speechText || "", /Termine in der Agentur kann ich derzeit nicht vereinbaren/);
});

test("accepts only slots supplied by the calendar", () => {
  assert.equal(isSuppliedAppointmentSlot(freeSlots, "Mittwoch, 26. August um 11:00 Uhr"), true);
  assert.equal(isSuppliedAppointmentSlot(freeSlots, "Mittwoch, 26. August um 09:00 Uhr"), false);
});

test("does not impose a fixed PKV qualifying sequence but requires a customer-selected slot", () => {
  const decision = decideAppointment({
    turns: [{ role: "user", text: "Ich bin privat versichert und zahle 1000 Euro." }],
    topicKind: "pkv",
    freeSlotsPrompt: freeSlots,
    slotPhrase: "Mittwoch, 26. August um 11:00 Uhr",
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) {
    assert.equal(decision.error, "conversation_not_ready");
    assert.match(decision.instruction, /konkreten vorgeschlagenen oder eigenen Zeitpunkt/);
    assert.doesNotMatch(decision.instruction, /PKV|Beitragsentwicklung|Hochrechnung/);
  }
});

test("returns one successful decision for a supplied slot", () => {
  assert.deepEqual(
    decideAppointment({
      turns: [
        ...readyPkvTurns(),
        { role: "assistant", text: "Ich kann Ihnen Donnerstag, 27. August um 15:30 Uhr anbieten. Passt das?" },
        { role: "user", text: "Donnerstag, 27. August um 15:30 Uhr passt." },
      ],
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
  assert.equal(detectAppointmentMode([{ role: "user", text: "Ich komme zu Ihnen in die Agentur." }]), undefined);
  assert.equal(detectAppointmentMode([{ role: "user", text: "Machen wir das per Teams." }]), "Microsoft Teams");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Vor Ort." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Herr Duic kann zu mir kommen." }]), "Beim Kunden vor Ort");
  assert.equal(detectAppointmentMode([{ role: "user", text: "Der Montag passt besser." }]), undefined);
  assert.equal(detectAppointmentMode([
    { role: "user", text: "Bei mir." },
    { role: "user", text: "Der Montag passt besser." },
  ]), undefined);
  assert.equal(detectAppointmentMode([{ role: "user", text: "Bei uns steigen die Beiträge jedes Jahr." }]), undefined);
});

test("offers nonconsecutive days and different times within the requested time window", () => {
  const slots = [
    "- Montag, 19. Oktober um 08:30 Uhr",
    "- Montag, 19. Oktober um 10:00 Uhr",
    "- Dienstag, 20. Oktober um 11:00 Uhr",
    "- Dienstag, 20. Oktober um 12:30 Uhr",
    "- Mittwoch, 21. Oktober um 08:30 Uhr",
    "- Mittwoch, 21. Oktober um 10:00 Uhr",
    "- Mittwoch, 21. Oktober um 13:00 Uhr",
    "- Donnerstag, 22. Oktober um 17:30 Uhr",
    "- Freitag, 23. Oktober um 18:00 Uhr",
    "- Freitag, 23. Oktober um 18:30 Uhr",
  ].join("\n");

  assert.deepEqual(getAppointmentOfferSlots(slots, "morning"), [
    "Montag, 19. Oktober um 08:30 Uhr",
    "Mittwoch, 21. Oktober um 10:00 Uhr",
  ]);
  assert.deepEqual(getAppointmentOfferSlots(slots, "afternoon"), [
    "Mittwoch, 21. Oktober um 13:00 Uhr",
    "Freitag, 23. Oktober um 18:00 Uhr",
  ]);
  const offer = appointmentOfferInstruction(slots, "morning");
  assert.match(offer || "", /Ich kann Ihnen Montag, 19\. Oktober um 08:30 Uhr oder Mittwoch, 21\. Oktober um 10:00 Uhr anbieten/);
  assert.doesNotMatch(offer || "", /ausschließlich|nur diese/i);
  assert.match(offer || "", /Stelle in diesem Turn keine weitere Frage/);
  assert.equal(appointmentOfferInstruction("- Montag, 19. Oktober um 09:00 Uhr", "morning"), undefined);
  assert.deepEqual(getAppointmentOfferSlots(slots, "unknown"), []);
});

test("does not fall back to adjacent days or identical times when no suitable pair exists", () => {
  for (const slots of [
    "- Montag, 9. November um 08:30 Uhr\n- Dienstag, 10. November um 10:00 Uhr",
    "- Montag, 9. November um 08:30 Uhr\n- Mittwoch, 11. November um 08:30 Uhr",
  ]) {
    assert.deepEqual(getAppointmentOfferSlots(slots, "morning"), []);
    const transition = advanceAppointmentRouting({}, [
      { role: "assistant", text: "Für einen Termin eher vormittags oder nachmittags?" },
      { role: "user", text: "Vormittags." },
    ], slots);
    assert.match(transition.speechText || "", /anderer Zeitraum/);
    assert.equal(transition.state.appointmentOfferedSlots, undefined);
  }
});

test("production-sized slot sampling retains varied times and valid offers for both preferences", (context) => {
  context.mock.method(Date, "now", () => Date.parse("2026-11-02T09:00:00Z"));
  const slots = computeFreeSlots([], { daysAhead: 60, maxCount: 40, minLeadDays: 7 });
  const prompt = slots.map((slot) => `- ${slot.phrase}`).join("\n");
  assert.equal(slots.length, 40);
  assert.ok(new Set(slots.map((slot) => slot.phrase.match(/\d{2}:\d{2}/)?.[0])).size >= 4);
  for (const preference of ["morning", "afternoon"] as const) {
    const choices = getAppointmentOfferSlots(prompt, preference);
    assert.equal(choices.length, 2);
    const starts = choices.map((choice) => Date.parse(parseSlotPhraseToIso(choice) || ""));
    assert.ok(Math.floor(starts[1] / 86_400_000) - Math.floor(starts[0] / 86_400_000) >= 2);
    assert.notEqual(choices[0].match(/\d{2}:\d{2}/)?.[0], choices[1].match(/\d{2}:\d{2}/)?.[0]);
    assert.ok(choices.every((choice) => slots.some((slot) => slot.phrase === choice)));
  }
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

test("detects appointment selection and mode from one customer answer", () => {
  const offered = [
    "Freitag, 6. November um 10:00 Uhr",
    "Montag, 9. November um 10:00 Uhr",
  ];
  const answer = "Der Montag klingt sehr gut und wir können das gerne bei mir vor Ort machen.";
  assert.equal(matchOfferedAppointmentSelection(answer, offered), offered[1]);
  assert.equal(detectAppointmentMode([{ role: "user", text: answer }]), "Beim Kunden vor Ort");
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
test("asks again for the slot instead of guessing on a garbled or bare reply", () => {
  const slots = ["Montag, 16. November um 08:30 Uhr", "Freitag, 4. Dezember um 10:00 Uhr"];
  for (const text of ["PaiTalk.", "Ja.", "Persönlich."]) {
    const transition = advanceAppointmentRouting({ appointmentOfferedSlots: slots }, [
      { role: "assistant", text: "Welcher Termin passt Ihnen besser?" },
      { role: "user", text },
    ], freeSlots);
    assert.equal(transition.state.selectedAppointmentSlot, undefined, text);
    assert.equal(transition.speechText, `Entschuldigung, das habe ich nicht genau verstanden. Passt Ihnen eher ${slots[0]} oder ${slots[1]}?`, text);
  }
  for (const text of ["Geht auch nächste Woche?", "Beide passen leider nicht.", "Haben Sie auch etwas am Nachmittag?"]) {
    const transition = advanceAppointmentRouting({ appointmentOfferedSlots: slots }, [{ role: "user", text }], freeSlots);
    assert.equal(transition.speechText, undefined, text);
  }
});