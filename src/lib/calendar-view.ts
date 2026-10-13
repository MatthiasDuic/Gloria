export type CalendarView = "day" | "week" | "workweek" | "month" | "agenda";

export const CALENDAR_VIEWS: ReadonlyArray<{ id: CalendarView; label: string }> = [
  { id: "day", label: "Tag" },
  { id: "week", label: "Woche" },
  { id: "workweek", label: "Arbeitswoche (Mo–Fr)" },
  { id: "month", label: "Monat" },
  { id: "agenda", label: "Agenda" },
];

export function getCalendarDays(anchor: Date, view: CalendarView): Date[] {
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  let count = 1;
  if (view === "month" || view === "agenda") {
    start.setDate(1);
    count = view === "month" ? 42 : new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
    if (view === "month") start.setDate(1 - (start.getDay() + 6) % 7);
  } else if (view === "week" || view === "workweek") {
    start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    count = view === "week" ? 7 : 5;
  }
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

export function moveCalendarDate(anchor: Date, view: CalendarView, offset: number): Date {
  const next = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (view === "month" || view === "agenda") {
    next.setDate(1);
    next.setMonth(next.getMonth() + offset);
    next.setDate(Math.min(anchor.getDate(), new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
  } else {
    next.setDate(next.getDate() + offset * (view === "day" ? 1 : 7));
  }
  return next;
}

export function formatCalendarPeriod(anchor: Date, view: CalendarView): string {
  if (view === "month" || view === "agenda") return anchor.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  if (view === "day") return anchor.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const days = getCalendarDays(anchor, view);
  const format = (date: Date) => date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  return `${format(days[0])} – ${format(days[days.length - 1])}`;
}
import type { CrmCalendarEntry } from "./crm-helpers";
import type { Lead } from "./types";

export function getCalendarEntryColor(entry: Pick<CrmCalendarEntry, "kind" | "callSource">): string {
  return entry.kind === "block" ? "#C026D3" : entry.kind === "callback" ? "#D97706" : entry.callSource === "manual" ? "#6B7C32" : "#2563EB";
}

export function calendarEntryEnd(entry: CrmCalendarEntry): number {
  return entry.endAt ? Date.parse(entry.endAt) : Date.parse(entry.at) + (entry.kind === "callback" ? 15 : 90) * 60_000;
}

export function calendarBusySlots(entries: CrmCalendarEntry[], now = Date.now()): Array<{ start: string; end: string }> {
  return entries.filter((entry) => entry.kind !== "callback" && calendarEntryEnd(entry) > now)
    .map((entry) => ({ start: entry.at, end: new Date(calendarEntryEnd(entry)).toISOString() }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function layoutCalendarDay(entries: CrmCalendarEntry[], day: Date) {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
  const items = entries.filter((entry) => Date.parse(entry.at) < end && calendarEntryEnd(entry) > start)
    .map((entry) => ({
      entry, start: Math.max(start, Date.parse(entry.at)), end: Math.min(end, calendarEntryEnd(entry)),
      column: 0, columns: 1,
    })).sort((a, b) => a.start - b.start || b.end - a.end);
  let cluster: typeof items = [];
  let clusterEnd = 0;
  const finish = () => {
    const count = Math.max(1, ...cluster.map((item) => item.column + 1));
    for (const item of cluster) item.columns = count;
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.start >= clusterEnd) finish();
    const occupied = new Set(cluster.filter((other) => other.end > item.start).map((other) => other.column));
    while (occupied.has(item.column)) item.column++;
    cluster.push(item);
    clusterEnd = Math.max(...cluster.map((other) => other.end));
  }
  finish();
  const minutes = (at: number) => {
    if (at === end) return 1440;
    const date = new Date(at);
    return date.getHours() * 60 + date.getMinutes();
  };
  return items.map((item) => ({ ...item, top: minutes(item.start), height: minutes(item.end) - minutes(item.start) }));
}

export async function saveCalendarCallback(entry: CrmCalendarEntry, lead: Lead, at?: string): Promise<void> {
  const manual = entry.callSource === "manual" || lead.callSource === "manual";
  const response = await fetch(manual ? "/api/reports" : "/api/campaigns/lists", {
    method: manual ? "PATCH" : "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manual ? {
      leadId: lead.id, nextCallAt: at || "",
    } : entry.taskId && !at ? {
      action: "complete_lead_task", leadId: lead.id, taskId: entry.taskId,
    } : {
      action: "update_lead_details", leadId: lead.id,
      updates: entry.taskId ? {
        tasks: (lead.tasks || []).map((task) => task.id === entry.taskId ? { ...task, dueAt: at } : task),
      } : { nextCallAt: at || "", status: at ? "wiedervorlage" : "angerufen" },
    }),
  });
  const payload = await response.json() as { error?: string };
  if (!response.ok) throw new Error(payload.error || "Wiedervorlage konnte nicht gespeichert werden.");
}
