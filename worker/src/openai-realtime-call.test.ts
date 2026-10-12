import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeInstructions, buildRealtimeResponseInstructions, buildRequiredPkvSequenceInstruction, canConfirmRealtimeAppointment, hasAffirmedAssistantEndQuestion, isLikelyIncompleteAssistantTurn, isLikelyNoiseTranscript, isOfferedSlotPhrase, isSyntheticTranscriptionPrompt, normalizePkvTerminology, openAiAudioFormat, shouldRecoverInterruptedBargeIn, shouldRestoreDecisionMakerIntro } from "./openai-realtime-call.js";
import { shouldRetryElevenLabsStream } from "./elevenlabs-tts.js";
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

test("recovers once when a barge-in produces only the configured transcription prompt", () => {
  const syntheticPrompt = "Deutsches Telefonat zur Beitragsentwicklung in der Gesundheitsversorgung. Achte besonders auf Eigennamen, Firmennamen, Neumann, Duic, Zahlen, Euro-Beträge.";
  assert.equal(shouldRecoverInterruptedBargeIn(true, syntheticPrompt), true);
  assert.equal(shouldRecoverInterruptedBargeIn(false, syntheticPrompt), false);
  assert.equal(shouldRecoverInterruptedBargeIn(true, "Ja, sagen Sie bitte."), false);
});

test("accepts a direct answer to an end question without asking twice", () => {
  const ctx = buildPkvContext();
  ctx.transcript.push(
    { role: "assistant", text: "Möchten Sie das Gespräch jetzt beenden?", at: 9 },
    { role: "user", text: "Ja.", at: 10 },
  );
  assert.equal(hasAffirmedAssistantEndQuestion(ctx), true);

  ctx.transcript.push(
    { role: "assistant", text: "Soll der Termin am Montag stattfinden?", at: 11 },
    { role: "user", text: "Ja.", at: 12 },
  );
  assert.equal(hasAffirmedAssistantEndQuestion(ctx), false);
});

