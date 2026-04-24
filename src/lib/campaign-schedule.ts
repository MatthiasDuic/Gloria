/**
 * Arbeitszeit-Fenster fuer automatische Kampagnenanrufe.
 *
 * Default: Mo-Fr 09:00-12:00 und 13:00-17:00 in Europe/Berlin.
 * Einstellungen koennen via Env-Variablen ueberschrieben werden
 * (CAMPAIGN_TIMEZONE, CAMPAIGN_SLOTS im Format "09:00-12:00,13:00-17:00").
 */

export interface ScheduleWindow {
  startMinute: number;
  endMinute: number;
}

const DEFAULT_TIMEZONE = "Europe/Berlin";
const DEFAULT_SLOTS = "09:00-12:00,13:00-17:00";

function getTimezone(): string {
  return process.env.CAMPAIGN_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

function parseSlots(raw: string): ScheduleWindow[] {
  const windows: ScheduleWindow[] = [];

  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const [startPart, endPart] = trimmed.split("-").map((p) => p.trim());
    if (!startPart || !endPart) continue;

    const [sh, sm] = startPart.split(":").map((v) => Number.parseInt(v, 10));
    const [eh, em] = endPart.split(":").map((v) => Number.parseInt(v, 10));

    if ([sh, sm, eh, em].some((v) => Number.isNaN(v))) continue;

    const startMinute = sh * 60 + sm;
    const endMinute = eh * 60 + em;

    if (endMinute <= startMinute) continue;

    windows.push({ startMinute, endMinute });
  }

  return windows;
}

function getWindows(): ScheduleWindow[] {
  const raw = process.env.CAMPAIGN_SLOTS?.trim() || DEFAULT_SLOTS;
  const windows = parseSlots(raw);
  return windows.length > 0 ? windows : parseSlots(DEFAULT_SLOTS);
}

/** 1 = Monday, 7 = Sunday (ISO). */
function getWeekdayAndMinuteInTimezone(
  now: Date,
  timeZone: string,
): { weekday: number; minuteOfDay: number } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(now);
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const hourStr = parts.find((p) => p.type === "hour")?.value || "00";
  const minuteStr = parts.find((p) => p.type === "minute")?.value || "00";

  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const weekday = weekdayMap[weekdayStr] ?? 1;
  const minuteOfDay =
    Number.parseInt(hourStr, 10) * 60 + Number.parseInt(minuteStr, 10);

  return { weekday, minuteOfDay };
}

export function isWithinCampaignHours(now: Date = new Date()): boolean {
  const { weekday, minuteOfDay } = getWeekdayAndMinuteInTimezone(
    now,
    getTimezone(),
  );

  // Nur Mo-Fr (1-5)
  if (weekday < 1 || weekday > 5) {
    return false;
  }

  return getWindows().some(
    (win) => minuteOfDay >= win.startMinute && minuteOfDay < win.endMinute,
  );
}

export function describeCampaignSchedule(): {
  timezone: string;
  windows: string[];
} {
  return {
    timezone: getTimezone(),
    windows: getWindows().map((win) => {
      const fmt = (total: number) =>
        `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
      return `${fmt(win.startMinute)}-${fmt(win.endMinute)}`;
    }),
  };
}
