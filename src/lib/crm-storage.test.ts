import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Lead } from "./types";
import { buildCrmCalendarEntries, getCallSource, isLeadCustomer } from "./crm-helpers.ts";

let storage: typeof import("./storage");
let fixtureDirectory: string;
const originalDirectory = process.cwd();
const originalEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL: process.env.VERCEL,
};
const sampleLead: Lead = {
  id: "prospect", userId: "test-user", company: "Fixture GmbH", phone: "+492339555100",
  topic: "bKV", status: "neu", attempts: 0, lifecycle: "prospect",
  listId: "campaign", listName: "Testkampagne",
};

before(async () => {
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), "gloria-crm-storage-"));
  process.chdir(fixtureDirectory);
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  process.env.NODE_ENV = "test";
  await mkdir(path.join(fixtureDirectory, "data"));
  storage = await import("./storage.ts");
});

after(async () => {
  process.chdir(originalDirectory);
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function seed(leads: Lead[]) {
  await writeFile(path.join(fixtureDirectory, "data", "leads.json"), JSON.stringify(leads));
  await writeFile(path.join(fixtureDirectory, "data", "campaign-state.json"), JSON.stringify({
    lists: [{ listId: "campaign", listName: "Testkampagne", userId: "test-user", active: true }],
  }));
  await writeFile(path.join(fixtureDirectory, "data", "conversation-events.json"), "[]");
  await writeFile(path.join(fixtureDirectory, "data", "report-database.json"), JSON.stringify({ reports: [], recordings: [] }));
  await writeFile(path.join(fixtureDirectory, "data", "reports.json"), "[]");
}

test("repeated final reports do not count one physical call as multiple attempts", async () => {
  await seed([{ ...sampleLead, attempts: 1, status: "angerufen" }]);
  const report = {
    callSid: "idempotent-call", leadId: sampleLead.id, userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic,
  };
  await storage.storeCallReport({ ...report, summaryChunk: "Anruf gestartet.", attempts: 1 });
  for (let attempt = 0; attempt < 3; attempt++) {
    await storage.storeCallReport({ ...report, summary: "Nicht erreicht.", outcome: "Nicht erreicht / kein Kontakt" });
  }
  const lead = await storage.getLeadById(sampleLead.id, sampleLead.userId);
  assert.equal(lead?.attempts, 1);
  assert.equal(lead?.status, "wiedervorlage");
});

test("a named successor is saved for the next call without dropping other contacts", async () => {
  await seed([{ ...sampleLead, contactName: "Herr Alt", contactNames: ["Herr Alt", "Frau Andere"] }]);
  const payload = {
    callSid: "successor-call", leadId: sampleLead.id, userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic, contactName: "Frau Neu",
    previousContactName: "Herr Alt", successorContactName: "Frau Neu",
    summary: "Herr Alt ist ausgeschieden. Frau Neu ist zuständig.",
    outcome: "Wiedervorlage" as const, nextCallAt: "2026-11-09T10:00:00Z",
  };
  await storage.storeCallReport(payload);
  await storage.storeCallReport(payload);
  const lead = await storage.getLeadById(sampleLead.id, sampleLead.userId);
  assert.equal(lead?.contactName, "Frau Neu");
  assert.deepEqual(lead?.contactNames, ["Frau Neu", "Frau Andere"]);
});

test("mailbox reports schedule one-day then three-day callbacks and stop at the third attempt", async () => {
  for (const attempts of [1, 2, 3]) {
    await seed([{ ...sampleLead, attempts, status: "angerufen" }]);
    const payload = {
      callSid: `mailbox-${attempts}`, userId: sampleLead.userId, leadId: sampleLead.id,
      company: sampleLead.company, topic: sampleLead.topic,
      summary: "Anrufbeantworter: Sprechen Sie nach dem Ton.",
      outcome: "Nicht erreicht / kein Kontakt" as const, callDisposition: "Anrufbeantworter",
    };
    const before = new Date();
    const expected = new Date(before);
    expected.setHours(9, 0, 0, 0);
    expected.setDate(expected.getDate() + (attempts === 2 ? 3 : 1));
    const report = await storage.storeCallReport(payload);
    const lead = await storage.getLeadById(sampleLead.id, sampleLead.userId);
    assert.equal(lead?.attempts, attempts);
    assert.equal(lead?.status, attempts === 3 ? "absage" : "wiedervorlage");
    assert.equal(lead?.nextCallAt, attempts === 3 ? undefined : expected.toISOString());
    assert.equal(report.nextCallAt, lead?.nextCallAt);
    const repeated = await storage.storeCallReport(payload);
    assert.equal(repeated.nextCallAt, report.nextCallAt);
    assert.equal((await storage.getLeadById(sampleLead.id, sampleLead.userId))?.attempts, attempts);
  }
});

test("a manual mailbox call creates a durable callback lead and honors the same attempt cap", async () => {
  await seed([]);
  const call = {
    callSource: "manual" as const, callSid: "manual-mailbox", userId: sampleLead.userId,
    company: "Manueller Kontakt", topic: "Eigenes Thema", calledPhone: sampleLead.phone,
  };
  await storage.storeCallReport({ ...call, summaryChunk: "Anruf gestartet." });
  const report = await storage.storeCallReport({
    ...call, summary: "Anrufbeantworter erkannt.", outcome: "Nicht erreicht / kein Kontakt", callDisposition: "Anrufbeantworter",
  });
  assert.ok(report.leadId);
  const lead = await storage.getLeadById(report.leadId, sampleLead.userId);
  assert.equal(lead?.callSource, "manual");
  assert.equal(lead?.phone, sampleLead.phone);
  assert.equal(lead?.status, "wiedervorlage");
  assert.equal(lead?.nextCallAt, report.nextCallAt);
  const third = await storage.storeCallReport({
    ...call, callSid: "manual-mailbox-third", leadId: report.leadId, attempts: 3,
    summary: "Anrufbeantworter erkannt.", outcome: "Nicht erreicht / kein Kontakt", callDisposition: "Anrufbeantworter",
  });
  assert.equal(third.nextCallAt, undefined);
  assert.equal((await storage.getLeadById(report.leadId, sampleLead.userId))?.status, "absage");
});

test("the complete webhook persists mailbox follow-up planning instead of dropping the disposition", async () => {
  await seed([{ ...sampleLead, status: "angerufen", attempts: 1 }]);
  const previous = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_INTERNAL_TOKEN = "mailbox-fixture";
  try {
    const { POST } = await import("../app/api/calls/webhook/route");
    const response = await POST(new Request("http://localhost/api/calls/webhook", {
      method: "POST", headers: { "content-type": "application/json", "x-gloria-internal-token": "mailbox-fixture" },
      body: JSON.stringify({
        callSid: "mailbox-webhook", leadId: sampleLead.id, userId: sampleLead.userId,
        company: sampleLead.company, topic: sampleLead.topic,
        summary: "Bitte sprechen Sie nach dem Ton.", outcome: "Nicht erreicht / kein Kontakt", callDisposition: "Anrufbeantworter",
      }),
    }));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.report.nextCallAt);
    assert.equal((await storage.getLeadById(sampleLead.id, sampleLead.userId))?.status, "wiedervorlage");
  } finally {
    if (previous === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previous;
  }
});

test("own calendar API validates intervals, reserves 90 minutes, persists updates and isolates users", async () => {
  const { POST, GET, DELETE } = await import("../app/api/calendar/events/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  const cookie = (id: string) => `${SESSION_COOKIE_NAME}=${createSessionToken({ id, username: id, role: "user", realName: "", companyName: "", gesellschaft: "" })}`;
  const request = (method: string, body?: object, user = "calendar-a", id?: string) => new Request(`http://localhost/api/calendar/events${id ? `?id=${id}` : ""}`, {
    method, headers: { cookie: cookie(user), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await POST(new Request("http://localhost/api/calendar/events", { method: "POST" }))).status, 401);
  for (const body of [
    { type: "block", title: "Pause", startAt: "2026-10-14T09:00:00Z" },
    { type: "block", title: "Pause", startAt: "2026-10-14T09:00:00Z", endAt: "2026-10-14T08:00:00Z" },
    { type: "followup", title: " ", startAt: "2026-10-14T09:00:00Z" },
    { type: "followup", title: "Kunde", startAt: "invalid" },
  ]) assert.equal((await POST(request("POST", body))).status, 400);
  const response = await POST(request("POST", { type: "followup", title: "Kunde", startAt: "2026-10-14T09:00:00Z", endAt: "2026-10-14T17:00:00Z", note: "Folgetermin" }));
  assert.equal(response.status, 200);
  const { event } = await response.json();
  assert.equal(event.endAt, "2026-10-14T10:30:00.000Z");
  assert.equal((await storage.listCalendarEvents("calendar-a")).length, 1);
  assert.equal((await storage.listCalendarEvents("calendar-b")).length, 0);
  assert.equal((await POST(request("POST", { ...event, title: "Angriff" }, "calendar-b"))).status, 404);
  assert.equal((await DELETE(request("DELETE", undefined, "calendar-b", event.id))).status, 404);
  const update = await POST(request("POST", { ...event, type: "block", title: "Urlaub", endAt: "2026-10-16T10:00:00Z" }));
  assert.equal(update.status, 200);
  const loaded = await (await GET(request("GET"))).json();
  assert.equal(loaded.events[0].endAt, "2026-10-16T10:00:00.000Z");
  assert.equal(loaded.events[0].createdAt, event.createdAt);
  assert.equal((await DELETE(request("DELETE", undefined, "calendar-a", event.id))).status, 200);
  assert.equal((await storage.listCalendarEvents("calendar-a")).length, 0);
});

test("busy endpoint includes active own appointments and user-scoped blocks; ICS preserves colors and end times", async () => {
  await seed([]);
  const now = Date.now();
  const startAt = new Date(now - 45 * 60_000).toISOString();
  const endAt = new Date(now + 45 * 60_000).toISOString();
  const blockEnd = new Date(now + 2 * 86400_000).toISOString();
  const followup = await storage.saveCalendarEvent("availability-user", { type: "followup", title: "Folgetermin", startAt, endAt });
  const block = await storage.saveCalendarEvent("availability-user", { type: "block", title: "Abwesend", startAt: new Date(now + 86400_000).toISOString(), endAt: blockEnd });
  const other = await storage.saveCalendarEvent("different-user", { type: "block", title: "Privat", startAt, endAt: blockEnd });
  const previousToken = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_INTERNAL_TOKEN = "calendar-test-only";
  try {
    const { GET } = await import("../app/api/calendar/busy/route");
    assert.equal((await GET(new Request("http://localhost/api/calendar/busy?userId=availability-user"))).status, 401);
    const response = await GET(new Request("http://localhost/api/calendar/busy?userId=availability-user", { headers: { "x-gloria-internal-token": "calendar-test-only" } }));
    assert.equal(response.status, 200);
    const { slots } = await response.json();
    assert.deepEqual(slots, [{ start: startAt, end: endAt }, { start: block.startAt, end: blockEnd }]);
    const { GET: feed } = await import("../app/api/calendar/feed/[token]/route");
    const { createCalendarFeedToken } = await import("./calendar-feed");
    const token = createCalendarFeedToken("availability-user");
    const ics = await (await feed(new Request("http://localhost"), { params: Promise.resolve({ token }) })).text();
    assert.ok(ics.includes("COLOR:#6B7C32") && ics.includes("COLOR:#C026D3"));
    assert.ok(ics.includes("CATEGORIES:Sperrzeit"));
    assert.ok(!ics.includes("Privat"));
    const blockText = ics.split("BEGIN:VEVENT").find((text) => text.includes(`UID:${block.id}`));
    assert.ok(blockText?.includes(`DTEND:${blockEnd.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`));
  } finally {
    if (previousToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previousToken;
    await storage.deleteCalendarEvent("availability-user", followup.id);
    await storage.deleteCalendarEvent("availability-user", block.id);
    await storage.deleteCalendarEvent("different-user", other.id);
  }
});

test("callback rescheduling and completion persist without changing another user's contact", async () => {
  const lead: Lead = { ...sampleLead, status: "wiedervorlage", nextCallAt: "2026-10-14T10:00:00Z" };
  const other: Lead = { ...lead, id: "other", userId: "other-user" };
  await seed([lead, other]);
  await storage.updateLeadDetails(lead.id, { nextCallAt: "2026-10-16T10:00:00Z" }, "test-user");
  const rescheduled = await storage.getLeadById(lead.id, "test-user");
  assert.equal(rescheduled?.nextCallAt, "2026-10-16T10:00:00Z");
  assert.equal(await storage.updateLeadDetails(other.id, { status: "absage" }, "test-user"), undefined);
  await storage.updateLeadDetails(lead.id, { nextCallAt: "", status: "angerufen" }, "test-user");
  const completed = await storage.getLeadById(lead.id, "test-user");
  assert.ok(completed);
  assert.equal(completed.nextCallAt, undefined);
  assert.equal(buildCrmCalendarEntries([completed], []).length, 0);
  assert.equal((await storage.getLeadById(other.id, "other-user"))?.nextCallAt, other.nextCallAt);
});

test("bulk contact deletion removes only selected user-owned contacts and preserves reports", async () => {
  const { POST } = await import("../app/api/campaigns/lists/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  await seed([
    { ...sampleLead, id: "selected-a" },
    { ...sampleLead, id: "selected-b", lifecycle: "customer" },
    { ...sampleLead, id: "unselected" },
    { ...sampleLead, id: "foreign", userId: "other-user" },
  ]);
  const reportPath = path.join(fixtureDirectory, "data", "report-database.json");
  const reportsBefore = await readFile(reportPath, "utf8");
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({
    id: "test-user", username: "test-user", role: "user", realName: "", companyName: "", gesellschaft: "",
  })}`;
  const response = await POST(new Request("http://localhost/api/campaigns/lists", {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_leads", leadIds: ["selected-a", "selected-b", "selected-a", "foreign"] }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removed, 2);
  assert.equal(await storage.getLeadById("selected-a", "test-user"), undefined);
  assert.equal(await storage.getLeadById("selected-b", "test-user"), undefined);
  assert.ok(await storage.getLeadById("unselected", "test-user"));
  assert.ok(await storage.getLeadById("foreign", "other-user"));
  assert.equal(await readFile(reportPath, "utf8"), reportsBefore);
});

test("deleting a campaign preserves explicit and legacy customers in the customer lifecycle", async () => {
  const customer: Lead = { ...sampleLead, id: "customer", lifecycle: "customer" };
  const legacy: Lead = { ...sampleLead, id: "legacy", lifecycle: undefined, listName: "Manuell hinzugefügt" };
  const otherUsersLead: Lead = { ...sampleLead, id: "other-user-lead", userId: "other-user" };
  await seed([sampleLead, customer, legacy, otherUsersLead]);
  assert.equal((await storage.deleteCampaignList("campaign", "test-user")).removedLeads, 1);
  assert.equal(await storage.getLeadById(sampleLead.id, "test-user"), undefined);
  assert.ok(await storage.getLeadById(otherUsersLead.id, "other-user"));
  for (const id of [customer.id, legacy.id]) {
    const preserved = await storage.getLeadById(id, "test-user");
    assert.ok(preserved);
    assert.equal(isLeadCustomer(preserved), true);
    assert.equal(preserved.listId, undefined);
  }
  assert.equal((await storage.getCampaignListsSummary("test-user")).length, 0);
});

test("deleting a CRM firm list removes its campaign runs while preserving customers and blocking active calls", async () => {
  const sourceListId = "crm-search-delete-test";
  const sourceLead: Lead = {
    ...sampleLead,
    id: "firm-list-prospect",
    callSource: "crm",
    crmCompanyId: 812,
    listId: sourceListId,
    listName: "Firmenliste: Löschtest",
  };
  const campaignLead: Lead = {
    ...sourceLead,
    id: "firm-list-campaign-prospect",
    listId: "crm-run-delete-test",
    listName: "Firmenliste: Löschtest · bKV",
    topic: "bKV",
  };
  const customer: Lead = {
    ...campaignLead,
    id: "firm-list-customer",
    lifecycle: "customer",
  };
  const otherUserLead: Lead = { ...sourceLead, id: "other-user-firm", userId: "other-user" };
  await seed([sourceLead, campaignLead, customer, otherUserLead]);
  const campaignStatePath = path.join(fixtureDirectory, "data", "campaign-state.json");
  await writeFile(campaignStatePath, JSON.stringify({
    lists: [{
      listId: campaignLead.listId,
      listName: campaignLead.listName,
      sourceListId,
      campaignTopic: "bKV",
      active: true,
      userId: "test-user",
    }],
  }));
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({
    id: "test-user", username: "test-user", role: "user", realName: "", companyName: "", gesellschaft: "",
  })}`;
  const { POST } = await import("../app/api/campaigns/lists/route");
  const request = () => POST(new Request("http://localhost/api/campaigns/lists", {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "delete_firm_list", listId: sourceListId }),
  }));
  const blocked = await request();
  assert.equal(blocked.status, 409);
  assert.ok(await storage.getLeadById(sourceLead.id, "test-user"));

  await writeFile(campaignStatePath, JSON.stringify({
    lists: [{
      listId: campaignLead.listId,
      listName: campaignLead.listName,
      sourceListId,
      campaignTopic: "bKV",
      active: false,
      userId: "test-user",
    }],
  }));
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).removedLeads, 2);
  assert.equal(await storage.getLeadById(sourceLead.id, "test-user"), undefined);
  assert.equal(await storage.getLeadById(campaignLead.id, "test-user"), undefined);
  const preservedCustomer = await storage.getLeadById(customer.id, "test-user");
  assert.ok(preservedCustomer);
  assert.equal(preservedCustomer.listId, undefined);
  assert.ok(await storage.getLeadById(otherUserLead.id, "other-user"));
  assert.deepEqual((await storage.getCampaignListsSummary("test-user")), []);
});

