import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDeterministicPkvFlowReply,
  buildDeterministicPostBookingReply,
  buildTenYearProjectionLine,
  decideTurnRoute,
  isCustomerFarewell,
  isLikelyIncompleteCustomerThought,
  streamReply,
  parseGermanEuroAmount,
  type TurnOutput,
} from "./llm.js";
import { newContext, type CallContext } from "./state.js";
import { createInitialFlowState, observeAssistantFlowState, observeUserFlowState } from "./topic-policy.js";
import { extractConfirmedSlot } from "./telnyx-stream.js";

const LOCKED_SLOT = "Donnerstag, den dreiundzwanzigsten Juli um zehn Uhr dreißig";

function appendExchange(ctx: CallContext, assistant: TurnOutput, user: string): void {
  ctx.transcript.push({ role: "assistant", text: assistant.reply, at: Date.now() });
  ctx.transcript.push({ role: "user", text: user, at: Date.now() });
}

function nextReply(ctx: CallContext): TurnOutput {
  const reply = buildDeterministicPostBookingReply(ctx);
  assert.ok(reply);
  return reply;
}

test("locks the selected slot from the real confirmation wording", () => {
  assert.equal(
    extractConfirmedSlot(
      "Perfekt, ich habe Donnerstag, den dreiundzwanzigsten Juli um zehn Uhr dreißig für Sie reserviert.",
    ),
    LOCKED_SLOT,
  );
});

