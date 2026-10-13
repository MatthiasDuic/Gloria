import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveLeadCompanyName,
  buildCrmCalendarEntries,
  buildUnifiedCalendarEntries,
  buildLeadProductRecord,
  getLeadCustomerKindFormConfig,
  getCrmWorkspaceLeads,
  getCallSource,
  getCallWorkspaceData,
  isDueGloriaTask,
  isLeadCustomer,
  normalizeLeadAffiliationRole,
  normalizeLeadBirthDate,
  normalizeLeadProductDetails,
  resolveExclusiveDetailModal,
  resolveLeadCompanyValue,
} from "./crm-helpers.ts";
import type { CallReport, DashboardData, Lead } from "./types";
import { CALENDAR_VIEWS, formatCalendarPeriod, getCalendarDays, getCalendarEntryColor, moveCalendarDate, saveCalendarCallback } from "./calendar-view";

test("calendar views show one day, Monday-based weeks, weekdays, month grid and monthly agenda", () => {
  const sunday = new Date(2026, 9, 18, 16);
  assert.equal(CALENDAR_VIEWS.length, 5);
  assert.equal(getCalendarDays(sunday, "day").length, 1);
  const week = getCalendarDays(sunday, "week");
  assert.equal(week.length, 7);
  assert.equal(week[0].getDate(), 12);
  assert.equal(week[0].getDay(), 1);
  assert.equal(week[6].getDay(), 0);
  const workweek = getCalendarDays(sunday, "workweek");
  assert.equal(workweek.length, 5);
  assert.equal(workweek[4].getDay(), 5);
  const month = getCalendarDays(sunday, "month");
  assert.equal(month.length, 42);
  assert.equal(month[0].getDay(), 1);
  const agenda = getCalendarDays(new Date(2028, 1, 15), "agenda");
  assert.equal(agenda.length, 29);
  assert.equal(agenda[0].getDate(), 1);
  assert.equal(agenda[28].getDate(), 29);
});

test("calendar navigation preserves local dates across month, year and daylight-saving boundaries", () => {
  const january = new Date(2026, 0, 31);
  const february = moveCalendarDate(january, "month", 1);
  assert.equal(february.getMonth(), 1);
  assert.equal(february.getDate(), 28);
  const year = moveCalendarDate(new Date(2026, 11, 15), "agenda", 1);
  assert.equal(year.getFullYear(), 2027);
  assert.equal(year.getMonth(), 0);
  assert.equal(moveCalendarDate(new Date(2026, 9, 24), "day", 1).getDate(), 25);
  const nextWeek = moveCalendarDate(new Date(2026, 9, 23), "workweek", 1);
  assert.equal(nextWeek.getDate(), 30);
  const week = getCalendarDays(new Date(2026, 9, 25), "week");
  assert.deepEqual(week.map((date) => date.getDate()), [19, 20, 21, 22, 23, 24, 25]);
  assert.match(formatCalendarPeriod(new Date(2026, 9, 13), "week"), /12\.10\.2026.*18\.10\.2026/);
  assert.match(formatCalendarPeriod(new Date(2026, 9, 13), "workweek"), /12\.10\.2026.*16\.10\.2026/);
});

const sampleLead: Lead = {
  id: "prospect-1", company: "Beispiel GmbH", contactName: "Alex Beispiel",
  phone: "+492339555100", topic: "bKV", status: "neu", attempts: 0,
  lifecycle: "prospect", customerKind: "firma", listId: "campaign-1",
};
const sampleReport: CallReport = {
  id: "report-1", leadId: sampleLead.id, company: sampleLead.company, topic: sampleLead.topic,
  summary: "Termin vereinbart", outcome: "Termin", conversationDate: "2026-10-13T10:00:00.000Z",
  appointmentAt: "2026-10-15T10:00:00.000Z", attempts: 1, recordingConsent: false, emailedTo: "",
};