test("manual customers have no campaign while normal imports remain callable prospects", async () => {
  await seed([]);
  const csv = "company,contactName,phone,topic,customerKind\nFixture GmbH,Alex Beispiel,+492339555100,bKV,firma";
  await storage.importLeadsFromCsv(csv, { userId: "test-user", lifecycle: "customer", listName: "Manuell hinzugefügt" });
  assert.equal((await storage.getCampaignListsSummary("test-user")).length, 0);
  const manualCustomer = (await storage.getDashboardData({ userId: "test-user", role: "user" })).leads[0];
  assert.equal(manualCustomer.customerKind, "firma");
  assert.equal(manualCustomer.topic, "");
  const state = JSON.parse(await readFile(path.join(fixtureDirectory, "data", "campaign-state.json"), "utf8"));
  assert.equal(state.lists.length, 1);
  await storage.importLeadsFromCsv(csv, { userId: "test-user", listId: "import", listName: "Anrufliste" });
  const next = await storage.pullNextLeadForCampaignList("import", "test-user");
  assert.ok(next);
  assert.equal(next.lifecycle, "prospect");
  assert.equal(next.status, "angerufen");
  assert.equal(await storage.pullNextLeadForCampaignList("import", "test-user"), undefined);
  const converted = await storage.updateLeadDetails(next.id, { lifecycle: "customer", customerKind: "firma" }, "test-user");
  assert.equal(converted?.topic, "");
});

