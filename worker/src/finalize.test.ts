import assert from "node:assert/strict";
import test from "node:test";
import { deriveResultDetail, extractReport, parseRelativeCallbackAt, parseSlotPhraseToIso, persistAppointmentBooking, postReport } from "./finalize.js";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { newContext } from "./state.js";

function resultCtx(userTexts: string[], extra: Partial<Parameters<typeof newContext>[0]> = {}) {
  const ctx = newContext({ callSid: "result-test", streamSid: "test", company: "Testfirma", topic: "Test", ...extra });
  ctx.transcript = userTexts.map((text, index) => ({ role: "user" as const, text, at: index }));
  return ctx;
}

test("derives a one-word result describing what happened on the call", () => {
  const noContact = "Nicht erreicht / kein Kontakt" as const;
  const aborted = "Gespräch abgebrochen" as const;
  assert.equal(deriveResultDetail(resultCtx(["Ja, gerne."]), "Termin"), "Termin");
  assert.equal(deriveResultDetail(resultCtx(["Kein Interesse."]), "Absage"), "Absage");
  assert.equal(deriveResultDetail(resultCtx(["Ja, Neumann hier, worum geht es denn?"], { humanContactDetected: true }), aborted), "Aufgelegt");
  assert.equal(deriveResultDetail(resultCtx(["Hinterlassen Sie bitte eine Nachricht nach dem Signalton."], {
    detectedVoicemail: true, endedByGloria: true, endReason: "voicemail_detected",
  }), noContact), "Anrufbeantworter");
  assert.equal(deriveResultDetail(resultCtx(["Willkommen bei Muster. Für den Vertrieb drücken Sie die 1, für den Service die 2."]), noContact), "Telefonmenü");
  assert.equal(deriveResultDetail(resultCtx(["Bitte warten Sie, Sie befinden sich in der Warteschleife."], { queueDetected: true }), noContact), "Warteschleife");
  assert.equal(deriveResultDetail(resultCtx(["Guten Tag, hier ist die digitale Assistentin der Firma Muster. Wie kann ich Ihnen helfen?"], {
    humanContactDetected: true,
  }), aborted), "KI-Assistent");
  assert.equal(deriveResultDetail(resultCtx(["Sind Sie eine KI-Assistentin? Na gut, worum geht es?"], { humanContactDetected: true }), aborted), "Aufgelegt");
  assert.equal(deriveResultDetail(resultCtx(["Der ist nicht da, geben Sie mir Ihre Nummer."], {
    humanContactDetected: true, waitingForDecisionMaker: true, callbackNumberDelivered: true, endedByGloria: true,
  }), aborted), "Rückrufnummer");
  assert.equal(deriveResultDetail(resultCtx(["Herr Neumann ist heute leider nicht im Haus."], {
    humanContactDetected: true, waitingForDecisionMaker: true, endedByGloria: true, endReason: "farewell",
  }), aborted), "Abwesend");
  assert.equal(deriveResultDetail(resultCtx([], { endedByGloria: true, endReason: "transfer_timeout" }), noContact), "Stille");
  assert.equal(deriveResultDetail(resultCtx([]), noContact), "Aufgelegt");
  assert.equal(deriveResultDetail(resultCtx(["Hallo?"], { endedByGloria: true, endReason: "error" }), noContact), "Fehler");
});

test("accepts model time forms but never silently substitutes midnight for a missing time", () => {
  const canonical = parseSlotPhraseToIso("Dienstag, 10. November um 08:30 Uhr");
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November, 8:30"), canonical);
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November um 8:30"), canonical);
  assert.equal(parseSlotPhraseToIso("Dienstag, 10. November"), undefined);
});

