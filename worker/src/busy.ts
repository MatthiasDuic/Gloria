import { fetch } from "undici";
import { log } from "./log.js";

type BusySlot = {
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
    const slots = Array.isArray(json.slots) ? json.slots : [];
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
export function busySlotsToPrompt(slots: BusySlot[]): string {
  if (slots.length === 0) {
    return "BEREITS BELEGTE TERMINE: Aktuell keine. Du kannst innerhalb der Geschäftszeiten frei vorschlagen.";
  }

  const fmtDate = new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Berlin",
  });
  const fmtTime = new Intl.DateTimeFormat("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
    hour12: false,
  });

  const lines: string[] = [];
  for (const s of slots) {
    const start = new Date(s.start);
    const end = new Date(s.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    lines.push(`- ${fmtDate.format(start)}, ${fmtTime.format(start)}–${fmtTime.format(end)} Uhr`);
  }

  return [
    "BEREITS BELEGTE TERMINE (HARTE REGEL – KEINE DOPPELBELEGUNG):",
    "Die folgenden Zeitfenster sind bereits durch andere Termine blockiert.",
    "Schlage NIEMALS einen Slot vor, der sich mit einem dieser Fenster überschneidet.",
    "Plane mindestens 90 Minuten Puffer pro neuem Termin ein.",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Berechnet bis zu `maxCount` 30-Minuten-Slots in den nächsten `daysAhead` Geschäftstagen
 * (Mo–Fr, 09:00–19:00 Berlin-Zeit), die NICHT mit den Busy-Slots kollidieren und
 * mindestens `bufferMinutes` Puffer zu jedem belegten Slot wahren.
 * Liefert ISO-Strings (UTC) plus eine Berlin-Zeit-Phrase ("Mittwoch, 13. Mai um 14:30 Uhr").
 */
export function computeFreeSlots(
  busy: BusySlot[],
  opts: { daysAhead?: number; maxCount?: number; bufferMinutes?: number } = {},
): Array<{ startUtc: string; phrase: string }> {
  const daysAhead = opts.daysAhead ?? 5;
  const maxCount = opts.maxCount ?? 6;
  const bufferMs = (opts.bufferMinutes ?? 90) * 60 * 1000;

  const busyRanges = busy
    .map((s) => ({ start: new Date(s.start).getTime(), end: new Date(s.end).getTime() }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end));

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

  const out: Array<{ startUtc: string; phrase: string }> = [];
  const now = Date.now();
  // Starte beim nächsten halben/vollen Stundenraster, mindestens +60min ab jetzt.
  let cursor = now + 60 * 60 * 1000;
  cursor -= cursor % (30 * 60 * 1000);

  const endHorizon = now + daysAhead * 24 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;

  while (cursor < endHorizon && out.length < maxCount) {
    const candidate = new Date(cursor);
    const { hour, weekday } = berlinHourMinute(candidate);
    // Nur Mo–Fr.
    if (weekday >= 1 && weekday <= 5 && hour >= 9 && hour < 19) {
      const slotEnd = cursor + 30 * 60 * 1000;
      const collides = busyRanges.some(
        (r) => cursor < r.end + bufferMs && slotEnd > r.start - bufferMs,
      );
      if (!collides) {
        out.push({
          startUtc: candidate.toISOString(),
          phrase: fmtBerlin.format(candidate) + " Uhr",
        });
        // Nächstes Mal mindestens +90min weiter, damit wir nicht 4× denselben Tag haben.
        cursor += 90 * 60 * 1000;
        continue;
      }
    }
    cursor += 30 * 60 * 1000;
  }

  return out;
}

/**
 * Verdichtet die freien Slots in einen Prompt-Block, den Gloria nutzen kann,
 * wenn ihr eigener Vorschlag abgelehnt wird oder der Anrufende nach Alternativen fragt.
 */
export function freeSlotsToPrompt(slots: Array<{ startUtc: string; phrase: string }>): string {
  if (slots.length === 0) return "";
  const lines = slots.map((s) => `- ${s.phrase}`);
  return [
    "FREIE TERMIN-VORSCHLÄGE (sofort verfügbar, ohne Doppelbelegung – nutze diese Liste, falls dein erster Vorschlag abgelehnt wird):",
    ...lines,
    "Frage immer ZUERST nach Vormittag/Nachmittag-Präferenz. Schlage dann zwei dieser Slots vor, die zur Präferenz passen.",
    "Wenn der Anrufende beide ablehnt, nimm die nächsten passenden aus dieser Liste – KEINE freien Erfindungen außerhalb dieser Liste.",
    "",
  ].join("\n");
}
