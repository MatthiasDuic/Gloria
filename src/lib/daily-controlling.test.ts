import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateDailyGloriaControlling,
  formatDailyGloriaControllingNote,
  getBerlinDateAndHour,
} from "./daily-controlling";
import type { DashboardData, Lead } from "./types";

const crmLead: Lead = {
  id: "crm-lead",
  userId: "user-1",
  callSource: "crm",
  crmCompanyId: 42,
  company: "Beispiel GmbH",
  topic: "bKV",
  status: "angerufen",
  attempts: 2,
};

const report = (
  id: string,
  outcome: DashboardData["reports"][number]["outcome"],
  conversationDate = "2026-11-02T18:10:00.000Z",
  callSid = id,
): DashboardData["reports"][number] => ({
  id,
  callSid,
  leadId: crmLead.id,
  callSource: "crm",
  userId: "user-1",
  company: crmLead.company,
  topic: crmLead.topic,
  summary: "Bericht",
  outcome,
  conversationDate,
  attempts: 1,
  recordingConsent: false,
  emailedTo: "",
});

function dashboard(
  leads: Lead[],
  reports: DashboardData["reports"],
): DashboardData {
  return {
    leads,
    reports,
    topicPolicies: [],
    metrics: {
      dialAttempts: 0,
      conversations: 0,
      appointments: 0,
      rejections: 0,
      callbacksOpen: 0,
      gatekeeperLoops: 0,
      transferSuccessRate: 0,
    },
    reportStorageMode: "file",
    topicPoliciesStorageMode: "file",
  };
}

test("daily Gloria metrics count distinct CRM calls by Berlin date and exclude unrelated calls", () => {
  const manualLead = { ...crmLead, id: "manual", callSource: "manual" as const, crmCompanyId: undefined };
  const reports = [
    report("call-1", "Wiedervorlage"),
    report("call-1-duplicate", "Wiedervorlage", "2026-11-02T18:10:00.000Z", "call-1"),
    report("call-2", "Termin"),
    report("call-3", "Absage"),
    report("call-4", "Nicht erreicht / kein Kontakt"),
    report("previous-day", "Termin", "2026-11-01T22:59:00.000Z"),
    { ...report("manual-call", "Termin"), leadId: manualLead.id, callSource: "manual" as const },
  ];

  assert.deepEqual(
    aggregateDailyGloriaControlling(dashboard([crmLead, manualLead], reports), "2026-11-02"),
    { dial_attempts: 4, conversations: 3, follow_ups: 1, appointments: 1, rejections: 1 },
  );
});

test("Berlin schedule date handles winter and summer UTC offsets", () => {
  assert.deepEqual(getBerlinDateAndHour(new Date("2026-11-02T18:00:00.000Z")), {
    date: "2026-11-02",
    hour: 19,
  });
  assert.deepEqual(getBerlinDateAndHour(new Date("2026-07-02T17:00:00.000Z")), {
    date: "2026-07-02",
    hour: 19,
  });
});

test("daily note includes the date and all controlling metrics", () => {
  assert.equal(
    formatDailyGloriaControllingNote("2026-11-02", {
      dial_attempts: 12,
      conversations: 7,
      follow_ups: 2,
      appointments: 1,
      rejections: 3,
    }),
    "Tagesergebnis Gloria inkl. Datum 02.11.2026: Wählversuche 12, Gespräche 7, Wiedervorlagen 2, Termine (Erfolg) 1, Absagen 3.",
  );
});