test("persists booking before confirmation and rejects a success response without the stored appointment", async () => {
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const oldBase = process.env.APP_BASE_URL;
  const oldToken = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_BASE_URL = "https://booking.test";
  process.env.APP_INTERNAL_TOKEN = "test-token";
  setGlobalDispatcher(agent);
  try {
    const appointmentAt = "2026-11-10T07:30:00.000Z";
    const ctx = newContext({ callSid: "booking-test", streamSid: "test", userId: "test-user", company: "Testfirma", topic: "Test" });
    agent.get("https://booking.test").intercept({
      path: "/api/calls/webhook", method: "POST",
      body: (raw) => {
        const data = JSON.parse(raw);
        return data.outcome === "Termin" && data.appointmentAt === appointmentAt
          && data.appointmentMode === "Beim Kunden vor Ort" && data.userId === "test-user"
          && typeof data.summaryChunk === "string" && !data.summary;
      },
    }).reply(200, { ok: true, report: { outcome: "Termin", appointmentAt } });
    assert.equal(await persistAppointmentBooking(ctx, appointmentAt, "Beim Kunden vor Ort"), true);
    agent.get("https://booking.test").intercept({ path: "/api/calls/webhook", method: "POST" })
      .reply(200, { ok: true, report: {} });
    assert.equal(await persistAppointmentBooking(ctx, appointmentAt, "Beim Kunden vor Ort"), false);
    agent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    if (oldBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = oldToken;
    await agent.close();
  }
});

test("fallback outcomes distinguish voicemail and queues from human conversations", async () => {
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const oldBase = process.env.APP_BASE_URL;
  const oldToken = process.env.APP_INTERNAL_TOKEN;
  const oldOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.APP_BASE_URL = "https://finalize.test";
  process.env.APP_INTERNAL_TOKEN = "test-token";
  process.env.OPENAI_API_KEY = "test-key";
  setGlobalDispatcher(agent);

  const scenarios = [
    {
      name: "voicemail",
      text: "Bitte hinterlassen Sie eine Nachricht nach dem Ton.",
      voicemail: true,
      queue: false,
      outcome: "Nicht erreicht / kein Kontakt",
      disposition: "Anrufbeantworter",
      conversation: false,
    },
    {
      name: "voicemail-split",
      intro: "Guten Tag, hier ist der Anschluss von Frau Beispiel.",
      text: "Bitte hinterlassen Sie eine Nachricht nach dem Ton.",
      voicemail: true,
      queue: false,
      outcome: "Nicht erreicht / kein Kontakt",
      disposition: "Anrufbeantworter",
      conversation: false,
    },
    {
      name: "queue",
      text: "Einen Moment bitte, ich verbinde Sie.",
      voicemail: false,
      queue: true,
      outcome: "Nicht erreicht / kein Kontakt",
      disposition: "Warteschleife ohne Gespraech",
      conversation: false,
    },
    {
      name: "human",
      text: "Guten Tag, hier ist eine Mitarbeiterin.",
      voicemail: false,
      queue: false,
      outcome: "Gespräch abgebrochen",
      disposition: "Gespraech",
      conversation: true,
    },
    {
      name: "rejection",
      text: "Nein danke, ich habe kein Interesse.",
      voicemail: false,
      queue: false,
      outcome: "Absage",
      disposition: "Gespraech",
      conversation: true,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const finalReports: Array<Record<string, unknown>> = [];
      const pool = agent.get("https://finalize.test");
      pool.intercept({ path: "/api/calls/webhook", method: "POST" }).reply(200, { ok: true });
      pool.intercept({ path: "/api/calls/webhook", method: "POST" }).reply((options) => {
        finalReports.push(JSON.parse(String(options.body)) as Record<string, unknown>);
        return { statusCode: 200, data: { ok: true } };
      });

      const ctx = newContext({
        callSid: scenario.name, streamSid: "test", userId: "test-user", company: "Testfirma", topic: "Test",
      });
      ctx.detectedVoicemail = scenario.voicemail;
      ctx.queueDetected = scenario.queue;
      if (scenario.intro) {
        ctx.transcript.push({ role: "user", text: scenario.intro, at: Date.now() - 1000 });
      }
      ctx.transcript.push({ role: "user", text: scenario.text, at: Date.now() });
      await postReport(ctx);

      assert.equal(finalReports.length, 1, scenario.name);
      assert.equal(finalReports[0].outcome, scenario.outcome, scenario.name);
      assert.equal(finalReports[0].callDisposition, scenario.disposition, scenario.name);
      assert.equal(finalReports[0].conversationOccurred, scenario.conversation, scenario.name);
    }
    agent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    if (oldBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = oldBase;
    if (oldToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = oldToken;
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAiKey;
    await agent.close();
  }
});

test("parses the exact numeric calendar slot used by the appointment controller", () => {
  const parsed = parseSlotPhraseToIso("Donnerstag, 31. Dezember um 13:00 Uhr");
  assert.match(parsed || "", /-12-31T12:00:00\.000Z$/);
});

test("resolves a relative callback time from the caller's agreed utterance", () => {
  const callerSpokeAt = Date.parse("2026-10-13T12:14:00.000Z");
  const parsed = parseRelativeCallbackAt([
    { role: "assistant", text: "Wann passt es Ihnen besser, dass ich zurückrufe?", at: callerSpokeAt - 5_000 },
    { role: "user", text: "In zehn Minuten wäre gut.", at: callerSpokeAt },
    { role: "assistant", text: "Dann melde ich mich in zehn Minuten noch einmal. Passt das?", at: callerSpokeAt + 2_000 },
    { role: "user", text: "Ja, das passt.", at: callerSpokeAt + 4_000 },
  ]);

  assert.equal(parsed, "2026-10-13T12:24:00.000Z");
});

test("does not turn an unrelated relative time into a callback", () => {
  const parsed = parseRelativeCallbackAt([
    { role: "assistant", text: "Wie läuft Ihre Woche?", at: 1_000 },
    { role: "user", text: "In zehn Minuten beginnt mein Termin.", at: 2_000 },
  ]);

  assert.equal(parsed, undefined);
});

test("an offered incoming callback neither schedules an outgoing call nor uses the owner's number as direct dial", async () => {
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  const oldOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  setGlobalDispatcher(agent);
  const nextCallAt = "2026-11-10T09:00:00.000Z";
  const pool = agent.get("https://api.openai.com");
  pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, {
    choices: [{ message: { content: JSON.stringify({
      outcome: "Wiedervorlage", nextCallAt, directDial: "01701234567", summary: "Die Zielperson ruft zurück.",
    }) } }],
  }).times(2);
  pool.intercept({ path: "/v1/chat/completions", method: "POST" }).reply(200, {
    choices: [{ message: { content: JSON.stringify({
      outcome: "Nicht erreicht / kein Kontakt", summary: "Die Zielperson ruft zurück.",
    }) } }],
  });
  try {
    const ctx = newContext({ callSid: "incoming-callback", streamSid: "test", ownerRealPhone: "+491701234567" });
    ctx.transcript.push(
      { role: "user", text: "Wenn Sie Ihre Nummer hinterlassen, wird er Sie in zehn Minuten zurückrufen.", at: 1_000 },
      { role: "assistant", text: "Die Nummer lautet plus vier neun, eins sieben null, eins zwei drei, vier fünf sechs, sieben.", at: 2_000 },
    );
    const incoming = await extractReport(ctx);
    assert.equal(incoming?.nextCallAt, undefined);
    assert.equal(incoming?.directDial, undefined);

    ctx.transcript.push({ role: "user", text: "Rufen Sie mich stattdessen morgen zurück.", at: 3_000 });
    const outgoing = await extractReport(ctx);
    assert.equal(outgoing?.nextCallAt, nextCallAt);
    assert.equal(outgoing?.directDial, undefined);

    ctx.transcript.pop();
    const misclassified = await extractReport(ctx);
    assert.equal(misclassified?.outcome, "Gespräch abgebrochen");
    assert.equal(misclassified?.nextCallAt, undefined);
    agent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    if (oldOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAiKey;
    await agent.close();
  }
});
