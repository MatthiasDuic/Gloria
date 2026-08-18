import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeInstructions, buildRealtimeResponseInstructions, buildRequiredPkvSequenceInstruction, canConfirmRealtimeAppointment, isLikelyNoiseTranscript, isOfferedSlotPhrase, openAiAudioFormat, shouldRestoreDecisionMakerIntro } from "./openai-realtime-call.js";
import { newContext } from "./state.js";

function buildPkvContext() {
  const ctx = newContext({
    callSid: "test-realtime-pkv",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "user", text: "Ja, die Beiträge steigen jedes Jahr.", at: 1 },
    { role: "user", text: "Ich bin gesetzlich versichert.", at: 2 },
    { role: "assistant", text: "Wie hoch ist Ihr aktueller Monatsbeitrag?", at: 3 },
    { role: "user", text: "1280 Euro.", at: 4 },
    { role: "assistant", text: "Bei rund vier Prozent pro Jahr lägen 1280 Euro in zehn Jahren höher.", at: 5 },
    { role: "assistant", text: "Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?", at: 6 },
    { role: "user", text: "Das wäre langfristig eine Belastung.", at: 7 },
    { role: "assistant", text: "Herr Duic analysiert Ihre persönliche Entwicklung und prüfbare Optionen. Wäre diese Klarheit für Sie hilfreich?", at: 8 },
  );
  return ctx;
}

test("maps the configured bidirectional codec to Realtime audio", () => {
  assert.equal(openAiAudioFormat("PCMU"), "audio/pcmu");
  assert.equal(openAiAudioFormat("PCMA"), "audio/pcma");
});

test("classifies unclear ASR fragments but keeps short German answers", () => {
  assert.equal(isLikelyNoiseTranscript("Good to"), true);
  assert.equal(isLikelyNoiseTranscript("Mhm."), true);
  assert.equal(isLikelyNoiseTranscript("Anlıyorum."), true);
  assert.equal(isLikelyNoiseTranscript("hera"), true);
  assert.equal(isLikelyNoiseTranscript("Ja."), false);
  assert.equal(isLikelyNoiseTranscript("Nein."), false);
  assert.equal(isLikelyNoiseTranscript("Dienstag."), false);
  assert.equal(isLikelyNoiseTranscript("Nachmittag."), false);
});

test("does not use an earlier acknowledgement as PKV appointment consent", () => {
  const ctx = buildPkvContext();
  ctx.transcript.push({ role: "user", text: "Vormittags wäre besser.", at: 7 });

  const result = canConfirmRealtimeAppointment(ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Zustimmung/);
});

test("allows a PKV appointment after consent to the concept question", () => {
  const ctx = buildPkvContext();
  ctx.transcript.push({ role: "user", text: "Ja, das ist für mich sinnvoll.", at: 7 });

  assert.deepEqual(canConfirmRealtimeAppointment(ctx), { ok: true });
});

test("allows a PKV appointment after selecting an offered slot", () => {
  const ctx = buildPkvContext();
  ctx.transcript.push(
    { role: "user", text: "Ja, diese Klarheit ist für mich hilfreich.", at: 6.5 },
    { role: "assistant", text: "Dann habe ich zwei Vorschläge: Montag, 24. August um 15:30 Uhr, oder Dienstag, 25. August um 13:30 Uhr. Welcher Termin passt Ihnen besser?", at: 7 },
    { role: "user", text: "Der Dienstag ist gut.", at: 8 },
  );

  assert.deepEqual(canConfirmRealtimeAppointment(ctx), { ok: true });
});

test("rejects invented slots and accepts exact supplied slots", () => {
  const ctx = buildPkvContext();
  ctx.freeSlotsPrompt = "FREIE TERMIN-VORSCHLÄGE:\n- Mittwoch, 26. August um 11:00 Uhr\n- Donnerstag, 27. August um 15:30 Uhr";
  assert.equal(isOfferedSlotPhrase(ctx, "Mittwoch, 26. August um 11:00 Uhr"), true);
  assert.equal(isOfferedSlotPhrase(ctx, "Mittwoch, 26. August um 09:00 Uhr"), false);
});

