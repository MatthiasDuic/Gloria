import assert from "node:assert/strict";
import test from "node:test";
import { buildDeterministicPostBookingReply, type TurnOutput } from "./llm.js";
import { newContext, type CallContext } from "./state.js";
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
    [/Gewicht/, "Zweiundneunzig Kilogramm."],
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
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, new RegExp(LOCKED_SLOT));
  assert.match(reply.reply, /max\.neumann@example\.de/);
  assert.match(reply.reply, /Auf Wiederhören!/);
  assert.doesNotMatch(reply.reply, /um neun Uhr\b/);
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
  assert.equal(reply.hangup, true);
  assert.match(reply.reply, /max\.neumann@example\.de/);
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