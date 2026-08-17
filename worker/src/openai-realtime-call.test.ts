import assert from "node:assert/strict";
import test from "node:test";
import { buildRealtimeInstructions, canConfirmRealtimeAppointment, openAiAudioFormat } from "./openai-realtime-call.js";
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
    { role: "assistant", text: "Im ersten Termin erklärt Herr Duic seine Arbeitsweise und analysiert Ihren Vertrag. Ist diese Klarheit für Sie sinnvoll?", at: 6 },
  );
  return ctx;
}

test("maps the configured bidirectional codec to Realtime audio", () => {
  assert.equal(openAiAudioFormat("PCMU"), "audio/pcmu");
  assert.equal(openAiAudioFormat("PCMA"), "audio/pcma");
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
  assert.match(instructions, /kurze Einordnung zum Thema private Krankenversicherung/);
});