test("retries only fast ElevenLabs failures before any audio was streamed", () => {
  assert.equal(shouldRetryElevenLabsStream(new Error("fetch failed"), 0, 0), true);
  assert.equal(shouldRetryElevenLabsStream(new Error("ElevenLabs TTS antwortete 502"), 0, 0), true);
  assert.equal(shouldRetryElevenLabsStream(new Error("ElevenLabs stream stalled after 6s"), 0, 0), false);
  assert.equal(shouldRetryElevenLabsStream(new Error("fetch failed"), 320, 0), false);
  assert.equal(shouldRetryElevenLabsStream(new Error("fetch failed"), 0, 1), false);
  assert.equal(shouldRetryElevenLabsStream(new Error("The operation was aborted"), 0, 0), false);
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
  if (!result.ok) assert.match(result.reason, /Herr Duic|interessant/);
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
  assert.match(instructions, /Eine eindeutige Auswahl[^.]+ist bereits verbindlich/);
  assert.match(instructions, /verlange kein zusätzliches Ja/);
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

test("speaks euro cents and the singular euro amount correctly", () => {
  const response = buildRealtimeResponseInstructions(
    newContext({ callSid: "test-euro-cents", streamSid: "test-stream", topic: "private Krankenversicherung" }),
    "Der Beitrag beträgt 1.250,50 Euro, der andere Betrag ist 1 Euro.",
    false,
  );
  assert.match(response, /eintausend zweihundert fünfzig Euro und fünfzig Cent/);
  assert.match(response, /ein Euro/);
  assert.doesNotMatch(response, /1\.250,50 Euro|eins Euro/);
});

test("includes the required decision-maker and gatekeeper opening lines", () => {
  const ctx = newContext({
    callSid: "test-realtime-opening",
    streamSid: "test-stream",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);
  assert.match(instructions, /Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin von Herrn Matthias Duic aus dem Hause der Barmenia Gothar/);
  assert.match(instructions, /Auch wenn Sie das vielleicht öfter hören.*anders als die anderen/);
  assert.match(instructions, /Es geht um die Beitragsentwicklung in der Gesundheitsversorgung.*kurzen Moment/);
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
  assert.match(instructions, /HOCHRECHNUNG:.*Zehn-Jahres-Beispielrechnung/);
  assert.match(instructions, /ÜBERLEITUNG:.*Herr Duic/);
  assert.match(instructions, /Beitragsentwicklung in der Gesundheitsversorgung/);
  assert.doesNotMatch(instructions, /Beitragsentwicklung in der privaten Krankenversicherung/i);
  assert.match(instructions, /PROSODIE:.*menschlich.*hörbar warm/);
  assert.match(instructions, /digital per Microsoft Teams oder bei der Kundin\/dem Kunden vor Ort/);
  assert.doesNotMatch(instructions, /in unserer Agentur oder per Microsoft Teams/);
  assert.match(instructions, /Herr Duic klärt Ihre Fragen dazu im Termin/);
  assert.doesNotMatch(instructions, /Wechsel in die PKV|Wechsel in die private Krankenversicherung/);
  assert.match(instructions, /Eine Frage pro Turn/);
});

test("canonicalizes generated PKV wording before it is spoken", () => {
  assert.equal(
    normalizePkvTerminology("Die Beitragsentwicklung in der privaten Krankenversicherung betrifft uns alle."),
    "Die Beitragsentwicklung in der Gesundheitsversorgung betrifft uns alle.",
  );
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

test("uses the requested PKV flow before appointment preparation", () => {
  const ctx = newContext({
    callSid: "test-realtime-pkv-flow",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const instructions = buildRealtimeInstructions(ctx);

  const reasonIndex = instructions.search(/2\. ANLASS UND EINSTIEGSBEITRAG/);
  const currentContributionIndex = instructions.search(/3\. HEUTIGER BEITRAG/);
  const projectionIndex = instructions.search(/4\. HOCHRECHNUNG/);
  const conceptIndex = instructions.search(/5\. ÜBERLEITUNG/);
  const appointmentIndex = instructions.search(/6\. TERMIN/);
  const preparationIndex = instructions.search(/7\. ABSCHLUSS/);

  assert.notEqual(reasonIndex, -1);
  assert.notEqual(currentContributionIndex, -1);
  assert.notEqual(projectionIndex, -1);
  assert.notEqual(conceptIndex, -1);
  assert.notEqual(appointmentIndex, -1);
  assert.notEqual(preparationIndex, -1);
  assert.ok(reasonIndex < currentContributionIndex);
  assert.ok(currentContributionIndex < projectionIndex);
  assert.ok(projectionIndex < conceptIndex);
  assert.ok(conceptIndex < appointmentIndex);
  assert.ok(appointmentIndex < preparationIndex);
  assert.match(instructions, /bei der Kundin\/dem Kunden vor Ort|bei Ihnen vor Ort/i);
  assert.doesNotMatch(instructions, /bei Ihnen vor Ort, in unserer Agentur/);
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
  ctx.transcript.push({ role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?", at: 0.5 });
  ctx.transcript.push({ role: "user", text: "Ich zahle tausend Euro.", at: 1 });
  ctx.transcript.push({ role: "assistant", text: "Im Ersttermin lernen wir uns kennen und nehmen den Ist-Zustand auf. Im Zweittermin zeigen wir ein persönliches Konzept für Beitragsstabilität und Bezahlbarkeit im Alter.", at: 1.5 });

  const instruction = buildRequiredPkvSequenceInstruction(ctx);
  assert.match(instruction, /zehn Jahre|Beitragsentwicklung/);
  assert.match(instruction, /hochgerechnet\?/);

  ctx.transcript.push(
    { role: "assistant", text: "Bei 1000 Euro wären es in zehn Jahren ungefähr 1480 Euro.", at: 2 },
  );
  assert.match(buildRequiredPkvSequenceInstruction(ctx), /Wäre es für Sie interessant/);
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

test("continues with the contribution trend after consent without repeating the topic", () => {
  const ctx = newContext({
    callSid: "test-realtime-concept-bridge",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Es geht um die Beitragsentwicklung in der Gesundheitsversorgung. Haben Sie gerade einen kurzen Moment?", at: 1 },
    { role: "user", text: "Ja, einen kurzen Moment habe ich.", at: 2 },
  );
  const rawInstruction = buildRequiredPkvSequenceInstruction(ctx);
  const instruction = buildRealtimeResponseInstructions(ctx);
  assert.doesNotMatch(rawInstruction, /Es geht um die Beitragsentwicklung in der Gesundheitsversorgung/);
  assert.match(rawInstruction, /Laut PKV Verband/);
  assert.match(instruction, /Beiträge in der Gesundheitsversorgung/);
  assert.match(instruction, /drei bis fünf Prozent/);
  assert.doesNotMatch(instruction, /Tarifoptimierung|Wahltarife|Bonusprogramme/);
});

test("does not label the initial contribution as the current contribution", () => {
  const ctx = newContext({
    callSid: "test-pkv-initial-vs-current-contribution",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({ role: "user", text: "Damals waren es 420 Euro.", at: 1 });
  const beforeCurrentQuestion = buildRealtimeResponseInstructions(ctx, undefined, false);
  assert.doesNotMatch(beforeCurrentQuestion, /Aktueller Monatsbeitrag/);

  ctx.transcript.push(
    { role: "assistant", text: "Und welchen Beitrag zahlen Sie heute?", at: 2 },
    { role: "user", text: "Heute zahle ich 980 Euro.", at: 3 },
  );
  const afterCurrentAnswer = buildRealtimeResponseInstructions(ctx, undefined, false);
  assert.match(afterCurrentAnswer, /Aktueller Monatsbeitrag: neunhundert achtzig Euro/);
  assert.doesNotMatch(afterCurrentAnswer, /Aktueller Monatsbeitrag: vierhundert zwanzig Euro/);
});

test("does not restore the full decision-maker introduction after interruption", () => {
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: true }), false);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: true, playbackPending: false }), false);
  assert.equal(shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse: false, playbackPending: true }), false);
});