test("shared calendar combines sources without merging matching contacts and keeps tenant scope", () => {
  const crmLead = { ...sampleLead, userId: "owner", status: "wiedervorlage" as const, nextCallAt: "2026-10-16T10:00:00Z" };
  const manualLead = { ...crmLead, id: "manual-lead", callSource: "manual" as const };
  const dashboard = {
    leads: [crmLead, manualLead, { ...crmLead, id: "foreign", userId: "other" }],
    reports: [
      { ...sampleReport, userId: "owner", callSource: "crm" as const },
      { ...sampleReport, id: "manual-report", userId: "owner", leadId: manualLead.id, callSource: "manual" as const },
      { ...sampleReport, id: "foreign-report", userId: "other", leadId: "foreign" },
    ],
  } as DashboardData;
  const entries = buildUnifiedCalendarEntries(dashboard, "owner");
  assert.equal(entries.length, 4);
  assert.equal(entries.filter((entry) => entry.kind === "appointment").length, 2);
  assert.deepEqual(new Set(entries.map((entry) => entry.callSource)), new Set(["crm", "manual"]));
  assert.ok(entries.every((entry) => entry.leadId !== "foreign" && entry.reportId !== "foreign-report"));
  assert.equal(getCallWorkspaceData(dashboard, "crm").reports.some((report) => report.id === "manual-report"), false);
});

test("shared calendar keeps rescheduled and completed callbacks authoritative for both sources", () => {
  const leads: Lead[] = [
    { ...sampleLead, status: "angerufen" },
    { ...sampleLead, id: "manual", callSource: "manual", status: "wiedervorlage", nextCallAt: "2026-10-19T10:00:00Z" },
  ];
  const reports: CallReport[] = [
    { ...sampleReport, outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-15T10:00:00Z", callSource: "crm" },
    { ...sampleReport, id: "manual-report", leadId: "manual", callSource: "manual", outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-15T10:00:00Z" },
  ];
  const entries = buildUnifiedCalendarEntries({ leads, reports } as DashboardData);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].callSource, "manual");
  assert.equal(entries[0].at, leads[1].nextCallAt);
  assert.equal(entries[0].reportId, "manual-report");
});

test("calendar colors distinguish CRM and manual appointments but keep all callbacks orange", () => {
  assert.equal(getCalendarEntryColor({ kind: "appointment", callSource: "crm" }), "#2563EB");
  assert.equal(getCalendarEntryColor({ kind: "appointment", callSource: "manual" }), "#6B7C32");
  assert.equal(getCalendarEntryColor({ kind: "callback", callSource: "crm" }), "#D97706");
  assert.equal(getCalendarEntryColor({ kind: "callback", callSource: "manual" }), "#D97706");
});

test("calendar callback actions use the correct origin endpoint and preserve Gloria task updates", async (t) => {
  const requests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    requests.push({ url: input, method: init.method, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const entry = { id: "callback", leadId: sampleLead.id, company: sampleLead.company, topic: sampleLead.topic, kind: "callback" as const, at: "2026-10-15T10:00:00Z" };
  await saveCalendarCallback({ ...entry, callSource: "manual" }, { ...sampleLead, callSource: "manual" }, "2026-10-16T10:00:00Z");
  assert.equal(requests[0].url, "/api/reports");
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].body.nextCallAt, "2026-10-16T10:00:00Z");
  await saveCalendarCallback(entry, sampleLead);
  assert.equal(requests[1].url, "/api/campaigns/lists");
  assert.deepEqual(requests[1].body.updates, { nextCallAt: "", status: "angerufen" });
  await saveCalendarCallback({ ...entry, taskId: "task" }, sampleLead);
  assert.equal(requests[2].body.action, "complete_lead_task");
  const task = { id: "task", title: "Rückruf", assignee: "gloria" as const, status: "open" as const };
  await saveCalendarCallback({ ...entry, taskId: "task" }, { ...sampleLead, tasks: [task] }, "2026-10-17T10:00:00Z");
  assert.deepEqual(requests[3].body.updates, { tasks: [{ ...task, dueAt: "2026-10-17T10:00:00Z" }] });
});

test("calendar callback actions expose persistence errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Nicht erlaubt." }), { status: 403 }));
  await assert.rejects(saveCalendarCallback({
    id: "callback", company: sampleLead.company, topic: sampleLead.topic, kind: "callback", at: "2026-10-15T10:00:00Z",
  }, sampleLead), /Nicht erlaubt/);
});