test("fresh campaign calls skip confirmed customers even when their call status is new", async () => {
  await seed([{ ...sampleLead, id: "customer", lifecycle: "customer" }, sampleLead]);
  const next = await storage.pullNextLeadForCampaignList("campaign", "test-user");
  assert.equal(next?.id, sampleLead.id);
  assert.equal((await storage.getLeadById("customer", "test-user"))?.attempts, 0);
  assert.equal(await storage.pullNextLeadForCampaignList("campaign", "test-user"), undefined);
});

test("manual calls cannot change a CRM contact with the same company or supplied lead ID", async () => {
  await seed([sampleLead]);
  const report = await storage.storeCallReport({
    callSource: "manual", callSid: "manual-call", leadId: sampleLead.id,
    userId: sampleLead.userId, company: sampleLead.company, topic: sampleLead.topic,
    outcome: "Termin", appointmentAt: "2026-10-15T10:00:00Z",
  });
  assert.equal(report.callSource, "manual");
  assert.equal(report.leadId, undefined);
  const unchanged = await storage.getLeadById(sampleLead.id, sampleLead.userId);
  assert.equal(unchanged?.status, "neu");
  assert.equal(unchanged?.attempts, 0);
});

test("manual callbacks retain their origin and are scheduled independently of CRM campaigns", async () => {
  await seed([sampleLead]);
  await storage.storeCallReport({
    callSource: "manual", callSid: "manual-initial", userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic, calledPhone: sampleLead.phone,
  });
  const report = await storage.storeCallReport({
    callSid: "manual-initial", userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic,
    outcome: "Wiedervorlage", nextCallAt: "2000-01-01T10:00:00Z",
  });
  assert.equal(report.callSource, "manual");
  assert.ok(report.leadId);
  const callback = await storage.getLeadById(report.leadId, sampleLead.userId);
  assert.equal(callback?.callSource, "manual");
  assert.equal(callback?.phone, sampleLead.phone);
  await storage.storeCallReport({
    callSid: report.callSid, userId: sampleLead.userId, company: sampleLead.company,
    topic: sampleLead.topic, recordingUrl: "https://example.invalid/recording.mp3",
  });
  assert.equal((await storage.getLeadById(report.leadId, sampleLead.userId))?.status, "wiedervorlage");
  assert.equal((await storage.getLeadById(report.leadId, sampleLead.userId))?.nextCallAt, "2000-01-01T10:00:00Z");
  assert.deepEqual((await storage.listDueCallbackLeads()).map((lead) => lead.id), [report.leadId]);
  assert.equal((await storage.getCampaignListsSummary(sampleLead.userId)).length, 1);
  await storage.markLeadCallbackScheduled(report.leadId);
  const followup = await storage.storeCallReport({
    callSid: "manual-followup", leadId: report.leadId, userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic, outcome: "Termin",
    appointmentAt: "2026-10-15T10:00:00Z",
  });
  assert.equal(followup.callSource, "manual");
  assert.equal(getCallSource(followup), "manual");
  assert.equal((await storage.getLeadById(sampleLead.id, sampleLead.userId))?.status, "neu");
});

