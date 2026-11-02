import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

test("CRM campaign import bypasses session redirect and stays isolated from other integration APIs", async () => {
  const campaignImport = await proxy(new NextRequest("https://gloria.example/api/integrations/crm/campaigns", {
    method: "POST",
  }));
  assert.equal(campaignImport.status, 200);
  assert.equal(campaignImport.headers.get("x-middleware-next"), "1");

  const companySync = await proxy(new NextRequest("https://gloria.example/api/integrations/crm/company-sync", {
    method: "POST",
  }));
  assert.equal(companySync.status, 307);
  assert.equal(new URL(companySync.headers.get("location")!).pathname, "/login");
});
