"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CrmCalendarEntry } from "@/lib/crm-helpers";
import type { Lead } from "@/lib/types";
import { CALENDAR_VIEWS, calendarEntryEnd, formatCalendarPeriod, getCalendarDays, layoutCalendarDay, moveCalendarDate, saveCalendarCallback, type CalendarView } from "@/lib/calendar-view";
import styles from "./GloriaCalendar.module.css";

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function entryLabel(entry: CrmCalendarEntry) {
  return entry.kind === "block" ? "Sperrzeit" : entry.kind === "callback" ? entry.taskId ? "Gloria-Aufgabe" : "Wiedervorlage" : entry.callSource === "manual" ? "Analoger Termin" : "CRM-Termin";
}

function entryStyle(entry: CrmCalendarEntry) {
  return entry.kind === "block" ? styles.block : entry.kind === "callback" ? styles.callback : entry.callSource === "manual" ? styles.manual : styles.crm;
}

function localDateTime(at: string | number | Date) {
  const date = new Date(at);
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface Props {
  entries: CrmCalendarEntry[];
  leads: Lead[];
  onOpenReport: (entry: CrmCalendarEntry) => void;
  onOpenContact?: (lead: Lead) => void;
  onChanged: () => Promise<void>;
}

export default function GloriaCalendar({ entries, leads, onOpenReport, onOpenContact, onChanged }: Props) {
  const [anchor, setAnchor] = useState(() => new Date());
  const [view, setView] = useState<CalendarView>("month");
  const [kind, setKind] = useState<"all" | "appointment" | "callback" | "block">("all");
  const [editor, setEditor] = useState<{ id?: string; type: "followup" | "block"; title: string; startAt: string; endAt: string; note: string } | null>(null);
  const editing = editor !== null;
  const [selected, setSelected] = useState<CrmCalendarEntry | null>(null);
  const [reschedule, setReschedule] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const timeGridRef = useRef<HTMLDivElement>(null);
  const days = getCalendarDays(anchor, view);
  const today = dateKey(new Date());
  const selectedDay = dateKey(anchor);
  const byDay = useMemo(() => {
    const grouped = new Map<string, CrmCalendarEntry[]>();
    for (const day of getCalendarDays(anchor, view)) {
      const items = layoutCalendarDay(entries.filter((entry) => kind === "all" || entry.kind === kind), day).map((item) => item.entry);
      if (items.length) grouped.set(dateKey(day), items);
    }
    return grouped;
  }, [entries, kind, anchor, view]);

  useEffect(() => {
    if (view === "day" || view === "week" || view === "workweek") {
      const morning = timeGridRef.current?.querySelector<HTMLElement>('[data-hour="8"]');
      if (morning && timeGridRef.current) timeGridRef.current.scrollTop = morning.offsetTop - 44;
    }
  }, [view, anchor]);

  useEffect(() => {
    if ((!selected && !editing) || !panelRef.current) return;
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]')];
    (focusables()[0] || panel).focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) { event.preventDefault(); setSelected(null); setEditor(null); }
      if (event.key === "Tab") {
        const elements = focusables();
        const first = elements[0] || panel;
        const last = elements.at(-1) || panel;
        if (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", handle);
      if (previous?.isConnected) previous.focus();
    };
  }, [selected, editing, busy]);

  useEffect(() => {
    if (selected && !entries.some((entry) => entry.id === selected.id && entry.callSource === selected.callSource)) setSelected(null);
  }, [entries, selected]);

  const open = (entry: CrmCalendarEntry) => { setSelected(entry); setReschedule(null); setError(""); };
  const renderEvent = (entry: CrmCalendarEntry) => (
    <button type="button" key={`${entry.callSource}-${entry.id}`} className={`${styles.event} ${entryStyle(entry)}`} onClick={() => open(entry)}
      title={`${entryLabel(entry)}: ${entry.company} · ${entry.topic}`}>
      <span className={styles.eventTime}>{new Date(entry.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · {entryLabel(entry)}</span>
      <strong>{entry.company}</strong>
      {view !== "month" ? <span>{entry.contactName || entry.topic}</span> : null}
    </button>
  );

  async function updateCallback(at?: string) {
    if (!selected) return;
    const lead = leads.find((candidate) => candidate.id === selected.leadId);
    if (!lead) { setError("Kein Kontakt zur Wiedervorlage gefunden."); return; }
    if (at && !Number.isFinite(Date.parse(at))) { setError("Bitte einen gültigen Zeitpunkt eingeben."); return; }
    setBusy(true);
    setError("");
    try {
      await saveCalendarCallback(selected, lead, at ? new Date(at).toISOString() : undefined);
      await onChanged();
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wiedervorlage konnte nicht gespeichert werden.");
    } finally { setBusy(false); }
  }

  function editEntry(entry?: CrmCalendarEntry) {
    const startAt = entry?.at || new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), 9).toISOString();
    setEditor({ id: entry?.calendarEventId, type: entry?.kind === "block" ? "block" : "followup",
      title: entry?.company || "", startAt: localDateTime(startAt),
      endAt: localDateTime(entry ? calendarEntryEnd(entry) : new Date(Date.parse(startAt) + 90 * 60_000)),
      note: entry?.summary || "" });
    setSelected(null);
    setError("");
  }

  async function persistEntry(remove = false) {
    if ((!editor && !remove) || (remove && !selected?.calendarEventId)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(remove ? `/api/calendar/events?id=${encodeURIComponent(selected!.calendarEventId!)}` : "/api/calendar/events", {
        method: remove ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(!remove && editor ? { body: JSON.stringify({ ...editor, startAt: new Date(editor.startAt).toISOString(), endAt: editor.type === "block" ? new Date(editor.endAt).toISOString() : undefined }) } : {}),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Kalendereintrag konnte nicht gespeichert werden.");
      await onChanged();
      setSelected(null);
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kalendereintrag konnte nicht gespeichert werden.");
    } finally { setBusy(false); }
  }

  const selectedLead = leads.find((lead) => lead.id === selected?.leadId);
  const navigate = (offset: number) => setAnchor(moveCalendarDate(anchor, view, offset));
  const periodCount = new Set(days.flatMap((day) => (byDay.get(dateKey(day)) || []).map((entry) => entry.id))).size;
  return (
    <section className={styles.calendar} aria-label="Gemeinsamer Kalender">
      <header className={styles.toolbar}>
        <div className={styles.navigation}>
          <button type="button" onClick={() => setAnchor(new Date())}>Heute</button>
          <button type="button" aria-label="Vorheriger Zeitraum" onClick={() => navigate(-1)}>‹</button>
          <button type="button" aria-label="Nächster Zeitraum" onClick={() => navigate(1)}>›</button>
          <h3 aria-live="polite">{formatCalendarPeriod(anchor, view)}</h3>
        </div>
        <div className={styles.views} role="group" aria-label="Kalenderansicht">
          {CALENDAR_VIEWS.map((mode) => <button type="button" key={mode.id} aria-pressed={view === mode.id} onClick={() => setView(mode.id)}>{mode.label}</button>)}
        </div>
        <button type="button" onClick={() => editEntry()}>Neuer Eintrag</button>
      </header>
      <div className={styles.legend}>
        <span className={styles.crm}>CRM-Termine · Blau</span>
        <span className={styles.manual}>Analoge Termine · Olivgrün</span>
        <span className={styles.callback}>Wiedervorlagen · Orange</span>
        <span className={styles.block}>Sperrzeiten · Magenta</span>
        <label>Anzeige <select aria-label="Kalender filtern" value={kind} onChange={(event) => setKind(event.target.value === "appointment" ? "appointment" : event.target.value === "callback" ? "callback" : event.target.value === "block" ? "block" : "all")}>
          <option value="all">Alle Einträge</option><option value="appointment">Nur Termine</option><option value="callback">Nur Wiedervorlagen</option><option value="block">Nur Sperrzeiten</option>
        </select></label>
        <small>{periodCount} Einträge</small>
      </div>
      {view === "month" ? (
        <div className={styles.monthLayout}>
          <div className={styles.month}>
            <div className={styles.weekdays}>{["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((day) => <span key={day}>{day}</span>)}</div>
            <div className={styles.monthGrid}>
              {days.map((day) => {
                const key = dateKey(day);
                const items = byDay.get(key) || [];
                return <div key={key} className={`${styles.dayCell} ${day.getMonth() !== anchor.getMonth() ? styles.outside : ""} ${key === selectedDay ? styles.selectedDay : ""}`}>
                  <button type="button" className={`${styles.dayNumber} ${key === today ? styles.today : ""}`} aria-pressed={key === selectedDay}
                    aria-label={`${day.toLocaleDateString("de-DE")}: ${items.length} Einträge`} onClick={() => setAnchor(day)}>{day.getDate()}</button>
                  {items.slice(0, 3).map(renderEvent)}
                  {items.length > 3 ? <button type="button" className={styles.more} onClick={() => { setAnchor(day); setView("day"); }}>+{items.length - 3} weitere</button> : null}
                </div>;
              })}
            </div>
          </div>
          <aside className={styles.dayDetails}>
            <h4>{anchor.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</h4>
            {(byDay.get(selectedDay) || []).map(renderEvent)}
            {!(byDay.get(selectedDay) || []).length ? <p>Keine Einträge an diesem Tag.</p> : null}
          </aside>
        </div>
      ) : view === "agenda" ? (
        <div className={styles.agenda}>
          {days.filter((day) => byDay.has(dateKey(day))).map((day) => <section key={dateKey(day)}><h4>{day.toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</h4>
            {(byDay.get(dateKey(day)) || []).map(renderEvent)}
          </section>)}
          {!periodCount ? <p>Keine Einträge in diesem Monat.</p> : null}
        </div>
      ) : (
        <div className={styles.timeScroll} ref={timeGridRef}>
          <div className={styles.timeGrid} style={{ gridTemplateColumns: `52px repeat(${days.length}, minmax(${days.length === 1 ? 240 : 150}px, 1fr))` }}>
            <div className={styles.timeHeader}>Uhrzeit</div>
            {days.map((day) => <div className={`${styles.timeHeader} ${dateKey(day) === today ? styles.todayHeader : ""}`} key={dateKey(day)}>{day.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" })}</div>)}
            <div className={styles.timeLabels}>{Array.from({ length: 24 }, (_, hour) => <div className={styles.hour} data-hour={hour} key={hour}>{String(hour).padStart(2, "0")}:00</div>)}</div>
            {days.map((day) => <div className={styles.timeDay} key={dateKey(day)}>
              {layoutCalendarDay(byDay.get(dateKey(day)) || [], day).map((item) => <div key={item.entry.id} className={styles.timedEvent}
                style={{ top: item.top * 64 / 60, height: item.height * 64 / 60, left: `${item.column * 100 / item.columns}%`, width: `${100 / item.columns}%` }}>
                {renderEvent(item.entry)}
              </div>)}
            </div>)}
          </div>
        </div>
      )}
      {selected || editor ? <div className={styles.overlay} onClick={(event) => { if (event.target === event.currentTarget && !busy) { setSelected(null); setEditor(null); } }}>
        <div ref={panelRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label="Kalendereintrag" tabIndex={-1}>
          {editor ? <form className={styles.entryForm} onSubmit={(event) => { event.preventDefault(); void persistEntry(); }}>
            <header><h3>{editor.id ? "Eintrag bearbeiten" : "Neuer Kalendereintrag"}</h3><button type="button" aria-label="Kalendereintrag schließen" disabled={busy} onClick={() => setEditor(null)}>×</button></header>
            <label>Art <select value={editor.type} onChange={(event) => setEditor({ ...editor, type: event.target.value === "block" ? "block" : "followup" })}><option value="followup">Folgetermin · Analog</option><option value="block">Sperrzeit</option></select></label>
            <label>Titel / Kunde <input required maxLength={200} value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label>
            <label>Beginn <input required type="datetime-local" value={editor.startAt} onChange={(event) => setEditor({ ...editor, startAt: event.target.value })} /></label>
            {editor.type === "block" ? <label>Ende <input required type="datetime-local" min={editor.startAt} value={editor.endAt} onChange={(event) => setEditor({ ...editor, endAt: event.target.value })} /></label>
              : <p>Reserviert 90 Minuten inklusive An- und Abreise. Die eigentliche Termindauer ist davon unabhängig.</p>}
            <label>Notiz <textarea maxLength={5000} value={editor.note} onChange={(event) => setEditor({ ...editor, note: event.target.value })} /></label>
            <button type="submit" disabled={busy}>{busy ? "Speichert …" : "Speichern"}</button>
          </form> : selected ? <>
          <header><span className={`${styles.badge} ${entryStyle(selected)}`}>{entryLabel(selected)}</span><button type="button" aria-label="Kalendereintrag schließen" disabled={busy} onClick={() => setSelected(null)}>×</button></header>
          <h3>{selected.company}</h3>
          <p>{new Date(selected.at).toLocaleString("de-DE", { dateStyle: "full", timeStyle: "short" })}</p>
          <p>{selected.kind === "callback" ? null : <>Reserviert bis {new Date(calendarEntryEnd(selected)).toLocaleString("de-DE")} {selected.kind === "appointment" ? "(90 Minuten inklusive An- und Abreise)" : null}</>}</p>
          <p><strong>Quelle:</strong> {selected.kind === "block" ? "Eigene Sperrzeit" : selected.callSource === "manual" ? "Analoge Termine" : "CRM"}</p>
          <p>{selected.contactName}</p><p>{selected.topic}{selected.mode ? ` · ${selected.mode}` : ""}</p>
          {selected.phone ? <a href={`tel:${selected.phone}`}>{selected.phone}</a> : null}
          {selected.summary ? <p className={styles.summary}>{selected.summary.replace(/---\s*GESPRAECHSPROTOKOLL[\s\S]*$/i, "").trim()}</p> : null}
          <div className={styles.actions}>
            {selected.calendarEventId ? <>
              <button type="button" disabled={busy} onClick={() => editEntry(selected)}>Bearbeiten</button>
              <button type="button" disabled={busy} onClick={() => { if (window.confirm("Diesen Kalendereintrag löschen?")) void persistEntry(true); }}>Löschen</button>
            </> : null}
            {selected.reportId ? <button type="button" onClick={() => { setSelected(null); onOpenReport(selected); }}>Anrufdetails</button> : null}
            {selectedLead && selected.callSource === "crm" && onOpenContact ? <button type="button" onClick={() => { setSelected(null); onOpenContact(selectedLead); }}>Kontaktakte</button> : null}
            {selected.kind === "callback" && selectedLead ? <>
              <button type="button" disabled={busy} onClick={() => { const date = new Date(selected.at); setReschedule(`${dateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`); }}>Verschieben</button>
              <button type="button" disabled={busy} onClick={() => void updateCallback()}>Erledigt</button>
            </> : null}
          </div>
          {reschedule !== null ? <form className={styles.actions} onSubmit={(event) => { event.preventDefault(); void updateCallback(reschedule); }}>
            <label>Neuer Zeitpunkt <input required type="datetime-local" value={reschedule} onChange={(event) => setReschedule(event.target.value)} /></label>
            <button type="submit" disabled={busy}>Speichern</button>
          </form> : null}
          </> : null}
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        </div>
      </div> : null}
    </section>
  );
}
