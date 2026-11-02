import type { DashboardData } from "./types";

export interface DailyGloriaControlling {
  dial_attempts: number;
  conversations: number;
  follow_ups: number;
  appointments: number;
  rejections: number;
}

export function getBerlinDateAndHour(at: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
  };
}

export function aggregateDailyGloriaControlling(
  dashboard: DashboardData,
  date: string,
): DailyGloriaControlling {
  const crmLeadIds = new Set(
    dashboard.leads
      .filter((lead) => lead.callSource === "crm" && Number.isSafeInteger(lead.crmCompanyId))
      .map((lead) => lead.id),
  );
  const uniqueCalls = new Map<string, DashboardData["reports"][number]>();

  for (const report of dashboard.reports) {
    if (report.callSource === "manual" || !report.leadId || !crmLeadIds.has(report.leadId)) continue;
    const conversationDate = new Date(report.conversationDate);
    if (!Number.isFinite(conversationDate.getTime()) || getBerlinDateAndHour(conversationDate).date !== date) continue;
    uniqueCalls.set(report.callSid || report.id, report);
  }

  const reports = [...uniqueCalls.values()];
  return {
    dial_attempts: reports.length,
    conversations: reports.filter((report) => report.outcome !== "Nicht erreicht / kein Kontakt").length,
    follow_ups: reports.filter((report) => report.outcome === "Wiedervorlage").length,
    appointments: reports.filter((report) => report.outcome === "Termin").length,
    rejections: reports.filter((report) => report.outcome === "Absage").length,
  };
}

export function formatDailyGloriaControllingNote(
  date: string,
  metrics: DailyGloriaControlling,
): string {
  const [year, month, day] = date.split("-");
  return `Tagesergebnis Gloria inkl. Datum ${day}.${month}.${year}: Wählversuche ${metrics.dial_attempts}, Gespräche ${metrics.conversations}, Wiedervorlagen ${metrics.follow_ups}, Termine (Erfolg) ${metrics.appointments}, Absagen ${metrics.rejections}.`;
}