test("routes normal PKV turns to the worker and questions to OpenAI", () => {
  const ctx = newContext({
    callSid: "test-turn-router",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  assert.deepEqual(decideTurnRoute(ctx, "Schon sehr."), { route: "worker", reason: "structured_state" });
  assert.deepEqual(decideTurnRoute(ctx, "Wie genau wird das gemacht?"), { route: "openai", reason: "customer_question" });
  assert.deepEqual(decideTurnRoute(ctx, "Ich verstehe nicht, wie das funktionieren soll."), { route: "openai", reason: "customer_objection" });
  assert.deepEqual(decideTurnRoute(ctx, "Ja, aber wie macht Herr Duic das?"), { route: "worker", reason: "structured_state" });

  ctx.flow.stage = "scheduling";
  ctx.flow.awaiting = "appointment_selection";
  assert.deepEqual(decideTurnRoute(ctx, "Können wir auch den Dienstag nehmen?"), { route: "worker", reason: "structured_state" });
});

test("keeps a final ASR fragment from advancing the PKV flow", () => {
  assert.equal(isLikelyIncompleteCustomerThought("Gut, ich"), true);
  assert.equal(isLikelyIncompleteCustomerThought("Ich bin"), true);
  assert.equal(isLikelyIncompleteCustomerThought("Also..."), true);
  assert.equal(isLikelyIncompleteCustomerThought("Ja, das dürfen Sie."), false);
});

test("recognizes common caller farewells", () => {
  assert.equal(isCustomerFarewell("Auf Wiederhören."), true);
  assert.equal(isCustomerFarewell("Tschüss und einen schönen Tag."), true);
  assert.equal(isCustomerFarewell("Ich habe noch eine Frage."), false);
});

test("does not repeat the starting bridge after the projection question", () => {
  const ctx = newContext({
    callSid: "test-pkv-no-bridge-after-projection",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.flow.stage = "need_interest";
  ctx.flow.awaiting = "projection_interest";
  ctx.flow.projectionDelivered = true;
  ctx.transcript.push({
    role: "assistant",
    text: "Bei Ihrem aktuellen Beitrag entsteht über zehn Jahre voraussichtlich ein spürbarer Mehrbetrag. Wäre diese Klarheit für Sie ein echter Mehrwert?",
    at: 1,
  });

  const reply = buildDeterministicPkvFlowReply(ctx, "Ja");
  assert.ok(reply);
  assert.doesNotMatch(reply.reply, /setzt genau da an/);
  assert.match(reply.reply, /privat oder gesetzlich|Vormittag|Nachmittag|hilfreich/);
});

test("locks slot from 'ich trage ... ein' phrasing", () => {
  assert.equal(
    extractConfirmedSlot(
      "Super, ich trage Donnerstag, den 20. August um 17:30 Uhr für Sie ein.",
    ),
    "Donnerstag, den 20. August um 17:30 Uhr",
  );
});

test("runs qualification once, requires email, and closes with the locked slot", () => {
  const ctx = newContext({
    callSid: "test-call",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "private Krankenversicherung",
  });

  let reply = nextReply(ctx);
  assert.match(reply.reply, /einige kurze Fragen/);
  appendExchange(ctx, reply, "Ja.");

  const answers: Array<[RegExp, string]> = [
    [/Geburtsdatum/, "Zweiter Mai neunzehnhundertsiebenundachtzig."],
    [/Wie groß/, "Ein Meter achtundachtzig."],
    [/Verraten Sie mir noch Ihr aktuelles Gewicht/, "Zweiundneunzig Kilogramm."],
    [/Krankenversicherer/, "Bei der Barmenia."],
    [/Monatsbeitrag/, "Tausenddreihundert Euro."],
    [/Diagnosen/, "Nein."],
    [/Medikamente/, "Nein."],
    [/stationäre Aufenthalte/, "Nein."],
    [/psychische Behandlungen/, "Nein."],
    [/Zähne/, "Nein."],
    [/Allergien/, "Nein."],
  ];

  const askedQuestions: string[] = [];
  for (const [expectedQuestion, answer] of answers) {
    reply = nextReply(ctx);
    assert.match(reply.reply, expectedQuestion);
    assert.doesNotMatch(reply.reply, /vormittag|nachmittag|zwei termine/i);
    askedQuestions.push(reply.reply);
    appendExchange(ctx, reply, answer);
  }
  assert.equal(new Set(askedQuestions).size, answers.length);

  reply = nextReply(ctx);
  assert.match(reply.reply, /E-Mail-Adresse.*Terminbestätigung/);
  assert.equal(reply.hangup, false);
  appendExchange(ctx, reply, "max.neumann@example.de");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, false);
  assert.match(reply.reply, new RegExp(LOCKED_SLOT));
  assert.match(reply.reply, /max\.neumann@example\.de/);
  assert.doesNotMatch(reply.reply, /Auf Wiederhören!/);
  assert.doesNotMatch(reply.reply, /um neun Uhr\b/);

  appendExchange(ctx, reply, "Vielen Dank, auf Wiederhören.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, /Auf Wiederhören!/);
});

test("asks a health detail question after an affirmative allergy answer", () => {
  const ctx = newContext({
    callSid: "test-health-follow-up",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen.", at: 1 },
    { role: "user", text: "Ja.", at: 2 },
  );

  const questions = [
    "Wie lautet Ihr Geburtsdatum?",
    "Wie groß sind Sie?",
    "Verraten Sie mir noch Ihr aktuelles Gewicht?",
    "Bei welchem Krankenversicherer sind Sie aktuell versichert?",
    "Wie hoch ist Ihr aktueller Monatsbeitrag?",
    "Gibt es aktuell bekannte Diagnosen oder laufende Behandlungen?",
    "Nehmen Sie aktuell regelmäßig Medikamente ein?",
    "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
    "Gab es in den letzten zehn Jahren psychische Behandlungen oder entsprechende Diagnosen?",
    "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
    "Sind bei Ihnen Allergien bekannt?",
  ];

  for (const question of questions) {
    const reply = buildDeterministicPostBookingReply(ctx);
    assert.ok(reply);
    assert.equal(reply.reply, question);
    ctx.transcript.push(
      { role: "assistant", text: reply.reply, at: Date.now() },
      { role: "user", text: question.includes("Allergien") ? "Ja." : "Nein.", at: Date.now() },
    );
  }

  const allergyFollowUp = buildDeterministicPostBookingReply(ctx);
  assert.ok(allergyFollowUp);
  assert.equal(allergyFollowUp.reply, "Welche Allergien sind bei Ihnen bekannt?");
});

test("does not skip a health question after an incomplete answer", () => {
  const ctx = newContext({
    callSid: "test-health-incomplete-answer",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen.", at: 1 },
    { role: "user", text: "Ja.", at: 2 },
    { role: "assistant", text: "Nehmen Sie aktuell regelmäßig Medikamente ein?", at: 3 },
    { role: "user", text: "Nehmen Sie aktuell", at: 4 },
  );

  const reply = buildDeterministicPostBookingReply(ctx);
  assert.ok(reply);
  assert.equal(reply.reply, "Nehmen Sie aktuell regelmäßig Medikamente ein?");
});

test("continues with the first preparation question without consent reply", () => {
  const ctx = newContext({
    callSid: "test-post-booking-no-consent-reply",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "private Krankenversicherung",
  });

  const preparation = nextReply(ctx);
  assert.match(preparation.reply, /einige kurze Fragen/);
  appendExchange(ctx, preparation, "");

  const firstQuestion = nextReply(ctx);
  assert.match(firstQuestion.reply, /Geburtsdatum/);
});

test("does not end after an unusable email answer", () => {
  const ctx = newContext({
    callSid: "test-email",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
  });
  ctx.transcript.push(
    { role: "assistant", text: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?", at: 1 },
    { role: "user", text: "Nein.", at: 2 },
  );

  let reply = nextReply(ctx);
  assert.match(reply.reply, /E-Mail-Adresse/);
  appendExchange(ctx, reply, "Ja.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, false);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "max punkt neumann at example punkt de");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, false);
  assert.match(reply.reply, /max\.neumann@example\.de/);

  appendExchange(ctx, reply, "Tschüss.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, /Auf Wiederhören!/);
});

test("accepts spelled email suffix across multiple turns", () => {
  const ctx = newContext({
    callSid: "test-email-spelled-tld",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "gewerbliche Sachversicherung",
  });

  let reply = nextReply(ctx);
  assert.match(reply.reply, /E-Mail-Adresse/);
  appendExchange(ctx, reply, "Donnerstag.");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info at Musterbau");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Punkt d e.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, false);
  assert.match(reply.reply, /info@musterbau\.de/);

  appendExchange(ctx, reply, "Auf Wiederhören.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, /Auf Wiederhören!/);
});

test("closes once fragmented spoken email becomes complete", () => {
  const ctx = newContext({
    callSid: "test-email-real-fragmented",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "gewerbliche Sachversicherung",
  });

  let reply = nextReply(ctx);
  assert.match(reply.reply, /E-Mail-Adresse/);
  appendExchange(ctx, reply, "Donnerstag.");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info at");

  reply = nextReply(ctx);
  assert.match(reply.reply, /noch nicht vollständig verstanden/);
  appendExchange(ctx, reply, "Info at Musterbau Punkt d e.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, false);
  assert.match(reply.reply, /info@musterbau\.de/);

  appendExchange(ctx, reply, "Tschüss.");

  reply = nextReply(ctx);
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, /Auf Wiederhören!/);
});

test("skips the PKV catalog for other campaign topics", () => {
  const ctx = newContext({
    callSid: "test-non-pkv",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "Energie",
  });

  const reply = nextReply(ctx);
  assert.match(reply.reply, /E-Mail-Adresse/);
  assert.doesNotMatch(reply.reply, /einige kurze Fragen|Geburtsdatum|Medikamente/);
});

test("parses spoken euro amounts deterministically", () => {
  assert.equal(parseGermanEuroAmount("Tausendzweihundertachtzig Euro."), 1280);
  assert.equal(parseGermanEuroAmount("980 Euro"), 980);
  assert.equal(parseGermanEuroAmount("zweitausendeinhundert euro"), 2100);
});

test("builds a concrete ten year projection line", () => {
  const line = buildTenYearProjectionLine(1280);
  assert.match(line, /eintausendzweihundertachtzig Euro/);
  assert.match(line, /zehn Jahren/);
  assert.match(line, /rund eintausendneunhundert Euro/);
  assert.match(line, /etwa sechshundertzwanzig Euro mehr/);
});

test("builds PKV relevance before asking insurance questions", () => {
  const ctx = newContext({
    callSid: "test-pkv-discovery-order",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push({
    role: "assistant",
    text: "Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?",
    at: 1,
  });

  let reply = buildDeterministicPkvFlowReply(ctx, "Ja, das dürfen Sie.");
  assert.ok(reply);
  assert.match(reply.reply, /Beiträge in der Gesundheitsversorgung/);
  assert.match(reply.reply, /PKV-Verbands/);
  assert.match(reply.reply, /drei bis fünf Prozent/);
  assert.match(reply.reply, /Unternehmer und Selbstständige/);
  assert.doesNotMatch(reply.reply, /privat oder gesetzlich/);
  ctx.transcript.push({ role: "user", text: "Ja, das dürfen Sie.", at: 2 }, { role: "assistant", text: reply.reply, at: 3 });

  reply = buildDeterministicPkvFlowReply(ctx, "Das merkt man schon.");
  assert.ok(reply);
  assert.match(reply.reply, /mit welchem Beitrag Sie angefangen haben/);
  assert.match(reply.reply, /Das höre ich oft/);
  assert.match(reply.reply, /welchen Beitrag Sie heute zahlen/);
  assert.match(reply.reply, /prognostiziert bei gleichbleibender Entwicklung/);
  assert.match(reply.reply, /Haben Sie sich das schon einmal detailliert angeschaut/);
  assert.doesNotMatch(reply.reply, /privat oder gesetzlich/);
  ctx.transcript.push({ role: "user", text: "Das merkt man schon.", at: 4 }, { role: "assistant", text: reply.reply, at: 5 });

  reply = buildDeterministicPkvFlowReply(ctx, "Das weiß ich nicht mehr.");
  assert.ok(reply);
  assert.match(reply.reply, /prognostiziert/);
  assert.match(reply.reply, /Herr Duic setzt genau da an/);
  assert.doesNotMatch(reply.reply, /privat oder gesetzlich/);
});

test("acknowledges the PKV how-question with a concrete answer", () => {
  const ctx = newContext({
    callSid: "test-pkv-how-question",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.flow.stage = "need_interest";
  ctx.flow.awaiting = "projection_interest";
  ctx.flow.projectionDelivered = true;
  ctx.transcript.push({
    role: "assistant",
    text: "Wäre diese Klarheit für Sie ein echter Mehrwert?",
    at: 1,
  });

  const reply = buildDeterministicPkvFlowReply(ctx, "Ich denke schon, aber wie will Herr Duich das machen?");
  assert.ok(reply);
  assert.match(reply.reply, /Ja, genau darum geht es/);
  assert.match(reply.reply, /eigenen Zahlen/);
  assert.doesNotMatch(reply.reply, /grundsätzlich hilfreich/);

  const asrVariant = buildDeterministicPkvFlowReply(ctx, "Ja, aber ich frage mich, wie er das machen möchte.");
  assert.ok(asrVariant);
  assert.match(asrVariant.reply, /Ja, genau darum geht es/);

  const spokenVariant = buildDeterministicPkvFlowReply(ctx, "Ja, aber wie macht er das?");
  assert.ok(spokenVariant);
  assert.match(spokenVariant.reply, /Ja, genau darum geht es/);
});

test("corrects an unsupported percentage claim before OpenAI", async () => {
  const ctx = newContext({
    callSid: "test-pkv-factual-correction",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  const reply = await streamReply(ctx, "Wie kommst du auf die 30 Prozent?", () => undefined);
  assert.match(reply.reply, /zu pauschal formuliert/);
  assert.match(reply.reply, /eigenen Beitragsentwicklung/);
});

test("answers a split how-question after the ASR continuation arrives", () => {
  const ctx = newContext({
    callSid: "test-pkv-split-how-question",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.flow.stage = "need_interest";
  ctx.flow.awaiting = "projection_interest";
  ctx.flow.projectionDelivered = true;
  ctx.transcript.push({ role: "user", text: "Ja, ich kann mir nur nicht vorstellen, wie Herr Duitsch", at: 1 });

  const reply = buildDeterministicPkvFlowReply(ctx, "das machen möchte.");
  assert.ok(reply);
  assert.match(reply.reply, /Ja, genau darum geht es/);
  assert.doesNotMatch(reply.reply, /spürbarer Mehrbetrag/);
});

test("does not schedule while the customer thought is unfinished", () => {
  const ctx = newContext({
    callSid: "test-pkv-incomplete-interest",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.flow.stage = "need_interest";
  ctx.flow.awaiting = "projection_interest";
  ctx.flow.projectionDelivered = true;
  ctx.transcript.push({
    role: "assistant",
    text: "Wäre diese Klarheit für Sie ein echter Mehrwert?",
    at: 1,
  });

  assert.equal(buildDeterministicPkvFlowReply(ctx, "Ja, wenn ich diese"), null);
  assert.equal(buildDeterministicPkvFlowReply(ctx, "Klarheit bekommen würde, also ich kann mir nicht vorstellen, wie"), null);
});

test("stream path keeps PKV structure after contribution-rise response", async () => {
  const ctx = newContext({
    callSid: "test-pkv-stream-order",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?", at: 1 },
    { role: "user", text: "Ja, das dürfen Sie.", at: 2 },
    {
      role: "assistant",
      text: "Danke. Wie Sie sicherlich gemerkt haben, steigen die Beiträge in der Gesundheitsversorgung Jahr für Jahr. Nach Angaben des PKV-Verbands liegen die jährlichen Beitragsanpassungen im Durchschnitt häufig bei etwa drei bis fünf Prozent. Gerade für Unternehmer und Selbstständige ist damit Planbarkeit wichtig. Wie stark spüren Sie diese Entwicklung bei sich?",
      at: 3,
    },
  );

  const segments: string[] = [];
  const reply = await streamReply(ctx, "Die Beiträge steigen Jahr für Jahr.", (segment) => segments.push(segment));
  assert.match(reply.reply, /Wenn Sie zurückblicken/);
  assert.equal(segments.length, 1);
  assert.equal(segments.join(" "), reply.reply);
  assert.doesNotMatch(reply.reply, /privat oder gesetzlich/);
});

test("does not repeat the starting-contribution bridge after a partial answer", () => {
  const ctx = newContext({
    callSid: "test-pkv-no-discovery-loop",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Wie stark spüren Sie diese Entwicklung bei sich?", at: 1 },
    { role: "user", text: "Die Beiträge steigen jedes", at: 2 },
    {
      role: "assistant",
      text: "Das ist nachvollziehbar. Wenn Sie zurückblicken: Erinnern Sie sich noch, mit welchem Beitrag Sie angefangen haben? Und schauen Sie einmal, bei welchem Beitrag Sie mittlerweile gelandet sind.",
      at: 3,
    },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Jahr und man merkt das schon.");
  assert.ok(reply);
  assert.match(reply.reply, /detailliert angeschaut/);
});

test("does not ask for the current contribution before the insurance question", () => {
  const ctx = newContext({
    callSid: "test-pkv-current-follow-up",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Wie stark spüren Sie diese Entwicklung bei sich?", at: 1 },
    { role: "user", text: "Die Beiträge steigen jedes Jahr.", at: 2 },
    { role: "assistant", text: "Mit welchem Beitrag haben Sie angefangen?", at: 3 },
    { role: "user", text: "Das weiß ich nicht mehr.", at: 4 },
    { role: "assistant", text: "Haben Sie sich das schon einmal detailliert angeschaut?", at: 5 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Nein, bisher.");
  assert.ok(reply);
  assert.match(reply.reply, /privat oder gesetzlich/);
  assert.doesNotMatch(reply.reply, /Bei welchem Beitrag liegen Sie aktuell/);
});

test("does not merge repeated email corrections into a malformed address", () => {
  const ctx = newContext({
    callSid: "test-email-correction-retry",
    streamSid: "test-stream",
    confirmedSlotPhrase: LOCKED_SLOT,
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Für die Vorbereitung würde ich Ihnen noch einige kurze Fragen stellen.", at: 1 },
    { role: "user", text: "Nein.", at: 2 },
    { role: "assistant", text: "Welche E-Mail-Adresse darf ich für die Terminbestätigung notieren?", at: 3 },
    { role: "user", text: "Neumann at Musterbau Punkt d.", at: 4 },
    { role: "assistant", text: "Ich habe die E-Mail-Adresse noch nicht vollständig verstanden.", at: 5 },
    { role: "user", text: "Neumann at Musterbau Punkt", at: 6 },
    { role: "assistant", text: "Ich habe neumann@musterbau.d.neumann verstanden. Ist diese E-Mail-Adresse korrekt?", at: 7 },
    { role: "user", text: "d e.", at: 8 },
  );

  const reply = buildDeterministicPostBookingReply(ctx);
  assert.ok(reply);
  assert.match(reply.reply, /neumann@musterbau\.de/);
  assert.doesNotMatch(reply.reply, /Terminbestätigung erfolgt wie besprochen ohne E-Mail/);
  assert.doesNotMatch(reply.reply, /d\.neumann|musterbau\.d\.neumann/);
});

test("does not treat the remembered starting contribution as current", () => {
  const ctx = newContext({
    callSid: "test-pkv-starting-contribution",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Wie stark spüren Sie diese Entwicklung bei sich?", at: 0 },
    { role: "user", text: "Man nimmt das so hin.", at: 0.5 },
    { role: "assistant", text: "Mit welchem Beitrag haben Sie einmal angefangen?", at: 1 },
    { role: "user", text: "Ja, mit sechshundert Euro.", at: 2 },
    { role: "assistant", text: "Haben Sie sich das schon einmal detailliert angeschaut?", at: 3 },
    { role: "user", text: "Nein.", at: 4 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Nein.");
  assert.ok(reply);
  assert.match(reply.reply, /privat oder gesetzlich/);

  ctx.transcript.push(
    { role: "assistant", text: reply.reply, at: 5 },
    { role: "user", text: "Gesetzlich.", at: 6 },
  );
  const currentContributionQuestion = buildDeterministicPkvFlowReply(ctx, "Gesetzlich.");
  assert.ok(currentContributionQuestion);
  assert.match(currentContributionQuestion.reply, /aktueller Monatsbeitrag/);
  assert.doesNotMatch(currentContributionQuestion.reply, /Zehn-Jahres-Prognose/);
});

test("ends a clear PKV rejection without transferring", () => {
  const ctx = newContext({
    callSid: "test-pkv-rejection",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell eher privat oder gesetzlich versichert?", at: 1 },
    { role: "user", text: "Gesetzlich.", at: 2 },
    { role: "assistant", text: "Wie hoch ist Ihr aktueller Monatsbeitrag?", at: 3 },
    { role: "user", text: "Tausendzweihundert Euro.", at: 4 },
    { role: "assistant", text: "Bei 1200 Euro liegen Sie in zehn Jahren voraussichtlich höher. Wäre eine kurze persönliche Zehn-Jahres-Prognose für Sie hilfreich?", at: 5 },
    { role: "user", text: "Nein?", at: 6 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Nein?");
  assert.ok(reply);
  assert.equal(reply.hangup, true);
  assert.equal(reply.transfer, false);
  assert.doesNotMatch(reply.reply, /verbinden|durchstellen/);
});

test("flow state records only the current contribution", () => {
  let state = createInitialFlowState("private Krankenversicherung");
  state = observeAssistantFlowState(state, "Mit welchem Beitrag haben Sie einmal angefangen?");
  state = observeUserFlowState(state, "Sechshundert Euro.");
  assert.equal(state.contributionKnown, false);
  assert.equal(state.pkvData.startingContribution, 600);
  assert.equal(state.pkvData.currentContribution, undefined);

  state = observeAssistantFlowState(state, "Wie hoch ist Ihr aktueller Monatsbeitrag?");
  state = observeUserFlowState(state, "Tausendzweihundert Euro.");
  assert.equal(state.contributionKnown, true);
  assert.equal(state.pkvData.currentContribution, 1200);
});

test("moves from the concrete projection to scheduling after an affirmative answer", () => {
  let state = createInitialFlowState("private Krankenversicherung");
  state.insuranceKnown = true;
  state.contributionKnown = true;
  state.stage = "need_projection";
  state.awaiting = "current_contribution";

  state = observeAssistantFlowState(
    state,
    "Wenn man von rund vier Prozent pro Jahr ausgeht, lägen eintausend Euro in zehn Jahren höher. Wäre diese Klarheit für Sie hilfreich?",
  );
  assert.equal(state.stage, "need_interest");
  assert.equal(state.awaiting, "projection_interest");

  state = observeUserFlowState(state, "Ja.");
  assert.equal(state.interestConfirmed, true);
  assert.equal(state.stage, "ready_for_schedule");
});

test("offers and locks only supplied calendar slots", () => {
  const ctx = newContext({
    callSid: "test-pkv-slots",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: [
      "FREIE TERMIN-VORSCHLÄGE:",
      "- Mittwoch, den neunzehnten August um zehn Uhr",
      "- Donnerstag, den zwanzigsten August um vierzehn Uhr",
      "- Freitag, den einundzwanzigsten August um elf Uhr",
    ].join("\n"),
  });
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell eher privat oder gesetzlich versichert?", at: 1 },
    { role: "user", text: "Gesetzlich.", at: 2 },
    { role: "assistant", text: "Wie hoch ist Ihr aktueller Monatsbeitrag?", at: 3 },
    { role: "user", text: "Tausendzweihundert Euro.", at: 4 },
    { role: "assistant", text: "Bei 1200 Euro liegen Sie in zehn Jahren voraussichtlich höher. Wäre eine kurze persönliche Zehn-Jahres-Prognose für Sie hilfreich?", at: 5 },
    { role: "user", text: "Ja, gerne.", at: 6 },
  );

  let reply = buildDeterministicPkvFlowReply(ctx, "Vormittag");
  assert.ok(reply);
  assert.match(reply.reply, /anhand Ihrer Zahlen|diese Klarheit/);
  ctx.transcript.push({ role: "assistant", text: reply.reply, at: 7 }, { role: "user", text: "Ja, gerne.", at: 8 });
  reply = buildDeterministicPkvFlowReply(ctx, "Vormittag");
  assert.ok(reply);
  assert.match(reply.reply, /Mittwoch, den neunzehnten August um zehn Uhr/);
  assert.match(reply.reply, /Freitag, den einundzwanzigsten August um elf Uhr/);
  assert.doesNotMatch(reply.reply, /Donnerstag, den zwanzigsten/);

  ctx.transcript.push({ role: "assistant", text: reply.reply, at: 9 }, { role: "user", text: "Den zweiten.", at: 10 });
  reply = buildDeterministicPkvFlowReply(ctx, "Den zweiten.");
  assert.ok(reply);
  assert.match(reply.reply, /Freitag, den einundzwanzigsten August um elf Uhr/);

});

test("selects a supplied slot from spoken weekday and time", () => {
  const ctx = newContext({
    callSid: "test-pkv-spoken-slot",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: [
      "- Donnerstag, den zwanzigsten August um zwölf Uhr dreißig",
      "- Donnerstag, den zwanzigsten August um vierzehn Uhr",
    ].join("\n"),
  });
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell privat oder gesetzlich versichert?", at: 0 },
    { role: "user", text: "Privat.", at: 0.5 },
    { role: "assistant", text: "Wie hoch ist Ihr aktueller Monatsbeitrag?", at: 0.75 },
    { role: "user", text: "Neunhundertsiebzig Euro.", at: 0.9 },
    { role: "assistant", text: "Bei neunhundertsiebzig Euro liegt der Beitrag in zehn Jahren voraussichtlich höher. Stellen Sie sich vor: Sie und Herr Duic sitzen nächste Woche zusammen. Wäre diese Klarheit für Sie ein echter Mehrwert?", at: 1 },
    { role: "user", text: "Ja, gerne.", at: 1.5 },
    { role: "assistant", text: "Wie wäre es mit Donnerstag, den zwanzigsten August um zwölf Uhr dreißig oder Donnerstag, den zwanzigsten August um vierzehn Uhr?", at: 2 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Vierzehn Uhr am Donnerstag geht.");
  assert.ok(reply);
  assert.match(reply.reply, /notiere/);
  assert.match(reply.reply, /vierzehn Uhr/);
});

test("keeps the offered slots after an unclear time answer", () => {
  const ctx = newContext({
    callSid: "test-pkv-slot-retry",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: [
      "- Freitag, den einundzwanzigsten August um zwölf Uhr",
      "- Freitag, den einundzwanzigsten August um dreizehn Uhr dreißig",
    ].join("\n"),
  });
  ctx.flow.stage = "scheduling";
  ctx.flow.awaiting = "appointment_selection";
  ctx.flow.pkvData = {
    insuranceStatus: "gkv",
    currentContribution: 900,
    interest: "positive",
  };
  ctx.flow.insuranceKnown = true;
  ctx.flow.contributionKnown = true;
  ctx.flow.projectionDelivered = true;
  ctx.flow.interestConfirmed = true;
  const offered = "Wie wäre es mit Freitag, den einundzwanzigsten August um zwölf Uhr oder Freitag, den einundzwanzigsten August um dreizehn Uhr dreißig?";
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell privat oder gesetzlich versichert?", at: 0 },
    { role: "user", text: "Gesetzlich.", at: 0.5 },
    { role: "assistant", text: offered, at: 1 },
    { role: "user", text: "Drei Uhr dreißig klingt gut.", at: 2 },
    { role: "assistant", text: "Welcher der beiden Termine passt Ihnen besser?", at: 3 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Den zweiten.");
  assert.ok(reply);
  assert.match(reply.reply, /notiere Freitag.*dreizehn Uhr dreißig/);
});

test("never invents a slot when the requested weekday is unavailable", () => {
  const ctx = newContext({
    callSid: "test-pkv-unavailable-weekday",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: [
      "- Montag, den vierundzwanzigsten August um neun Uhr",
      "- Montag, den vierundzwanzigsten August um zehn Uhr dreißig",
    ].join("\n"),
  });
  ctx.flow.stage = "scheduling";
  ctx.flow.awaiting = "appointment_selection";
  ctx.flow.insuranceKnown = true;
  ctx.flow.contributionKnown = true;
  ctx.flow.projectionDelivered = true;
  ctx.flow.interestConfirmed = true;
  ctx.transcript.push({
    role: "assistant",
    text: "Wie wäre es mit Montag, den vierundzwanzigsten August um neun Uhr oder Montag, den vierundzwanzigsten August um zehn Uhr dreißig?",
    at: 1,
  });

  const reply = buildDeterministicPkvFlowReply(ctx, "Können wir auch den Dienstag nehmen?");
  assert.ok(reply);
  assert.match(reply.reply, /keinen freien Termin/);
  assert.match(reply.reply, /Montag, den vierundzwanzigsten August um neun Uhr/);
  assert.match(reply.reply, /Montag, den vierundzwanzigsten August um zehn Uhr dreißig/);
  assert.doesNotMatch(reply.reply, /Dienstag, den fünfundzwanzigsten August/);
});

test("holds incomplete insurance ASR until the caller continues", () => {
  const ctx = newContext({
    callSid: "test-pkv-incomplete-insurance",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.flow.stage = "need_insurance";
  ctx.flow.awaiting = "insurance_status";
  ctx.transcript.push({ role: "assistant", text: "Sind Sie aktuell privat oder gesetzlich versichert?", at: 1 });

  const reply = buildDeterministicPkvFlowReply(ctx, "Ich bin");
  assert.equal(reply, null);
});

test("never asks to choose unnamed appointment slots", () => {
  const ctx = newContext({
    callSid: "test-pkv-no-slots",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell eher privat oder gesetzlich versichert?", at: 1 },
    { role: "user", text: "Gesetzlich.", at: 2 },
    { role: "assistant", text: "Wie hoch ist Ihr aktueller Monatsbeitrag?", at: 3 },
    { role: "user", text: "Tausendzweihundert Euro.", at: 4 },
    { role: "assistant", text: "Bei 1200 Euro liegen Sie in zehn Jahren voraussichtlich höher. Wäre eine kurze persönliche Zehn-Jahres-Prognose für Sie hilfreich?", at: 5 },
    { role: "user", text: "Ja, gerne.", at: 6 },
    { role: "assistant", text: "Passt für Sie eher ein Termin am Vormittag oder am Nachmittag?", at: 7 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Vormittag");
  assert.ok(reply);
  assert.doesNotMatch(reply.reply, /welcher der beiden|welcher Termin/);
  assert.match(reply.reply, /Kalender|Moment/);
});

test("runs a complete PKV acquisition scenario through structured state", async () => {
  const ctx = newContext({
    callSid: "test-pkv-full-scenario",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: [
      "- Mittwoch, den neunzehnten August um zehn Uhr",
      "- Freitag, den einundzwanzigsten August um elf Uhr",
    ].join("\n"),
  });
  ctx.transcript.push({ role: "assistant", text: "Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?", at: 1 });

  const turn = async (userText: string): Promise<string> => {
    ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
    ctx.flow = observeUserFlowState(ctx.flow, userText);
    const reply = await streamReply(ctx, userText, () => undefined);
    ctx.transcript.push({ role: "assistant", text: reply.reply, at: Date.now() });
    ctx.flow = observeAssistantFlowState(ctx.flow, reply.reply);
    return reply.reply;
  };

  assert.match(await turn("Ja, das dürfen Sie."), /Beiträge in der Gesundheitsversorgung/);
  assert.match(await turn("Ja, das spüre ich."), /mit welchem Beitrag/);
  assert.match(await turn("Mit sechshundert Euro."), /detailliert angeschaut/);
  assert.match(await turn("Nein."), /privat oder gesetzlich/);
  assert.match(await turn("Gesetzlich."), /aktueller Monatsbeitrag/);
  assert.match(await turn("Tausendzweihundertachtzig Euro."), /eintausendzweihundertachtzig Euro/);
  assert.equal(ctx.flow.pkvData.currentContribution, 1280);
  assert.equal(ctx.flow.projectionDelivered, true);
  assert.equal(ctx.flow.awaiting, "projection_interest");
  const afterInterest = await turn("Ja, gerne.");
  assert.match(afterInterest, /Vormittag|Nachmittag/);
  assert.equal(ctx.flow.pkvData.interest, "positive");
  assert.equal(ctx.flow.stage, "scheduling");
  assert.match(await turn("Vormittag."), /Mittwoch|Freitag/);
  assert.equal(ctx.flow.pkvData.startingContribution, 600);
  assert.equal(ctx.flow.pkvData.currentContribution, 1280);
  assert.equal(ctx.flow.pkvData.insuranceStatus, "gkv");
  assert.equal(ctx.flow.pkvData.interest, "positive");
  assert.equal(ctx.flow.pkvData.appointmentPreference, "morning");
});

test("uses concrete projection after captured PKV contribution", () => {
  const ctx = newContext({
    callSid: "test-pkv-projection",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  ctx.flow.insuranceKnown = true;
  ctx.flow.contributionKnown = true;
  ctx.flow.stage = "need_projection";
  ctx.transcript.push(
    { role: "assistant", text: "Sind Sie aktuell eher privat oder gesetzlich versichert?", at: 1 },
    { role: "user", text: "Ich bin gesetzlich versichert.", at: 2 },
    { role: "assistant", text: "In welcher Größenordnung liegt Ihr aktueller Monatsbeitrag?", at: 3 },
    { role: "user", text: "Tausendzweihundertachtzig Euro.", at: 4 },
  );

  const reply = buildDeterministicPkvFlowReply(ctx, "Tausendzweihundertachtzig Euro.");
  assert.ok(reply);
  assert.match(reply.reply, /eintausendzweihundertachtzig Euro/);
  assert.match(reply.reply, /rund eintausendneunhundert Euro/);
  assert.match(reply.reply, /anhand Ihrer Zahlen/);
  assert.doesNotMatch(reply.reply, /drei aufeinander aufbauende Gespräche/);
  assert.match(reply.reply, /anhand Ihrer Zahlen|diese Klarheit/);
});

test("answers PKV value objection with concrete benefit before scheduling", () => {
  const ctx = newContext({
    callSid: "test-pkv-value",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  ctx.flow.insuranceKnown = true;
  ctx.flow.contributionKnown = true;
  ctx.flow.projectionDelivered = true;
  ctx.flow.stage = "need_interest";

  const reply = buildDeterministicPkvFlowReply(ctx, "Was hab ich davon?");
  assert.ok(reply);
  assert.match(reply.reply, /drei Dinge/);
  assert.match(reply.reply, /Hochrechnung/);
  assert.doesNotMatch(reply.reply, /Vormittag|Nachmittag|Termin am/);
});

test("does not restart PKV discovery after interest or during scheduling", () => {
  const ctx = newContext({
    callSid: "test-pkv-no-discovery-restart",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
    freeSlotsPrompt: "- Dienstag, den fünfundzwanzigsten August um neun Uhr\n- Dienstag, den fünfundzwanzigsten August um zehn Uhr",
  });

  ctx.flow.stage = "need_interest";
  ctx.flow.awaiting = "projection_interest";
  ctx.flow.insuranceKnown = true;
  ctx.flow.contributionKnown = true;
  ctx.flow.projectionDelivered = true;
  ctx.flow.pkvData = {
    insuranceStatus: "gkv",
    currentContribution: 1000,
  };
  ctx.transcript.push({
    role: "assistant",
    text: "Wäre diese Klarheit für Sie ein echter Mehrwert?",
    at: 1,
  });

  const afterInterest = buildDeterministicPkvFlowReply(ctx, "Ja.");
  ctx.flow.pkvData.interest = "positive";
  ctx.flow.interestConfirmed = true;
  ctx.flow.stage = "scheduling";
  ctx.flow.awaiting = "appointment_preference";
  assert.ok(afterInterest);
  assert.doesNotMatch(afterInterest.reply, /privat oder gesetzlich/);

  ctx.transcript.push({ role: "assistant", text: afterInterest.reply, at: 2 });

  const duringScheduling = buildDeterministicPkvFlowReply(ctx, "Ja.");
  assert.ok(duringScheduling);
  assert.doesNotMatch(duringScheduling.reply, /privat oder gesetzlich/);
});

test("prefers email path when customer asks for information by mail", () => {
  const ctx = newContext({
    callSid: "test-pkv-mail",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  const reply = buildDeterministicPkvFlowReply(ctx, "Schicken Sie mir einfach was per Mail.");
  assert.ok(reply);
  assert.match(reply.reply, /E-Mail/);
  assert.doesNotMatch(reply.reply, /privat oder gesetzlich|Vormittag|Nachmittag/);
});

test("asks directly for email after user accepts email offer", () => {
  const ctx = newContext({
    callSid: "test-pkv-mail-accept",
    streamSid: "test-stream",
    topic: "private Krankenversicherung",
  });

  ctx.transcript.push({
    role: "assistant",
    text: "Gerne. Ich kann Ihnen eine kurze Übersicht per E-Mail senden.",
    at: 1,
  });

  const reply = buildDeterministicPkvFlowReply(ctx, "Ja, das dürfen Sie.");
  assert.ok(reply);
  assert.match(reply.reply, /Welche E-Mail-Adresse/);
  assert.doesNotMatch(reply.reply, /Vor-Ort-Termin|privat oder gesetzlich/);
});