test("manual bulk deletion preserves CRM reports and other users' reports", async () => {
  await seed([sampleLead]);
  const crm = await storage.storeCallReport({
    callSid: "crm", leadId: sampleLead.id, userId: sampleLead.userId,
    company: sampleLead.company, topic: sampleLead.topic,
  });
  await storage.storeCallReport({
    callSource: "manual", callSid: "manual", userId: sampleLead.userId,
    company: "Manual", topic: sampleLead.topic,
  });
  await storage.storeCallReport({
    callSource: "manual", callSid: "other-manual", userId: "other-user",
    company: "Other", topic: sampleLead.topic,
  });
  const result = await storage.deleteAllReports({ userId: sampleLead.userId, callSource: "manual" });
  assert.equal(result.deletedReports, 1);
  const saved = JSON.parse(await readFile(path.join(fixtureDirectory, "data", "report-database.json"), "utf8"));
  assert.deepEqual(saved.reports.map((report: { callSid: string }) => report.callSid).sort(), [crm.callSid, "other-manual"]);
});

test("deleting the legacy CRM list cannot delete manual callbacks", async () => {
  const manual: Lead = { ...sampleLead, id: "manual-callback", callSource: "manual", listId: undefined, status: "wiedervorlage" };
  const crm: Lead = { ...sampleLead, listId: undefined };
  await seed([manual, crm]);
  assert.equal((await storage.deleteCampaignList("legacy", sampleLead.userId)).removedLeads, 1);
  assert.equal((await storage.getLeadById(manual.id, sampleLead.userId))?.callSource, "manual");
});

test("retries with the same note ID do not create duplicate Gloria notes", async () => {
  await seed([sampleLead]);
  const first = await storage.addLeadNote(sampleLead.id, "Gespräch vereinbart", sampleLead.userId, "gloria-note-retry");
  const retry = await storage.addLeadNote(sampleLead.id, "Gespräch vereinbart", sampleLead.userId, "gloria-note-retry");
  assert.equal(first?.notes?.length, 1);
  assert.equal(retry?.notes?.length, 1);
  assert.equal(retry?.notes?.[0].id, "gloria-note-retry");
  await assert.rejects(
    storage.addLeadNote(sampleLead.id, "Anderer Text", sampleLead.userId, "gloria-note-retry"),
    /Notizkennung wurde bereits/,
  );
});

