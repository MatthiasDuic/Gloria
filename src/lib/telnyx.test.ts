import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import test, { mock } from "node:test";
import { Pool } from "pg";
import { createTelnyxCall, encodeTelnyxClientState, resolveCallOwnerIdentity } from "./telnyx";
import { CampaignOutsideHoursError } from "./campaign-schedule";
import { extractTelnyxPublicKey, verifyTelnyxWebhook } from "./telnyx-webhook-auth";
import { POST as receiveTelnyxEvent } from "../app/api/telnyx/events/route";

test("worker contexts carry a tamper-evident bounded signature", () => {
  const previous = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_INTERNAL_TOKEN = "fixture-stream-secret";
  try {
    const state = JSON.parse(Buffer.from(encodeTelnyxClientState({ to: "+492339555100", company: "Fixture", topic: "Test" }), "base64").toString("utf8"));
    const { streamSignature, ...unsigned } = state;
    assert.equal(streamSignature, createHmac("sha256", "fixture-stream-secret").update(JSON.stringify(unsigned)).digest("hex"));
    assert.ok(state.streamExpiresAt > Date.now());
    assert.ok(state.streamExpiresAt <= Date.now() + 24 * 60 * 60_000);
  } finally {
    if (previous === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previous;
  }
});

test("accepts documented public-key response envelopes without accepting malformed keys", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  for (const body of [{ data: { public: key } }, { data: { public_key: key } }, { data: { key } }, { public_key: key }, { data: key }, { data: [{ public_key: key }] }]) {
    assert.equal(extractTelnyxPublicKey(body), key);
  }
  assert.equal(extractTelnyxPublicKey({ data: { key: "invalid" } }), undefined);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|{}`), privateKey).toString("base64") });
  for (const encoded of [der.toString("base64"), der.subarray(-32).toString("hex")]) {
    const extracted = extractTelnyxPublicKey({ data: { public_key: encoded } });
    assert.ok(extracted);
    assert.equal(verifyTelnyxWebhook("{}", headers, extracted), true);
  }
});

test("signed Telnyx events start only the live stream, never an audio recording", async () => {
  const previousKey = process.env.TELNYX_PUBLIC_KEY;
  const previousApiKey = process.env.TELNYX_API_KEY;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" }).toString();
  process.env.TELNYX_API_KEY = "fixture";
  const commands: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    commands.push(String(url));
    return new Response("{}", { status: 200 });
  });
  try {
    for (const eventType of ["call.answered", "call.recording.saved"]) {
      const body = JSON.stringify({ data: { id: eventType, event_type: eventType, payload: { call_control_id: "call-fixture", recording_url: "https://example.test/recording.mp3" } } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = new Headers({ "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64") });
      assert.equal(verifyTelnyxWebhook(body, headers, process.env.TELNYX_PUBLIC_KEY), true);
      assert.equal(verifyTelnyxWebhook(`${body} `, headers, process.env.TELNYX_PUBLIC_KEY), false);
      assert.equal(verifyTelnyxWebhook(body, headers, process.env.TELNYX_PUBLIC_KEY, Date.now() + 600_000), false);
      assert.equal((await receiveTelnyxEvent(new Request("https://example.test/api/telnyx/events", { method: "POST", headers, body }))).status, 200);
    }
    assert.equal(commands.length, 1);
    assert.match(commands[0], /streaming_start$/);
    assert.equal((await receiveTelnyxEvent(new Request("https://example.test/api/telnyx/events", { method: "POST", body: "{}" }))).status, 401);
  } finally {
    mock.restoreAll();
    if (previousKey === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = previousKey;
    if (previousApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousApiKey;
  }
});

test("answers inbound call.initiated events and handles missing direction compatibly", async () => {
  const previousKey = process.env.TELNYX_PUBLIC_KEY;
  const previousApiKey = process.env.TELNYX_API_KEY;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  process.env.TELNYX_PUBLIC_KEY = publicKey.export({ format: "pem", type: "spki" }).toString();
  process.env.TELNYX_API_KEY = "fixture";
  const commands: string[] = [];
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    commands.push(String(url));
    return new Response("{}", { status: 200 });
  });
  try {
    const cases = [
      { name: "outgoing", direction: "outgoing", answer: false },
      { name: "incoming", direction: "incoming", answer: true },
      { name: "incoming-with-state", direction: "incoming", clientState: { userId: "owner" }, answer: true },
      { name: "unknown-outgoing", clientState: { userId: "owner" }, answer: false },
      { name: "unknown-incoming", answer: true },
      { name: "malformed-direction", direction: 42, clientState: { queueId: "queue" }, answer: false },
    ];
    for (const scenario of cases) {
      const payload = {
        call_control_id: `call-${scenario.name}`,
        direction: scenario.direction,
        client_state: scenario.clientState ? Buffer.from(JSON.stringify(scenario.clientState)).toString("base64") : undefined,
      };
      const body = JSON.stringify({ data: { event_type: "call.initiated", payload } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = new Headers({ "telnyx-timestamp": timestamp, "telnyx-signature-ed25519": sign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString("base64") });
      const previousCommands = commands.length;
      assert.equal((await receiveTelnyxEvent(new Request("https://example.test/api/telnyx/events", { method: "POST", headers, body }))).status, 200);
      assert.equal(commands.length - previousCommands, scenario.answer ? 1 : 0, scenario.name);
      if (scenario.answer) assert.match(commands.at(-1) || "", new RegExp(`call-${scenario.name}/actions/answer$`));
    }
  } finally {
    mock.restoreAll();
    if (previousKey === undefined) delete process.env.TELNYX_PUBLIC_KEY;
    else process.env.TELNYX_PUBLIC_KEY = previousKey;
    if (previousApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousApiKey;
  }
});

test("campaign calls cannot contact Telnyx at or after 17:30 Berlin time", async () => {
  const previousSlots = process.env.CAMPAIGN_SLOTS;
  const previousTimezone = process.env.CAMPAIGN_TIMEZONE;
  delete process.env.CAMPAIGN_SLOTS;
  delete process.env.CAMPAIGN_TIMEZONE;
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T16:30:00Z") });
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  try {
    await assert.rejects(createTelnyxCall({
      to: "+492339555100",
      company: "Fixture",
      topic: "private Krankenversicherung",
      leadId: "campaign-contact",
    }), CampaignOutsideHoursError);
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
    if (previousSlots === undefined) delete process.env.CAMPAIGN_SLOTS;
    else process.env.CAMPAIGN_SLOTS = previousSlots;
    if (previousTimezone === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = previousTimezone;
  }
});

test("passes the actually called phone number to the media worker", () => {
  const encoded = encodeTelnyxClientState({
    to: "+49 170 1234567",
    company: "Musterbau GmbH",
    topic: "private Krankenversicherung",
  });

  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    calledPhone?: string;
  };
  assert.equal(decoded.calledPhone, "+49 170 1234567");
});

test("passes the call owner's role, full name and callback number in the signed media context", () => {
  const encoded = encodeTelnyxClientState({
    to: "+492339555100",
    company: "Fixture",
    topic: "Test",
    userId: "normal",
    ownerRole: "user",
    ownerRealName: "Erika Mustermann",
    ownerRealPhone: "+491701234567",
  });
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    ownerRole?: string;
    ownerRealName?: string;
    ownerRealPhone?: string;
  };
  assert.equal(decoded.ownerRole, "user");
  assert.equal(decoded.ownerRealName, "Erika Mustermann");
  assert.equal(decoded.ownerRealPhone, "+491701234567");
});

test("rejects malformed owner phone values instead of making up a number from embedded digits", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  let realPhone = "+49 (0)170 1234567";
  mock.method(Pool.prototype, "query", async (sql: string) => ({
    rows: /FROM users\s+WHERE id = \$1/.test(sql)
      ? [{ id: "normal", username: "normal", real_name: "Erika Mustermann", real_phone: realPhone, role: "user" }]
      : [],
    rowCount: 1,
  }));
  try {
    assert.equal((await resolveCallOwnerIdentity("normal")).realPhone, "+491701234567");
    realPhone = "Telefon: 0170 1234567";
    assert.equal((await resolveCallOwnerIdentity("normal")).realPhone, undefined);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("call dispatch refreshes the owner's role, name and callback number from the database", async () => {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    TELNYX_API_KEY: process.env.TELNYX_API_KEY,
    TELNYX_CONNECTION_ID: process.env.TELNYX_CONNECTION_ID,
    TELNYX_PHONE_NUMBER: process.env.TELNYX_PHONE_NUMBER,
    APP_BASE_URL: process.env.APP_BASE_URL,
    APP_INTERNAL_TOKEN: process.env.APP_INTERNAL_TOKEN,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    WORKER_HEALTHCHECK_URL: process.env.WORKER_HEALTHCHECK_URL,
  };
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.TELNYX_API_KEY = "test-key";
  process.env.TELNYX_CONNECTION_ID = "test-connection";
  process.env.TELNYX_PHONE_NUMBER = "+492339555100";
  process.env.APP_BASE_URL = "https://app.example.test";
  process.env.APP_INTERNAL_TOKEN = "test-token";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.WORKER_HEALTHCHECK_URL = "https://worker.example.test/health";
  mock.method(Pool.prototype, "query", async (sql: string) => {
    if (/FROM users\s+WHERE id = \$1/.test(sql)) {
      return {
        rows: [{
          id: "normal", username: "normal", real_name: "Erika Mustermann", company_name: "Testagentur",
          real_phone: "0170 1234567", password_hash: "test", role: "user", created_at: "2026-01-01T00:00:00.000Z",
        }],
        rowCount: 1,
      };
    }
    if (/FROM phone_numbers\s+WHERE user_id = \$1/.test(sql)) {
      return {
        rows: [{ id: "phone", user_id: "normal", phone_number: "+492339555100", label: "Test", active: true }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  let state: { ownerRole?: string; ownerRealName?: string; ownerRealPhone?: string; userId?: string } | undefined;
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/telnyx/topic-policies")) {
      return Response.json({ topicPolicies: [{ topic: "Test", opener: "", discovery: "", objectionHandling: "", close: "" }] });
    }
    if (url.includes("/phone_numbers?")) return Response.json({ data: [{ phone_number: "+492339555100" }] });
    if (url.endsWith("/calls") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { client_state: string };
      state = JSON.parse(Buffer.from(body.client_state, "base64").toString("utf8"));
      return Response.json({ data: { call_control_id: "test-call" } });
    }
    if (url.includes("/health") || url.includes("/api/calendar/busy") || url.includes("/v1/models")) {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected test request: ${url}`);
  });
  try {
    const result = await createTelnyxCall({
      to: "+492339555200",
      company: "Testfirma",
      topic: "Test",
      userId: "normal",
      ownerRole: "master",
      ownerRealName: "Veralteter Name",
      ownerRealPhone: "+491111111111",
      callSource: "manual",
    });
    assert.equal(result.sid, "test-call");
    assert.deepEqual(state && {
      userId: state.userId, ownerRole: state.ownerRole, ownerRealName: state.ownerRealName, ownerRealPhone: state.ownerRealPhone,
    }, { userId: "normal", ownerRole: "user", ownerRealName: "Erika Mustermann", ownerRealPhone: "+491701234567" });
  } finally {
    mock.restoreAll();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a call without an identifiable owner or configured full name is not started", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  mock.method(Pool.prototype, "query", async (sql: string) => ({
    rows: /FROM users\s+WHERE id = \$1/.test(sql)
      ? [{ id: "normal", username: "normal", real_name: "", company_name: "Testagentur", password_hash: "test", role: "user" }]
      : [],
    rowCount: 0,
  }));
  const fetch = mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected network request");
  });
  try {
    const base = { to: "+492339555200", company: "Testfirma", topic: "Test", callSource: "manual" as const };
    await assert.rejects(createTelnyxCall(base), /keinen zugeordneten Benutzer/);
    await assert.rejects(createTelnyxCall({ ...base, userId: "normal" }), /vollständigen Namen/);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("preserves the call origin for campaigns, manual calls and automatic manual callbacks", () => {
  const base = { to: "+492339555100", company: "Fixture", topic: "bKV" };
  const decode = (encoded: string) => JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.equal(decode(encodeTelnyxClientState(base)).callSource, "manual");
  assert.equal(decode(encodeTelnyxClientState({ ...base, leadId: "crm" })).callSource, "crm");
  assert.equal(decode(encodeTelnyxClientState({ ...base, leadId: "crm", isTestCall: true })).callSource, "manual");
  assert.equal(decode(encodeTelnyxClientState({ ...base, leadId: "manual-callback", callSource: "manual", isCallback: true })).callSource, "manual");
});

test("includes the queue id so Telnyx events can release the reserved call slot", () => {
  const encoded = encodeTelnyxClientState({
    to: "+492339555100",
    company: "Fixture",
    topic: "bKV",
    queueId: "queue-123",
  });
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    queueId?: string;
  };
  assert.equal(decoded.queueId, "queue-123");
});
