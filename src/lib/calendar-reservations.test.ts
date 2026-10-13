import assert from "node:assert/strict";
import test from "node:test";
import { calendarBusySlots, calendarEntryEnd, getCalendarEntryColor, layoutCalendarDay } from "./calendar-view";
import { buildUnifiedCalendarEntries, type CrmCalendarEntry } from "./crm-helpers";
import type { DashboardData } from "./types";

const day = new Date(2026, 9, 14);
function appointment(id: string, hour: number, minute = 0): CrmCalendarEntry {
  return { id, kind: "appointment", callSource: "crm", at: new Date(2026, 9, 14, hour, minute).toISOString(), company: id, topic: "Test" };
}

test("equal starts and partial overlaps occupy separate columns; touching intervals do not", () => {
  const first = appointment("a", 9);
  const second = appointment("b", 9);
  const partial = appointment("c", 10);
  const after = appointment("d", 11, 30);
  const items = layoutCalendarDay([after, partial, second, first], day);
  assert.equal(new Set(items.filter((item) => item.entry.id !== "d").map((item) => item.column)).size, 3);
  assert.ok(items.slice(0, 3).every((item) => item.columns === 3 && item.height === 90));
  assert.equal(items[3].columns, 1);
  assert.equal(items[3].column, 0);
  const adjacent = layoutCalendarDay([first, appointment("next", 10, 30)], day);
  assert.ok(adjacent.every((item) => item.columns === 1));
});

test("columns are reused inside connected overlap clusters", () => {
  const items = layoutCalendarDay([appointment("a", 9), appointment("b", 10), appointment("c", 10, 30)], day);
  assert.deepEqual(items.map((item) => [item.column, item.columns]), [[0, 2], [1, 2], [0, 2]]);
});

test("multi-day blocks appear clipped on every affected day, not the exclusive end day", () => {
  const block: CrmCalendarEntry = { ...appointment("block", 9), kind: "block",
    at: new Date(2026, 9, 13, 16).toISOString(), endAt: new Date(2026, 9, 15).toISOString() };
  const first = layoutCalendarDay([block], new Date(2026, 9, 13))[0];
  assert.equal(first.top, 16 * 60);
  assert.equal(first.height, 8 * 60);
  const middle = layoutCalendarDay([block], day)[0];
  assert.equal(middle.top, 0);
  assert.equal(middle.height, 1440);
  assert.equal(layoutCalendarDay([block], new Date(2026, 9, 15)).length, 0);
});

test("active reservations are busy, expired reservations and callbacks are not", () => {
  const active = appointment("active", 9);
  const expired = appointment("expired", 7);
  const callback: CrmCalendarEntry = { ...appointment("callback", 10), kind: "callback" };
  const block: CrmCalendarEntry = { ...appointment("block", 11), kind: "block", endAt: new Date(2026, 9, 15, 8).toISOString() };
  const slots = calendarBusySlots([active, expired, callback, block], new Date(2026, 9, 14, 10).getTime());
  assert.equal(slots.length, 2);
  assert.equal(Date.parse(slots[0].end) - Date.parse(slots[0].start), 90 * 60_000);
  assert.equal(slots[1].end, block.endAt);
  assert.equal(calendarEntryEnd(callback) - Date.parse(callback.at), 15 * 60_000);
});

test("own entries are user-scoped, analog or magenta, and never call reports", () => {
  const data: DashboardData = {
    leads: [], reports: [], topicPolicies: [], reportStorageMode: "file", topicPoliciesStorageMode: "file",
    metrics: { dialAttempts: 0, conversations: 0, appointments: 0, rejections: 0, callbacksOpen: 0, gatekeeperLoops: 0, transferSuccessRate: 0 },
    calendarEvents: [
      { id: "own", userId: "a", type: "followup", title: "Kunde", startAt: appointment("a", 9).at, endAt: appointment("a", 10, 30).at, createdAt: day.toISOString() },
      { id: "block", userId: "a", type: "block", title: "Pause", startAt: appointment("a", 12).at, endAt: appointment("a", 13).at, createdAt: day.toISOString() },
      { id: "private", userId: "b", type: "block", title: "Privat", startAt: appointment("a", 9).at, endAt: appointment("a", 12).at, createdAt: day.toISOString() },
    ],
  };
  const entries = buildUnifiedCalendarEntries(data, "a");
  assert.deepEqual(entries.map((entry) => entry.id), ["own", "block"]);
  assert.equal(getCalendarEntryColor(entries[0]), "#6B7C32");
  assert.equal(getCalendarEntryColor(entries[1]), "#C026D3");
  assert.ok(entries.every((entry) => entry.calendarEventId && !entry.leadId && !entry.reportId));
  assert.equal(data.leads.length + data.reports.length, 0);
});