test("imports full CRM snapshots into an inactive campaign and safely refreshes existing leads", async () => {
  await seed([]);
  const company = {
    crmCompanyId: 812,
    company: "Beispiel GmbH",
    phone: "+49233112345",
    email: "info@example.invalid",
    contactName: "Max Beispiel",
    topic: "Energie",
    crmCompanyData: {
      email: "info@example.invalid",
      industry: "Maschinenbau",
      street: "Hauptstraße 1",
      city: "Sprockhövel",
      contactPersons: [{ name: "Max Beispiel", title: "Geschäftsführer" }],
      notes: [{ text: "Rückruf am Vormittag bevorzugt." }],
      documents: [{ filename: "firmenprofil.pdf", content: "base64-pdf-data" }],
    },
  };
  const options = { listId: "crm-search-7", listName: "CRM: Maschinenbau", userId: "crm-user" };

  const firstImport = await storage.importLeadsFromCrm([company], options);
  assert.equal(firstImport.imported, 1);
  let dashboard = await storage.getDashboardData({ userId: "crm-user", role: "user" });
  assert.equal(dashboard.leads.length, 1);
  assert.equal(dashboard.leads[0].crmCompanyId, 812);
  assert.equal(dashboard.leads[0].email, "info@example.invalid");
  assert.deepEqual(dashboard.leads[0].crmCompanyData, company.crmCompanyData);
  assert.match(dashboard.leads[0].note || "", /Maschinenbau/);

  const leadId = dashboard.leads[0].id;
  await storage.updateLeadDetails(leadId, { status: "angerufen" }, "crm-user");
  const savedLeadsPath = path.join(fixtureDirectory, "data", "leads.json");
  const savedLeads = JSON.parse(await readFile(savedLeadsPath, "utf8"));
  savedLeads[0].attempts = 2;
  await writeFile(savedLeadsPath, JSON.stringify(savedLeads));
  const secondImport = await storage.importLeadsFromCrm([company], options);
  assert.equal(secondImport.imported, 1);
  dashboard = await storage.getDashboardData({ userId: "crm-user", role: "user" });
  assert.equal(dashboard.leads.length, 1);
  assert.equal(dashboard.leads[0].id, leadId);
  assert.equal(dashboard.leads[0].status, "angerufen");
  assert.equal(dashboard.leads[0].attempts, 2);

  const campaignState = JSON.parse(await readFile(path.join(fixtureDirectory, "data", "campaign-state.json"), "utf8"));
  assert.equal(campaignState.lists.find((list: { listId: string }) => list.listId === options.listId)?.active, false);
});

test("CRM firm lists stay topic-free and create isolated runs for selected campaigns", async () => {
  await seed([]);
  const options = { listId: "crm-search-19-user-crm-user", listName: "CRM: Testfirma", userId: "crm-user" };
  await storage.importLeadsFromCrm([{
    crmCompanyId: 911,
    company: "Testfirma GmbH",
    phone: "+49233112345",
    contactName: "Max Beispiel / Erika Muster",
    contactNames: ["Max Beispiel", "Erika Muster"],
    topic: "Energie",
    crmCompanyData: {
      website: "https://testfirma.example",
      street: "Hauptstraße 1",
      postal_code: "45549",
      city: "Sprockhövel",
      country: "Deutschland",
      industry: "Maschinenbau",
      employee_count: 42,
      founded_year: 1998,
      registry_number: "HRB 12345",
      registry_court: "Amtsgericht Essen",
      vat_id: "DE123456789",
    },
  }], options);

  const importedLead = (await storage.getDashboardData({ userId: options.userId, role: "user" })).leads[0];
  assert.equal(importedLead.topic, "");
  assert.deepEqual(importedLead.contactNames, ["Max Beispiel", "Erika Muster"]);
  assert.equal(importedLead.contactGroupNames, "Max Beispiel / Erika Muster");
  assert.equal(importedLead.website, "https://testfirma.example");
  assert.equal(importedLead.foundedYear, 1998);
  assert.equal(importedLead.employeeCount, 42);
  assert.equal(importedLead.registryNumber, "HRB 12345");
  assert.equal(importedLead.registryCourt, "Amtsgericht Essen");
  assert.equal(importedLead.vatId, "DE123456789");
  assert.equal(importedLead.listName, "Firmenliste: Testfirma");
  assert.equal(importedLead.addressStreet, "Hauptstraße 1");
  assert.equal(importedLead.addressPostalCode, "45549");
  assert.equal(importedLead.addressCity, "Sprockhövel");
  assert.equal(importedLead.addressCountry, "Deutschland");
  assert.equal(importedLead.crmCompanyData?.industry, "Maschinenbau");
  assert.match(importedLead.note || "", /Handelsregisternummer: HRB 12345/);
  assert.match(importedLead.note || "", /CRM-Stammdaten und Aktivitäten \/ vat_id: DE123456789/);
  assert.match(importedLead.note || "", /Website: https:\/\/testfirma\.example/);
  assert.equal((await storage.getCampaignListsSummary(options.userId)).length, 0);
  assert.equal((await storage.getFirmListsSummary(options.userId))[0].total, 1);

  const firstRun = await storage.createCampaignRunFromFirmList(
    options.listId,
    "betriebliche Krankenversicherung",
    options.userId,
    [{ leadId: importedLead.id, contactNames: ["Max Beispiel", "Erika Muster"] }],
  );
  await storage.setCampaignListActive(firstRun.listId, true, options.userId);
  const firstCampaignLead = (await storage.getDashboardData({ userId: options.userId, role: "user" }))
    .leads.find((lead) => lead.listId === firstRun.listId);
  assert.equal(firstCampaignLead?.topic, "betriebliche Krankenversicherung");
  assert.equal(firstCampaignLead?.status, "neu");
  const dialedLead = await storage.pullNextLeadForCampaignList(firstRun.listId, options.userId);
  assert.equal(dialedLead?.topic, "betriebliche Krankenversicherung");
  assert.equal(dialedLead?.status, "angerufen");
  assert.equal(dialedLead?.contactName, "Max Beispiel");
  assert.equal(dialedLead?.contactGroupNames, "Max Beispiel / Erika Muster");
  assert.ok(dialedLead);
  const dialedContext = storage.buildLeadCallContext(dialedLead);
  assert.match(dialedContext, /Ansprechpartner im aktuellen Anruf: Max Beispiel/);
  assert.match(dialedContext, /Weitere Ansprechpartner der Firma \[1\]: Erika Muster/);
  const secondDialedLead = await storage.pullNextLeadForCampaignList(firstRun.listId, options.userId);
  assert.equal(secondDialedLead?.contactName, "Erika Muster");
  assert.equal(secondDialedLead?.contactGroupNames, "Max Beispiel / Erika Muster");

  const secondRun = await storage.createCampaignRunFromFirmList(
    options.listId,
    "private Krankenversicherung",
    options.userId,
    [{ leadId: importedLead.id, contactNames: ["Erika Muster"] }],
  );
  const allLeads = (await storage.getDashboardData({ userId: options.userId, role: "user" })).leads;
  assert.equal(allLeads.find((lead) => lead.listId === options.listId)?.topic, "");
  assert.equal(allLeads.find((lead) => lead.listId === secondRun.listId)?.topic, "private Krankenversicherung");
  assert.equal(allLeads.find((lead) => lead.listId === firstRun.listId)?.status, "angerufen");
  assert.equal((await storage.getCampaignListsSummary(options.userId)).length, 2);
});