test("private customers auto-fill a sensible company label without requiring a firm name", () => {
  assert.equal(buildEffectiveLeadCompanyName({ customerKind: "privat", company: "", contactName: "Max Mustermann" }), "Max Mustermann");
  assert.equal(buildEffectiveLeadCompanyName({ customerKind: "privat", company: "", contactName: "" }), "Privatperson");
  assert.equal(resolveLeadCompanyValue({ customerKind: "privat", company: "", contactName: "Max Mustermann" }), "Max Mustermann");
});

test("affiliation roles fall back to a valid default when empty", () => {
  assert.equal(normalizeLeadAffiliationRole(""), "Mitarbeiter");
  assert.equal(normalizeLeadAffiliationRole("Geschäftsführer"), "Geschäftsführer");
});

test("german birth dates are normalized to ISO strings", () => {
  assert.equal(normalizeLeadBirthDate("25.08.1990"), "1990-08-25");
  assert.equal(normalizeLeadBirthDate("2024-04-03"), "2024-04-03");
});

test("customer kind form config switches the required fields between private persons and companies", () => {
  assert.deepEqual(getLeadCustomerKindFormConfig("privat"), {
    companyLabel: "Privatperson / Firma (optional)",
    companyPlaceholder: "optional – wird aus Name abgeleitet",
    requireCompany: false,
    showBirthDate: true,
  });

  assert.deepEqual(getLeadCustomerKindFormConfig("firma"), {
    companyLabel: "Firma",
    companyPlaceholder: "Musterbau GmbH",
    requireCompany: true,
    showBirthDate: false,
  });
});

test("product details get normalized defaults for insurance and energy products", () => {
  const next = normalizeLeadProductDetails([
    { category: "private Krankenversicherung", insurer: "Allianz", premium: "89,50", paymentMethod: "monatlich" },
    { category: "Strom und Gas", energyType: "Strom" },
  ]);

  assert.equal(next?.length, 2);
  assert.equal(next?.[0].label, "private Krankenversicherung");
  assert.equal(next?.[0].paymentMethod, "monatlich");
  assert.equal(next?.[1].energyType, "Strom");
  assert.ok(next?.[0].id.startsWith("product-"));

  const record = buildLeadProductRecord({ category: "betriebliche Krankenversicherung" });
  assert.equal(record.category, "betriebliche Krankenversicherung");
  assert.equal(record.paymentMethod, "monatlich");
});

test("detail modals stay exclusive so a lead detail cannot overlap a report detail", () => {
  const leadState = resolveExclusiveDetailModal({ lead: { id: "lead-1" } });
  assert.deepEqual(leadState, { lead: { id: "lead-1" }, report: null });

  const reportState = resolveExclusiveDetailModal({ report: { id: "report-1" } });
  assert.deepEqual(reportState, { lead: null, report: { id: "report-1" } });
});

test("campaign imports remain prospects while explicit and legacy manual entries are customers", () => {
  assert.equal(isLeadCustomer({ lifecycle: "prospect", listName: "Manuell hinzugefügt" }), false);
  assert.equal(isLeadCustomer({ lifecycle: "customer", listName: "Kampagne" }), true);
  assert.equal(isLeadCustomer({ lifecycle: undefined, listName: "Agentur-Duic | Manuell hinzugefügt" }), true);
  assert.equal(isLeadCustomer({ lifecycle: undefined, listName: "Kampagnenimport" }), false);
});

test("automatic Gloria calls require an open, due, unscheduled Gloria task", () => {
  const now = Date.parse("2026-11-18T10:00:00.000Z");
  const task = { assignee: "gloria" as const, status: "open" as const, dueAt: "2026-11-18T09:59:00.000Z" };
  assert.equal(isDueGloriaTask(task, now), true);
  assert.equal(isDueGloriaTask({ ...task, dueAt: "2026-11-18T10:01:00.000Z" }, now), false);
  assert.equal(isDueGloriaTask({ ...task, scheduledAt: "2026-11-18T09:59:30.000Z" }, now), false);
  assert.equal(isDueGloriaTask({ ...task, status: "done" }, now), false);
  assert.equal(isDueGloriaTask({ ...task, assignee: "user" }, now), false);
});

