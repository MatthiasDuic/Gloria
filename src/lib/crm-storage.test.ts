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
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
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

test("deleting a campaign preserves explicit and legacy customers in the customer lifecycle", async () => {
  const customer: Lead = { ...sampleLead, id: "customer", lifecycle: "customer" };
  const legacy: Lead = { ...sampleLead, id: "legacy", lifecycle: undefined, listName: "Manuell hinzugefügt" };
  await seed([sampleLead, customer, legacy]);
  assert.equal((await storage.deleteCampaignList("campaign", "test-user")).removedLeads, 1);
  assert.equal(await storage.getLeadById(sampleLead.id, "test-user"), undefined);
  for (const id of [customer.id, legacy.id]) {
    const preserved = await storage.getLeadById(id, "test-user");
    assert.ok(preserved);
    assert.equal(isLeadCustomer(preserved), true);
    assert.equal(preserved.listId, undefined);
  }
  assert.equal((await storage.getCampaignListsSummary("test-user")).length, 0);
});

test("manual customers have no campaign while normal imports remain callable prospects", async () => {
  await seed([]);
  const csv = "company,contactName,phone,topic,customerKind\nFixture GmbH,Alex Beispiel,+492339555100,bKV,firma";
  await storage.importLeadsFromCsv(csv, { userId: "test-user", lifecycle: "customer", listName: "Manuell hinzugefügt" });
  assert.equal((await storage.getCampaignListsSummary("test-user")).length, 0);
  const state = JSON.parse(await readFile(path.join(fixtureDirectory, "data", "campaign-state.json"), "utf8"));
  assert.equal(state.lists.length, 1);
  await storage.importLeadsFromCsv(csv, { userId: "test-user", listId: "import", listName: "Anrufliste" });
  const next = await storage.pullNextLeadForCampaignList("import", "test-user");
  assert.ok(next);
  assert.equal(next.lifecycle, "prospect");
  assert.equal(next.status, "angerufen");
  assert.equal(await storage.pullNextLeadForCampaignList("import", "test-user"), undefined);
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
