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