test("product normalization preserves application, unit forecast and commission fields", () => {
  const product = buildLeadProductRecord({
    category: "bKV",
    label: "Gruppenvertrag",
    applicationStatus: "application_submitted",
    expectedUnits: 12,
    expectedCommissionEUR: 345.67,
  });

  const normalized = normalizeLeadProductDetails([product])?.[0];
  assert.equal(normalized?.applicationStatus, "application_submitted");
  assert.equal(normalized?.expectedUnits, 12);
  assert.equal(normalized?.expectedCommissionEUR, 345.67);
});

test("company and private workspaces contain only confirmed customers of that kind", () => {
    const leads: Lead[] = [
      sampleLead,
      { ...sampleLead, id: "company-1", lifecycle: "customer" },
      { ...sampleLead, id: "private-1", lifecycle: "customer", customerKind: "privat" },
    ];
    assert.deepEqual(getCrmWorkspaceLeads(leads, "campaigns").map((lead) => lead.id), ["prospect-1"]);
    assert.deepEqual(getCrmWorkspaceLeads(leads, "companies").map((lead) => lead.id), ["company-1"]);
    assert.deepEqual(getCrmWorkspaceLeads(leads, "private").map((lead) => lead.id), ["private-1"]);
    assert.equal(getCrmWorkspaceLeads(leads, "dashboard").length, 3);
  });

test("legacy callbacks follow matched lead state and legacy appointments deduplicate with identified reports", () => {
  const legacy: CallReport = { ...sampleReport, id: "legacy", leadId: undefined, calledPhone: sampleLead.phone };
  const callback: CallReport = { ...legacy, outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-14T10:00:00Z" };
  const lead: Lead = { ...sampleLead, status: "wiedervorlage", nextCallAt: "2026-10-16T10:00:00Z" };
  assert.deepEqual(buildCrmCalendarEntries([lead], [callback]).map((entry) => entry.at), [lead.nextCallAt]);
  assert.equal(buildCrmCalendarEntries([{ ...lead, status: "angerufen", nextCallAt: undefined }], [callback]).length, 0);
  assert.equal(buildCrmCalendarEntries([lead], [legacy, sampleReport]).filter((entry) => entry.kind === "appointment").length, 1);
});

test("a newer appointment suppresses an older report-only callback without losing the appointment", () => {
  const callback: CallReport = { ...sampleReport, leadId: undefined, outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-14T10:00:00Z" };
  const appointment: CallReport = { ...sampleReport, leadId: undefined, id: "new", conversationDate: "2026-10-13T11:00:00Z" };
  const entries = buildCrmCalendarEntries([], [callback, appointment]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "appointment");
});

test("ambiguous legacy contacts are not assigned to the wrong lead", () => {
  const callback: CallReport = { ...sampleReport, leadId: undefined, contactName: sampleLead.contactName, outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-14T10:00:00Z" };
  const entries = buildCrmCalendarEntries([sampleLead, { ...sampleLead, id: "duplicate" }], [callback]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].leadId, undefined);
});

test("private customer calendar entries display the person's name instead of the original company", () => {
  const lead: Lead = { ...sampleLead, lifecycle: "customer", customerKind: "privat", status: "wiedervorlage", nextCallAt: sampleReport.appointmentAt };
  const entries = buildCrmCalendarEntries([lead], [sampleReport]);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.company === lead.contactName));
});

test("call origins prefer explicit metadata and retain legacy CRM and manual markers", () => {
  assert.equal(getCallSource(sampleReport), "crm");
  assert.equal(getCallSource({ ...sampleReport, callSource: "manual" }), "manual");
  assert.equal(getCallSource({ ...sampleReport, leadId: undefined, summary: "Kampagnenanruf gestartet" }), "crm");
  assert.equal(getCallSource({ ...sampleReport, summary: "Testanruf ohne CRM-Zuordnung" }), "manual");
  assert.equal(getCallSource({ ...sampleReport, leadId: undefined }), "manual");
  assert.equal(getCallSource(sampleReport, [{ ...sampleLead, callSource: "manual" }]), "manual");
});