test("CRM contact names and complete master data are available in the call context", async () => {
  await seed([]);
  const options = { listId: "crm-search-20-user-crm-user", listName: "CRM: Kontext", userId: "crm-user" };
  await storage.importLeadsFromCrm([{
    crmCompanyId: 912,
    company: "Kontext GmbH",
    phone: "+49233112345",
    crmCompanyData: {
      contactPersons: [{ name: "Alex Beispiel", title: "Geschäftsführer" }],
      customFields: [{ name: "Fuhrpark", value: "12 Fahrzeuge" }],
      notes: [{ text: "Wünscht Rückruf am Nachmittag." }],
      documents: [{ name: "Firmenprofil.pdf", mime_type: "application/pdf", content_base64: "JVBERi0xLjQ=" }],
    },
  }], options);

  const lead = (await storage.getDashboardData({ userId: options.userId, role: "user" })).leads[0];
  const context = storage.buildLeadCallContext(lead);
  assert.deepEqual(lead.contactNames, ["Alex Beispiel"]);
  assert.match(context, /Ansprechpartner im aktuellen Anruf: Alex Beispiel/);
  assert.match(context, /customFields \[1\] \/ name: Fuhrpark/);
  assert.match(context, /customFields \[1\] \/ value: 12 Fahrzeuge/);
  assert.match(context, /Wünscht Rückruf am Nachmittag/);
  assert.match(context, /Firmenprofil\.pdf/);
  assert.doesNotMatch(context, /JVBERi0xLjQ=/);
});

test("firm-list summaries count missing CRM fields and treat receptionist fallbacks as missing", async () => {
  await seed([
    {
      ...sampleLead,
      id: "missing-company-one",
      callSource: "crm",
      crmCompanyId: 920,
      listId: "crm-search-missing",
      contactName: "",
      phone: "",
      crmCompanyData: {},
    },
    {
      ...sampleLead,
      id: "missing-company-two",
      callSource: "crm",
      crmCompanyId: 921,
      listId: "crm-search-missing",
      contactName: "",
      phone: "+49233112345",
      crmCompanyData: { phone: "+49233112345" },
    },
  ]);
  const [list] = await storage.getFirmListsSummary(sampleLead.userId);
  assert.equal(list.total, 2);
  assert.equal(list.missingFields.find((field) => field.key === "phone")?.count, 1);
  assert.equal(list.missingFields.find((field) => field.key === "contact_person")?.count, 2);
  assert.equal(list.missingFields.find((field) => field.key === "website")?.count, 2);
});

test("refreshing a CRM firm list leaves fields absent from the latest transfer empty", async () => {
  await seed([]);
  const options = { listId: "crm-search-refresh", listName: "CRM: Aktualisierung", userId: "crm-user" };
  await storage.importLeadsFromCrm([{
    crmCompanyId: 922,
    company: "Aktualisierung GmbH",
    phone: "+49233112345",
    email: "info@aktualisierung.example",
    crmCompanyData: {
      website: "https://aktualisierung.example",
      industry: "Maschinenbau",
      city: "Sprockhövel",
      employee_count: 21,
    },
  }], options);
  await storage.importLeadsFromCrm([{
    crmCompanyId: 922,
    company: "Aktualisierung GmbH",
    phone: "",
    crmCompanyData: {},
  }], options);
  const [lead] = (await storage.getDashboardData({ userId: options.userId, role: "user" })).leads;
  assert.equal(lead.phone, "");
  assert.equal(lead.email, undefined);
  assert.equal(lead.website, undefined);
  assert.equal(lead.industry, undefined);
  assert.equal(lead.employeeCount, undefined);
  assert.equal(lead.contactName, "");
});

test("researched CRM details are persisted to the Gloria lead model", async () => {
  await seed([{
    ...sampleLead,
    callSource: "crm",
    crmCompanyId: 923,
    crmCompanyData: {},
  }]);
  const updated = await storage.updateLeadDetails(sampleLead.id, {
    phone: "+49233112345",
    directDial: "+49233112345",
    email: "info@beispiel.example",
    website: "https://beispiel.example",
    industry: "Maschinenbau",
    contactName: "Alex Beispiel",
    contactNames: ["Alex Beispiel"],
    addressStreet: "Hauptstraße 1",
    addressPostalCode: "45549",
    addressCity: "Sprockhövel",
    registryNumber: "HRB 12345",
    foundedYear: 1998,
    employeeCount: 42,
    vatId: "DE123456789",
    crmCompanyData: { phone: "+49233112345", website: "https://beispiel.example" },
  }, sampleLead.userId);

  assert.equal(updated?.phone, "+49233112345");
  assert.equal(updated?.directDial, "+49233112345");
  assert.equal(updated?.email, "info@beispiel.example");
  assert.equal(updated?.website, "https://beispiel.example");
  assert.equal(updated?.industry, "Maschinenbau");
  assert.deepEqual(updated?.contactNames, ["Alex Beispiel"]);
  assert.equal(updated?.addressStreet, "Hauptstraße 1");
  assert.equal(updated?.registryNumber, "HRB 12345");
  assert.equal(updated?.foundedYear, 1998);
  assert.equal(updated?.employeeCount, 42);
  assert.equal(updated?.vatId, "DE123456789");
});

