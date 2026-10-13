import { fetch } from "undici";
import { log } from "./log.js";

export type BusySlot = {
  start: string; // ISO 8601 UTC
  end: string;   // ISO 8601 UTC
};

/**
 * Lädt alle künftigen Termine (outcome=Termin, appointmentAt in Zukunft) des
 * Users vom Vercel-Backend. Wird in den System-Prompt als "BEREITS BELEGT"
 * injiziert, damit Gloria keine Doppelbelegungen vorschlägt.
 */
export async function loadBusySlots(opts: {
  userId?: string;
}): Promise<BusySlot[] | null> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token || !opts.userId) {
    return null;
  }

  const url = `${baseUrl}/api/calendar/busy?userId=${encodeURIComponent(opts.userId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-gloria-internal-token": token },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("busy.http_error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as { slots?: BusySlot[] };
    if (!Array.isArray(json.slots) || json.slots.some((slot) => !slot || !Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end)) || Date.parse(slot.end) <= Date.parse(slot.start))) {
      log.warn("busy.invalid_response");
      return null;
    }
    const slots = json.slots;
    log.info("busy.loaded", { count: slots.length });
    return slots;
  } catch (error) {
    log.warn("busy.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Verdichtet die belegten Slots zu einer für den System-Prompt geeigneten
 * deutschen Liste in Berlin-Zeit. Beispiel:
 *   - Mittwoch, 13. Mai 2026, 14:30–16:00 Uhr
 */
/**
 * Berechnet bis zu `maxCount` Vorschläge mit 90 Minuten Reservierungszeit.
 * (Mo–Fr, 08:30–11:00 und 13:00–18:00 Berlin-Zeit), die NICHT mit den Busy-Slots kollidieren und
 * Belegte Intervalle enthalten bereits die Reservierungszeit, ohne zusätzlichen Puffer.
 * Liefert ISO-Strings (UTC) plus eine Berlin-Zeit-Phrase ("Mittwoch, 13. Mai um 14:30 Uhr").
 */
export function computeFreeSlots(
  busy: BusySlot[],
  opts: { daysAhead?: number; maxCount?: number; reservationMinutes?: number; minLeadDays?: number } = {},
): Array<{ startUtc: string; phrase: string }> {
  const daysAhead = opts.daysAhead ?? 14;
  const maxCount = opts.maxCount ?? 8;
  const reservationMs = (opts.reservationMinutes ?? 90) * 60 * 1000;
  const minLeadMs = (opts.minLeadDays ?? 7) * 24 * 60 * 60 * 1000;

  const fmtBerlin = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Berlin",
  });

  // Berlin-Stunde aus einem UTC-Date holen.
  function berlinHourMinute(d: Date): { hour: number; minute: number; weekday: number } {
    const parts = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hour12: false,
      timeZone: "Europe/Berlin",
    }).formatToParts(d);
    const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");
    const wd = parts.find((p) => p.type === "weekday")?.value || "Mon";
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { hour, minute, weekday: weekdayMap[wd] ?? 0 };
  }

  const candidates: Array<{ startUtc: string; phrase: string }> = [];
  const now = Date.now();
  // Starte standardmäßig frühestens in der nächsten Woche, um keine
  // kurzfristigen Folgetag-Termine als Erstvorschlag zu erzeugen.
  let cursor = now + minLeadMs;
  cursor = Math.ceil(cursor / (30 * 60 * 1000)) * 30 * 60 * 1000;

  const endHorizon = now + daysAhead * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;

  while (cursor < endHorizon) {
    const candidate = new Date(cursor);
    const { hour, minute, weekday } = berlinHourMinute(candidate);
    const timeOfDay = hour * 60 + minute;
    const inMorningWindow = timeOfDay >= 8 * 60 + 30 && timeOfDay <= 11 * 60;
    const inAfternoonWindow = timeOfDay >= 13 * 60 && timeOfDay <= 18 * 60;
    // Nur Mo–Fr.
    if (weekday >= 1 && weekday <= 5 && (inMorningWindow || inAfternoonWindow)) {
      const collides = !isAppointmentSlotFree(candidate.toISOString(), busy, reservationMs / 60_000);
      if (!collides) {
        candidates.push({
          startUtc: candidate.toISOString(),
          phrase: fmtBerlin.format(candidate) + " Uhr",
        });
        cursor += reservationMs;
        continue;
      }

    }
    cursor += 30 * 60 * 1000;
  }

  if (candidates.length <= maxCount) return candidates;
  const distributed: Array<{ startUtc: string; phrase: string }> = [];
  const step = candidates.length / maxCount;
  for (let index = 0; index < maxCount; index += 1) {
    distributed.push(candidates[Math.min(candidates.length - 1, Math.floor(index * step))]);
  }
  return distributed;
}

export function isAppointmentSlotFree(startAt: string, busy: BusySlot[], reservationMinutes = 90): boolean {
  const start = Date.parse(startAt);
  if (!Number.isFinite(start)) return false;
  const end = start + reservationMinutes * 60_000;
  return !busy.some((slot) => start < Date.parse(slot.end) && end > Date.parse(slot.start));
}

/**
 * Verdichtet die freien Slots in einen Prompt-Block, den Gloria nutzen kann,
 * wenn ihr eigener Vorschlag abgelehnt wird oder der Anrufende nach Alternativen fragt.
 */
export function freeSlotsToPrompt(slots: Array<{ startUtc: string; phrase: string }>): string {
  if (slots.length === 0) return "KEINE FREIEN TERMINVORSCHLÄGE im geprüften Zeitraum. Keine Zeiten erfinden oder bestätigen; Kundenwunschzeiten müssen vor der Bestätigung auf Verfügbarkeit geprüft werden.";
  const lines = slots.map((s) => `- ${s.phrase}`);
  return [
    "FREIE TERMIN-VORSCHLÄGE (ohne Doppelbelegung, ab nächster Woche und über mehrere Wochen hinweg):",
    ...lines,
    "Jeder Termin reserviert 90 Minuten inklusive An- und Abreise; dies ist nicht die eigentliche Gesprächsdauer. Es gibt kein Tageslimit: Maßgeblich sind ausschließlich freie Zeiten und Sperrzeiten. Die Liste ist eine Auswahl von Vorschlägen, keine Begrenzung der möglichen Termine.",
    "Frage immer ZUERST nach Vormittag/Nachmittag-Praeferenz. Schlage dann genau zwei dieser Slots vor, die zur Praeferenz passen.",
    "Wenn der Anrufende einen anderen Zeitraum oder eine andere Woche wünscht, akzeptiere diesen Wunsch, frage bei Bedarf kurz nach der gewünschten Woche und wähle danach zwei passende Slots aus diesem späteren Zeitraum. Bestehe nicht auf der zuerst angebotenen Woche. Erfinde niemals freie Zeiten außerhalb dieser Liste.",
    "",
  ].join("\n");
}