test("CRM and manual reports, appointments and callbacks never cross workspaces even for the same company", () => {
  const manualLead: Lead = { ...sampleLead, id: "manual", callSource: "manual", status: "wiedervorlage", nextCallAt: "2026-10-16T10:00:00Z" };
  const crmLead: Lead = { ...sampleLead, status: "wiedervorlage", nextCallAt: "2026-10-17T10:00:00Z" };
  const manualReport: CallReport = { ...sampleReport, id: "manual-report", leadId: manualLead.id, callSource: "manual" };
  const data: DashboardData = {
    leads: [crmLead, manualLead], reports: [sampleReport, manualReport], topicPolicies: [],
    metrics: { dialAttempts: 0, conversations: 0, appointments: 0, rejections: 0, callbacksOpen: 0, gatekeeperLoops: 0, transferSuccessRate: 0 },
  };
  const crm = getCallWorkspaceData(data, "crm");
  const manual = getCallWorkspaceData(data, "manual");
  assert.deepEqual(crm.reports.map((report) => report.id), [sampleReport.id]);
  assert.deepEqual(manual.reports.map((report) => report.id), [manualReport.id]);
  assert.ok(buildCrmCalendarEntries(crm.leads, crm.reports).every((entry) => entry.leadId === crmLead.id));
  assert.ok(buildCrmCalendarEntries(manual.leads, manual.reports).every((entry) => entry.leadId === manualLead.id));
  assert.deepEqual(getCrmWorkspaceLeads(data.leads, "campaigns").map((lead) => lead.id), [crmLead.id]);
});

  test("calendar deduplicates appointments and retains the latest report details", () => {
    const entries = buildCrmCalendarEntries([sampleLead], [
      sampleReport,
      { ...sampleReport, id: "report-2", conversationDate: "2026-10-13T11:00:00.000Z", appointmentMode: "Microsoft Teams" },
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "appointment");
    assert.equal(entries[0].reportId, "report-2");
    assert.equal(entries[0].mode, "Microsoft Teams");
  });

  test("calendar takes open callbacks from the lead rather than stale callback reports", () => {
    const callbackReport: CallReport = { ...sampleReport, outcome: "Wiedervorlage", appointmentAt: undefined, nextCallAt: "2026-10-14T09:00:00.000Z" };
    const lead: Lead = { ...sampleLead, status: "wiedervorlage", nextCallAt: "2026-10-16T13:00:00.000Z" };
    assert.deepEqual(buildCrmCalendarEntries([lead], [callbackReport]).map((entry) => entry.at), ["2026-10-16T13:00:00.000Z"]);
    assert.equal(buildCrmCalendarEntries([{ ...lead, status: "angerufen", nextCallAt: undefined }], [callbackReport]).length, 0);
  });

  test("calendar shows unscheduled Gloria tasks as callbacks but excludes completed tasks", () => {
    const task = { id: "task-1", title: "Unterlagen besprechen", dueAt: "2026-10-17T10:00:00.000Z", assignee: "gloria" as const, status: "open" as const, createdAt: "2026-10-13T10:00:00.000Z" };
    const lead = { ...sampleLead, tasks: [task] };
    const entries = buildCrmCalendarEntries([lead], []);
    assert.equal(entries[0].taskId, "task-1");
    assert.equal(entries[0].kind, "callback");
    assert.equal(buildCrmCalendarEntries([{ ...lead, tasks: [{ ...task, scheduledAt: task.dueAt }] }], []).length, 0);
    assert.equal(buildCrmCalendarEntries([{ ...lead, tasks: [{ ...task, status: "done" }] }], []).length, 0);
  });

  test("calendar ignores invalid dates and keeps appointment and callback distinct", () => {
    const lead: Lead = { ...sampleLead, status: "wiedervorlage", nextCallAt: sampleReport.appointmentAt };
    const entries = buildCrmCalendarEntries([lead], [sampleReport, { ...sampleReport, id: "invalid", appointmentAt: "invalid" }]);
    assert.equal(entries.length, 2);
    assert.deepEqual(new Set(entries.map((entry) => entry.kind)), new Set(["appointment", "callback"]));
  });

  test("report-only callbacks use the most recent result and preserve completed outcomes", () => {
    const old: CallReport = { ...sampleReport, leadId: undefined, outcome: "Wiedervorlage", nextCallAt: "2026-10-14T10:00:00.000Z" };
    const latest: CallReport = { ...old, id: "new", outcome: "Absage", conversationDate: "2026-10-13T12:00:00.000Z", nextCallAt: undefined };
    assert.equal(buildCrmCalendarEntries([], [old]).length, 1);
    assert.equal(buildCrmCalendarEntries([], [old, latest]).length, 0);
  });