test("company research fills only still-empty fields and returns web sources", async () => {
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  await seed([{
    ...sampleLead,
    callSource: "crm",
    crmCompanyId: 924,
    listId: "crm-search-research",
    company: "Recherche GmbH",
    phone: "",
    email: "info@recherche.example",
    crmCompanyData: { email: "info@recherche.example" },
  }]);

  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  const resultData = {
    phone: "+49233112345",
    email: "angereichert@recherche.example",
    website: "https://recherche.example",
    industry: "Maschinenbau",
    contact_person: null,
    address: null,
    street: null,
    postal_code: null,
    city: "Mülheim an der Ruhr",
    country: null,
    registry_number: null,
    registry_court: null,
    founded_year: null,
    employee_count: null,
    vat_id: null,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    output: [
      { type: "web_search_call", action: { type: "search", sources: [{ type: "url", url: "https://recherche.example/impressum" }] } },
      { type: "message", content: [{ type: "output_text", text: JSON.stringify(resultData) }] },
    ],
  }), { status: 200, headers: { "Content-Type": "application/json" } });

  try {
    const { POST } = await import("../app/api/campaigns/research/route");
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({
      id: sampleLead.userId!,
      username: sampleLead.userId!,
      role: "user",
      realName: "",
      companyName: "",
      gesellschaft: "",
    })}`;
    const invalidSelection = await POST(new Request("http://localhost/api/campaigns/research", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: sampleLead.id, fields: ["not-a-company-field"] }),
    }));
    assert.equal(invalidSelection.status, 400);
    const response = await POST(new Request("http://localhost/api/campaigns/research", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: sampleLead.id, fields: ["phone", "website", "industry"] }),
    }));
    const payload = await response.json() as {
      fields: Array<{ key: string; value: string }>;
      sources: Array<{ url: string }>;
      crmSyncError?: string;
    };
    assert.equal(response.status, 200);
    assert.deepEqual(payload.fields.map((field) => field.key).sort(), ["industry", "phone", "website"]);
    assert.deepEqual(payload.sources.map((source) => source.url), ["https://recherche.example/impressum"]);
    assert.match(payload.crmSyncError || "", /kein CRM-Benutzerkonto gekoppelt/);
    const [updatedLead] = (await storage.getDashboardData({ userId: sampleLead.userId, role: "user" })).leads;
    assert.equal(updatedLead.phone, "+49233112345");
    assert.equal(updatedLead.email, "info@recherche.example");
    assert.equal(updatedLead.website, "https://recherche.example");
    assert.equal(updatedLead.industry, "Maschinenbau");
    assert.equal(updatedLead.addressCity, undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("company research reports provider timeouts as a structured JSON error", async () => {
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  await seed([{
    ...sampleLead,
    callSource: "crm",
    crmCompanyId: 925,
    listId: "crm-search-timeout",
    company: "Timeout GmbH",
    phone: "",
    crmCompanyData: {},
  }]);

  const previousApiKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-openai-key";
  globalThis.fetch = async () => {
    throw Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" });
  };
  try {
    const { POST } = await import("../app/api/campaigns/research/route");
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({
      id: sampleLead.userId!,
      username: sampleLead.userId!,
      role: "user",
      realName: "",
      companyName: "",
      gesellschaft: "",
    })}`;
    const response = await POST(new Request("http://localhost/api/campaigns/research", {
      method: "POST",
      headers: { cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: sampleLead.id }),
    }));
    assert.equal(response.status, 504);
    assert.match((await response.json()).error, /zu lange gedauert/);
    const lead = await storage.getLeadById(sampleLead.id, sampleLead.userId);
    assert.equal(lead?.phone, "");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousApiKey;
  }
});

test("firm list reads migrate legacy CRM theme defaults to an empty topic", async () => {
  await seed([{
    ...sampleLead,
    callSource: "crm",
    crmCompanyId: 912,
    listId: "crm-search-legacy-user",
    listName: "CRM: Alte Suche",
    topic: "Energie",
  }]);

  const lists = await storage.getFirmListsSummary(sampleLead.userId);
  assert.equal(lists[0].listName, "Firmenliste: Alte Suche");
  const storedLeads = JSON.parse(await readFile(path.join(fixtureDirectory, "data", "leads.json"), "utf8"));
  assert.equal(storedLeads[0].topic, "");
  assert.equal(storedLeads[0].listName, "Firmenliste: Alte Suche");
});

test("stable saved-search imports absorb partial legacy transfers without duplicate leads", async () => {
  await seed([
    {
      ...sampleLead,
      id: "partial-import-1",
      userId: "crm-user",
      callSource: "crm",
      crmCompanyId: 812,
      listId: "crm-search-7-20261102130937655876",
      status: "angerufen",
      attempts: 2,
    },
    {
      ...sampleLead,
      id: "partial-import-2",
      userId: "crm-user",
      callSource: "crm",
      crmCompanyId: 812,
      listId: "crm-search-7-20261102130234136165",
      status: "neu",
      attempts: 0,
    },
  ]);
  const campaignStatePath = path.join(fixtureDirectory, "data", "campaign-state.json");
  const campaignState = JSON.parse(await readFile(campaignStatePath, "utf8"));
  campaignState.lists.push(
    { listId: "crm-search-7-20261102130937655876", listName: "Old transfer 1", userId: "crm-user" },
    { listId: "crm-search-7-20261102130234136165", listName: "Old transfer 2", userId: "crm-user" },
  );
  await writeFile(campaignStatePath, JSON.stringify(campaignState));

  const result = await storage.importLeadsFromCrm([{
    crmCompanyId: 812,
    company: "Maschinenbau GmbH",
    phone: "+49233112345",
    crmCompanyData: { industry: "Maschinenbau" },
  }], {
    listId: "crm-search-7-user-15",
    listName: "CRM: Maschinenbau",
    userId: "crm-user",
  });

  const dashboard = await storage.getDashboardData({ userId: "crm-user", role: "user" });
  const importedLeads = dashboard.leads.filter((lead) => lead.crmCompanyId === 812);
  assert.equal(result.imported, 1);
  assert.equal(importedLeads.length, 1);
  assert.equal(importedLeads[0].id, "partial-import-1");
  assert.equal(importedLeads[0].listId, "crm-search-7-user-15");
  assert.equal(importedLeads[0].status, "angerufen");
  assert.equal(importedLeads[0].attempts, 2);
  const refreshedCampaignState = JSON.parse(await readFile(campaignStatePath, "utf8"));
  assert.equal(refreshedCampaignState.lists.some((list: { listId: string }) =>
    list.listId === "crm-search-7-20261102130937655876" ||
    list.listId === "crm-search-7-20261102130234136165"
  ), false);
});

