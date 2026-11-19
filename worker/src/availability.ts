import { computeFreeSlots, type BusySlot } from "./busy.js";

export type PartOfDay = "morning" | "afternoon" | "any";

export type FreeSlotQuery = {
  fromDate?: string;
  toDate?: string;
  partOfDay?: PartOfDay;
  maxResults?: number;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const berlinDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
const berlinHour = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false });

export function parseFreeSlotQuery(args: Record<string, unknown>): FreeSlotQuery {
  const date = (value: unknown) => (typeof value === "string" && DATE_PATTERN.test(value.trim()) ? value.trim() : undefined);
  const part = args.part_of_day === "morning" || args.part_of_day === "afternoon" ? args.part_of_day : "any";
  const max = typeof args.max_results === "number" && Number.isFinite(args.max_results) ? Math.trunc(args.max_results) : 4;
  return { fromDate: date(args.from_date), toDate: date(args.to_date), partOfDay: part, maxResults: Math.min(Math.max(max, 1), 6) };
}

/**
 * Sucht freie Termine rein lokal aus bereits geladenen Kalenderdaten (kein Netzwerk, daher ohne Gesprächs-Latenz).
 * Es gelten dieselben Regeln wie bei den Vorschlägen im Prompt: 7 Tage Vorlauf, Mo–Fr, 90 Minuten Reservierung.
 */
export function findFreeSlots(busy: BusySlot[], query: FreeSlotQuery): Array<{ startUtc: string; phrase: string }> {
  const all = computeFreeSlots(busy, { daysAhead: 120, maxCount: 10_000, minLeadDays: 7 });
  const matching = all.filter((slot) => {
    const date = new Date(slot.startUtc);
    const day = berlinDay.format(date);
    if (query.fromDate && day < query.fromDate) return false;
    if (query.toDate && day > query.toDate) return false;
    const hour = Number(berlinHour.format(date));
    if (query.partOfDay === "morning") return hour < 12;
    if (query.partOfDay === "afternoon") return hour >= 12;
    return true;
  });

  const maxResults = query.maxResults ?? 4;
  const picked: typeof matching = [];
  const usedDays = new Set<string>();
  for (const slot of matching) {
    const day = berlinDay.format(new Date(slot.startUtc));
    if (usedDays.has(day)) continue;
    usedDays.add(day);
    picked.push(slot);
    if (picked.length >= maxResults) break;
  }
  return picked;
}
