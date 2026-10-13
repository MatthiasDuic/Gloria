import assert from "node:assert/strict";
import test from "node:test";
import { encodeTelnyxClientState } from "./telnyx";

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