test("campaign contact selections are mandatory, user-scoped and restrict the actual dial queue", async () => {
  const listId = "crm-search-contact-selection";
  const multi: Lead = {
    ...sampleLead, id: "multi", listId, callSource: "crm",
    contactName: "Max / Erika",
    birthDate: "1980-01-02",
    crmCompanyData: {
      contact_person: "Max", contact_birthdate: "1980-01-02",
      contactPersons: [
        { name: "Max", birthdate: "1980-01-02" },
        { name: "Erika", birthdate: "1986-03-04" },
      ],
    },
  };
  const single: Lead = { ...multi, id: "single", contactName: "Solo", crmCompanyData: undefined, birthDate: "1970-05-06" };
  const unnamed: Lead = { ...single, id: "unnamed", contactName: "", birthDate: undefined };
  await seed([multi, single, unnamed, { ...multi, id: "foreign", userId: "other-user" }]);
  const before = await readFile(path.join(fixtureDirectory, "data", "leads.json"), "utf8");
  for (const selection of [
    [],
    [{ leadId: "multi", contactNames: [] }],
    [{ leadId: "multi", contactNames: ["Unknown"] }],
    [{ leadId: "multi", contactNames: ["Erika", "Erika"] }],
    [{ leadId: "foreign", contactNames: ["Erika"] }],
    [{ leadId: "multi", contactNames: ["Erika"] }, { leadId: "multi", contactNames: ["Max"] }],
  ]) {
    await assert.rejects(storage.createCampaignRunFromFirmList(listId, "bKV", "test-user", selection));
    assert.equal(await readFile(path.join(fixtureDirectory, "data", "leads.json"), "utf8"), before);
  }
  const run = await storage.createCampaignRunFromFirmList(listId, "bKV", "test-user", [
    { leadId: "multi", contactNames: ["Erika"] },
  ]);
  const leads = (await storage.getDashboardData({ userId: "test-user", role: "user" })).leads.filter((lead) => lead.listId === run.listId);
  assert.deepEqual(leads.map((lead) => lead.contactName), ["Erika", "Solo", ""]);
  assert.deepEqual(leads.map((lead) => lead.birthDate), ["1986-03-04", "1970-05-06", undefined]);
  assert.deepEqual(leads[0].contactNames, ["Erika"]);
  assert.deepEqual(leads[0].crmCompanyData, multi.crmCompanyData);
  assert.match(storage.buildLeadCallContext(leads[0]), /ausschließlich die oben genannte Zielperson/);
  await storage.setCampaignListActive(run.listId, true, "test-user");
  assert.equal((await storage.pullNextLeadForCampaignList(run.listId, "test-user"))?.contactName, "Erika");
  assert.equal((await storage.pullNextLeadForCampaignList(run.listId, "test-user"))?.contactName, "Solo");
  assert.equal((await storage.pullNextLeadForCampaignList(run.listId, "test-user"))?.contactName, "");
  assert.equal(await storage.pullNextLeadForCampaignList(run.listId, "test-user"), undefined);
  const original = await storage.getLeadById("multi", "test-user");
  assert.deepEqual(original?.crmCompanyData, multi.crmCompanyData);
});

test("campaign start API rejects invalid or omitted multi-contact selections before starting a run", async () => {
  const { POST } = await import("../app/api/campaigns/lists/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  const listId = "crm-search-api-selection";
  await seed([{
    ...sampleLead, id: "api-multi", listId, callSource: "crm", contactName: "A / B",
  }]);
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({
    id: "test-user", username: "test-user", role: "user", realName: "", companyName: "", gesellschaft: "",
  })}`;
  const start = (selection?: unknown) => POST(new Request("http://localhost/api/campaigns/lists", {
    method: "POST", headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", listId, topic: "betriebliche Krankenversicherung", contactSelections: selection }),
  }));
  for (const selection of [undefined, {}, [null], [{ leadId: "api-multi", contactNames: [7] }], [{ leadId: "api-multi", contactNames: ["C"] }]]) {
    const response = await start(selection);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error);
    assert.equal((await storage.getCampaignListsSummary("test-user")).length, 0);
  }
  const response = await start([{ leadId: "api-multi", contactNames: ["B"] }]);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const run = (await storage.getDashboardData({ userId: "test-user", role: "user" })).leads.filter((lead) => lead.listId === payload.listId);
  assert.deepEqual(run.map((lead) => lead.contactName), ["B"]);
  assert.equal(await storage.isCampaignListActive(payload.listId, "test-user"), true);
});

test("a seven-section CRM transfer can retry its third section without duplicating companies", async () => {
  const otherLead: Lead = { ...sampleLead, id: "untouched", userId: "other-user" };
  await seed([otherLead]);
  const companies = Array.from({ length: 650 }, (_, index) => ({
    crmCompanyId: index + 1000,
    company: `Transferfirma ${index}`,
    phone: "",
    crmCompanyData: {
      industry: "Maschinenbau",
      documents: [{ filename: "firmenprofil.pdf", content: "document-content" }],
    },
  }));
  const options = { listId: "crm-search-209-user-1", listName: "Große Suche", userId: "test-user" };
  for (const offset of [0, 100, 200, 200, 300, 400, 500, 600]) {
    const section = companies.slice(offset, offset + 100);
    const result = await storage.importLeadsFromCrm(section, options);
    assert.equal(result.imported, section.length);
  }
  const { leads } = await storage.getDashboardData({ userId: options.userId, role: "user" });
  assert.equal(leads.length, 650);
  assert.equal(new Set(leads.map((lead) => lead.crmCompanyId)).size, 650);
  assert.equal(new Set(leads.map((lead) => lead.id)).size, 650);
  assert.ok(leads.every((lead) => lead.listId === options.listId && lead.industry === "Maschinenbau"));
  assert.ok(leads.every((lead) => lead.crmCompanyData?.documents));
  assert.ok(await storage.getLeadById(otherLead.id, "other-user"));
});

test("CRM import API requires its shared token and rejects an unpaired CRM user", async () => {
  await seed([]);
  const previousToken = process.env.GLORIA_CRM_INTEGRATION_TOKEN;
  process.env.GLORIA_CRM_INTEGRATION_TOKEN = "test-crm-shared-token";

  try {
    const { POST } = await import("../app/api/integrations/crm/campaigns/route");
    const payload = {
      crmUserId: "crm-user",
      listId: "crm-api-list",
      listName: "CRM API Test",
      companies: [{
        crmCompanyId: 95,
        company: "API GmbH",
        phone: "+49233112345",
        crmCompanyData: {
          vat_id: "DE123456789",
          documents: [{ filename: "profile.pdf", content: "base64-pdf-data" }],
        },
      }],
    };
    const request = (token?: string) => new Request("http://localhost/api/integrations/crm/campaigns", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "x-gloria-integration-token": token } : {}),
      },
      body: JSON.stringify(payload),
    });

    assert.equal((await POST(request())).status, 401);
    const response = await POST(request("test-crm-shared-token"));
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /gepaartes Gloria-Konto/i);
  } finally {
    if (previousToken === undefined) delete process.env.GLORIA_CRM_INTEGRATION_TOKEN;
    else process.env.GLORIA_CRM_INTEGRATION_TOKEN = previousToken;
  }
});