test("includes the required decision-maker and gatekeeper opening lines", () => {
  const ctx = newContext({
    callSid: "test-realtime-opening",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /Guten Tag, mein Name ist Gloria/);
  assert.match(instructions, /Darf ich Ihnen kurz sagen, worum es geht/);
  assert.match(instructions, /Können Sie mich bitte mit Herr Neumann verbinden/);
  assert.match(instructions, /kurze Einordnung zur Beitragsentwicklung in der Gesundheitsversorgung/);
  assert.match(instructions, /Neukundenakquise und der erste Kontakt/);
  assert.match(instructions, /beginne nicht mit der Versicherungsfrage/);
});

test("requires the PKV ten-year and retirement bridge after a contribution", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-projection",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /in zehn Jahren/);
  assert.match(instructions, /bis zum Ruhestand/);
  assert.match(instructions, /Tarifoptimierung/);
  assert.match(instructions, /Altersrückstellungen/);
  assert.match(instructions, /Beitragsentlastungstarife/);
  assert.match(instructions, /Steuervorteile/);
  assert.doesNotMatch(instructions, /Wechsel in die PKV|Wechsel in die private Krankenversicherung/);
  assert.match(instructions, /nur auf konkrete Kundenfrage/i);
});

test("uses the standard PKV flow in a strict order: concept → insurance status and contribution", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-flow",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);

  const conceptIndex = instructions.search(/Beitragsentwicklung analysieren/);
  const projectionIndex = instructions.search(/in zehn Jahren und bis zum Ruhestand hochrechnen/);
  const contributionIndex = instructions.search(/Versicherungsstatus und aktuellem Beitrag/);

  assert.notEqual(conceptIndex, -1);
  assert.notEqual(projectionIndex, -1);
  assert.notEqual(contributionIndex, -1);
  assert.ok(conceptIndex < contributionIndex);
});

test("forces the ten-year projection before scheduling after a contribution", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-order",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({ role: "user", text: "Ich zahle tausend Euro.", at: 1 });

  const instruction = buildRequiredPkvSequenceInstruction(ctx);
  assert.match(instruction, /in zehn Jahren/);
  assert.match(instruction, /Keine Terminfrage/);

  ctx.transcript.push(
    { role: "assistant", text: "Bei 1000 Euro wären es in zehn Jahren ungefähr 1480 Euro.", at: 2 },
  );
  assert.match(buildRequiredPkvSequenceInstruction(ctx), /bis zum Ruhestand/);
});

test("keeps customer-question responses separate from the PKV sequence", () => {
  const ctx = newContext({
    callSid: "test-realtime-question-priority",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({ role: "user", text: "Ich bin gesetzlich versichert.", at: 1 });

  const response = buildRealtimeResponseInstructions(
    ctx,
    "Beantworte zuerst ausschließlich die konkrete Kundenfrage: Kann ich Sie sehen?",
    false,
  );

  assert.match(response, /Beantworte zuerst ausschließlich/);
  assert.doesNotMatch(response, /ZWINGENDER NÄCHSTER SCHRITT/);
});

test("places the active PKV stage after optional response guidance", () => {
  const ctx = newContext({
    callSid: "test-realtime-sequence-priority",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({ role: "user", text: "Ich zahle 1000 Euro im Monat.", at: 1 });
  const response = buildRealtimeResponseInstructions(ctx, "Begründe die Antwort knapp.", true);
  assert.ok(response.indexOf("Begründe die Antwort knapp.") < response.indexOf("ZWINGENDER NÄCHSTER SCHRITT"));
});

test("requires the concept bridge after permission to explain the call", () => {
  const ctx = newContext({
    callSid: "test-realtime-concept-bridge",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Darf ich Ihnen kurz sagen, worum es geht?", at: 1 },
    { role: "user", text: "Ja, das dürfen Sie.", at: 2 },
  );
  const instruction = buildRequiredPkvSequenceInstruction(ctx);
  assert.match(instruction, /Beitragsentwicklung analysieren/);
  assert.match(instruction, /Tarifoptimierung/);
  assert.doesNotMatch(instruction, /Wahltarife|Bonusprogramme/);
});

test("restores the decision-maker introduction only when playback was interrupted", () => {
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: true }), true);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: false }), false);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: false, playbackPending: true }), false);
});
