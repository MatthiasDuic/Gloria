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
