import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeInstructions, buildRealtimeResponseInstructions, buildRequiredPkvSequenceInstruction, canConfirmRealtimeAppointment, isLikelyIncompleteAssistantTurn, isLikelyNoiseTranscript, isOfferedSlotPhrase, isSyntheticTranscriptionPrompt, openAiAudioFormat, shouldRestoreDecisionMakerIntro } from "./openai-realtime-call.js";
import { newContext } from "./state.js";

function buildPkvContext() {
  const ctx = newContext({
    callSid: "test-realtime-pkv",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "user", text: "Ja, die Beiträge steigen jedes Jahr.", at: 1 },
    { role: "assistant", text: "Wie nehmen Sie diese Entwicklung wahr?", at: 1.5 },
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

test("ignores the configured ASR prompt when it leaks into a transcript", () => {
  assert.equal(isSyntheticTranscriptionPrompt("Deutsches Telefonat zur privaten Krankenversicherung. Achte besonders auf Eigennamen, Firmennamen, Neumann, Duic, Zahlen, Euro-Beträge sowie gesetzlich und privat."), true);
  assert.equal(isSyntheticTranscriptionPrompt("Ich zahle tausend Euro."), false);
});

test("does not recover a complete preparation introduction ending with a colon", () => {
  assert.equal(isLikelyIncompleteAssistantTurn("Bitte beantworten Sie zur Vorbereitung folgende Fragen:"), false);
  assert.equal(isLikelyIncompleteAssistantTurn("Damit Sie ein Gefühl dafür bekommen, worüber wir genau sprechen"), true);
});

test("does not use an earlier acknowledgement as PKV appointment consent", () => {
  const ctx = buildPkvContext();
  ctx.transcript.push({ role: "user", text: "Vormittags wäre besser.", at: 7 });

  const result = canConfirmRealtimeAppointment(ctx);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /Beitragsentwicklung|Konzept/);
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

test("accepts a direct Monday selection as a confirmed slot without asking again", () => {
  const ctx = buildPkvContext();
  ctx.freeSlotsPrompt = "FREIE TERMIN-VORSCHLÄGE:\n- Montag, 24. August um 15:30 Uhr\n- Dienstag, 25. August um 13:30 Uhr";
  ctx.transcript.push(
    { role: "user", text: "Ja, diese Klarheit ist für mich hilfreich.", at: 6.5 },
    { role: "assistant", text: "Dann habe ich zwei Vorschläge: Montag, 24. August um 15:30 Uhr, oder Dienstag, 25. August um 13:30 Uhr. Welcher Termin passt Ihnen besser?", at: 7 },
    { role: "user", text: "Montag passt gut.", at: 8 },
  );

  assert.deepEqual(canConfirmRealtimeAppointment(ctx), { ok: true });
  assert.equal(isOfferedSlotPhrase(ctx, "Montag passt gut."), true);
});

test("instructs the model to confirm an unambiguous offered weekday immediately", () => {
  const instructions = buildRealtimeInstructions(buildPkvContext());
  assert.match(instructions, /Eine eindeutige Auswahl[^.]+ist bereits die verbindliche Terminwahl/);
  assert.match(instructions, /verlange kein zusätzliches 'Ja, das passt'/);
  assert.doesNotMatch(instructions, /Bei 'Der Donnerstag'.+frage zuerst kurz zurück/);
});

test("rejects invented slots and accepts exact supplied slots", () => {
  const ctx = buildPkvContext();
  ctx.freeSlotsPrompt = "FREIE TERMIN-VORSCHLÄGE:\n- Mittwoch, 26. August um 11:00 Uhr\n- Donnerstag, 27. August um 15:30 Uhr";
  assert.equal(isOfferedSlotPhrase(ctx, "Mittwoch, 26. August um 11:00 Uhr"), true);
  assert.equal(isOfferedSlotPhrase(ctx, "Mittwoch, 26. August um 09:00 Uhr"), false);
});

test("formats times and Euro amounts in dynamic response instructions", () => {
  const ctx = buildPkvContext();
  const response = buildRealtimeResponseInstructions(ctx, "Biete Donnerstag, 3. September um 18:00 Uhr und 1.800 Euro an.", false);
  assert.match(response, /um achtzehn Uhr/);
  assert.match(response, /eintausend achthundert Euro/);
  assert.doesNotMatch(response, /18:00|1\.800 Euro/);
});

test("uses natural German time wording for spoken appointment slots", () => {
  const spoken = buildRealtimeResponseInstructions(
    buildPkvContext(),
    "Biete Mittwoch, 9. September um 18:00 Uhr an.",
    false,
  );
  assert.match(spoken, /um achtzehn Uhr/);
  assert.doesNotMatch(spoken, /achtzehn Uhr null|18:00 Uhr/);
});

test("formats percentages and larger amounts naturally for speech", () => {
  const ctx = buildPkvContext();
  const response = buildRealtimeResponseInstructions(
    ctx,
    "Bei 5% und 1.286 Euro sieht man die Entwicklung klarer.",
    false,
  );
  assert.match(response, /fünf Prozent/);
  assert.match(response, /eintausend zweihundert sechsundachtzig Euro/);
  assert.doesNotMatch(response, /5%|1\.286 Euro/);
});

test("includes the required decision-maker and gatekeeper opening lines", () => {
  const ctx = newContext({
    callSid: "test-realtime-opening",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin von Herrn Duic/);
  assert.match(instructions, /Darf ich Ihnen kurz sagen, worum es geht/);
  assert.match(instructions, /Können Sie mich bitte mit Herr Neumann verbinden/);
  assert.match(instructions, /kurze Einordnung zur Beitragsentwicklung in der Gesundheitsversorgung/);
  assert.match(instructions, /Neukundenakquise und der erste Kontakt/);
  assert.match(instructions, /beginne nicht mit der Versicherungsfrage/);
});

test("uses the user society in the opening and falls back when it is missing", () => {
  const allianzContext = newContext({
    callSid: "test-realtime-society-allianz",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
    ownerGesellschaft: "Allianz",
  });
  const allianzInstructions = buildRealtimeInstructions(allianzContext);
  assert.match(allianzInstructions, /aus dem Hause Allianz/);
  assert.doesNotMatch(allianzInstructions, /aus dem Hause BarmeniaGothaer/);

  const fallbackContext = newContext({
    callSid: "test-realtime-society-fallback",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
    ownerGesellschaft: "   ",
  });
  assert.match(buildRealtimeInstructions(fallbackContext), /aus dem Hause Agentur Duic Sprockhövel/);
});

test("explicitly teaches the correct Duic pronunciation as Duitsch", () => {
  const ctx = newContext({
    callSid: "test-realtime-pronunciation",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /Duic.*Duitsch|Duitsch.*Duic/i);
  assert.match(instructions, /Nachname.*Duic.*Duitsch/i);
});

test("requires the PKV ten-year and retirement bridge after a contribution", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-projection",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /PKV-GESPRÄCHSZIEL/);
  assert.match(instructions, /HOCHRECHNUNG: 10-Jahres-Projektion/);
  assert.match(instructions, /KONZEPT: Persönlich und emotional/);
  assert.match(instructions, /Beitragsentwicklung in der Gesundheitsversorgung/);
  assert.doesNotMatch(instructions, /Wechsel in die PKV|Wechsel in die private Krankenversicherung/);
  assert.match(instructions, /Eine Frage pro Turn/);
});

test("requires the exact final goodbye phrase in the realtime instructions", () => {
  const ctx = newContext({
    callSid: "test-realtime-farewell",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /Vielen Dank für das Gespräch\. Auf Wiederhören\./);
  assert.doesNotMatch(instructions, /Danke Ihnen für das Gespräch.*auf Wiederhören/i);
});

test("uses the standard PKV flow in a strict order: relevance → appointment → preparation questions", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-flow",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);

  const relevanceIndex = instructions.search(/2\. RELEVANZ/);
  const appointmentIndex = instructions.search(/3\. TERMIN/);
  const preparationIndex = instructions.search(/4\. VORBEREITUNG NACH DEM TERMIN/);
  const contributionIndex = instructions.search(/5\. BEITRAG/);
  const projectionIndex = instructions.search(/6\. HOCHRECHNUNG/);
  const conceptIndex = instructions.search(/7\. KONZEPT/);

  assert.notEqual(relevanceIndex, -1);
  assert.notEqual(appointmentIndex, -1);
  assert.notEqual(preparationIndex, -1);
  assert.notEqual(contributionIndex, -1);
  assert.notEqual(projectionIndex, -1);
  assert.notEqual(conceptIndex, -1);
  assert.ok(relevanceIndex < appointmentIndex);
  assert.ok(appointmentIndex < preparationIndex);
  assert.ok(preparationIndex < contributionIndex);
  assert.ok(contributionIndex < projectionIndex);
  assert.ok(projectionIndex < conceptIndex);
  assert.match(instructions, /vor Ort|bei Ihnen vor Ort/i);
  assert.match(instructions, /Gesundheitsfragen.*nach dem Termin|nach dem Termin.*Gesundheitsfragen|nach einem bestätigten Termin/i);
});

test("keeps the prompt concise and avoids repeating customer wording", () => {
  const ctx = newContext({
    callSid: "test-realtime-prompt-style",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.doesNotMatch(instructions, /Wiederhole.*letzte Aussage|wiederhole.*letzte Aussage|Wiederhole.*Kunden|wiederhole.*Kunden/i);
  assert.doesNotMatch(instructions, /Bedanke dich|danke dir|Danke dir/i);
});

test("forces the ten-year projection before scheduling after a contribution", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-order",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({ role: "user", text: "Ich zahle tausend Euro.", at: 1 });
  ctx.transcript.push({ role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter.", at: 1.5 });

  const instruction = buildRequiredPkvSequenceInstruction(ctx);
  assert.match(instruction, /10 Jahre|Beitragsentwicklung/);
  assert.match(instruction, /KEIN Ruhestand|nur 10 Jahre/);

  ctx.transcript.push(
    { role: "assistant", text: "Bei 1000 Euro wären es in zehn Jahren ungefähr 1480 Euro.", at: 2 },
  );
  assert.match(buildRequiredPkvSequenceInstruction(ctx), /Wäre es nicht sinnvoll|Keine Terminfrage/);
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

test("requires the sensibilization and relevance question after permission to explain the call", () => {
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
  assert.match(instruction, /Beitragsentwicklung|wie nehmen Sie diese entwicklung wahr/i);
  assert.match(instruction, /Jahr für Jahr.*steigen|3-5% jährlich/);
  assert.doesNotMatch(instruction, /Tarifoptimierung|Wahltarife|Bonusprogramme/);
});

test("does not restore the full decision-maker introduction after interruption", () => {
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: true }), false);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: false }), false);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: false, playbackPending: true }), false);
});
