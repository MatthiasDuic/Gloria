import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import test, { mock } from "node:test";
import { createTelnyxCall, encodeTelnyxClientState } from "./telnyx";
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
