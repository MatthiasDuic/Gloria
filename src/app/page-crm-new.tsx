"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DashboardData, TopicPolicyConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";
import topicPolicyDefaults from "../../data/topic-policies.json";

const SAMPLE_CSV = `company,contactName,phone,email,topic,note,nextCallAt
Musterbau GmbH,Herr Neumann,+49 2339 555100,neumann@musterbau.de,betriebliche Krankenversicherung,120 Mitarbeitende; Recruiting Thema,
Sprockhoevel Energieberatung,Frau Peters,+49 2324 555200,peters@se-beratung.de,Energie,Vertragsverlängerung in 90 Tagen,2026-04-15T10:00:00.000Z`;

const EMPTY_DATA: DashboardData = {
  leads: [],
  reports: [],
  topicPolicies: [],
  reportStorageMode: "file",
  topicPoliciesStorageMode: "file",
  metrics: {
    dialAttempts: 0,
    conversations: 0,
    appointments: 0,
    rejections: 0,
    callbacksOpen: 0,
    gatekeeperLoops: 0,
    transferSuccessRate: 0,
  },
};

type CampaignListSummary = {
  listId: string;
  listName: string;
  active: boolean;
  currentlyDialing?: boolean;
  total: number;
  pending: number;
  called: number;
  appointments: number;
  callbacks: number;
  rejections: number;
};

type SessionUser = {
  id: string;
  username: string;
  role: "master" | "user";
  realName: string;
  companyName: string;
  calendarFeedToken?: string;
  selectedVoiceId?: string;
  allowedPlaybookTopics?: string[];
};

type AdminUser = {
  id: string;
  username: string;
  role: "master" | "user";
  realName: string;
  companyName: string;
  address?: string;
  email?: string;
  realPhone?: string;
  gesellschaft?: string;
  createdAt?: string;
  selectedVoiceId?: string;
  allowedPlaybookTopics?: string[];
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function toDateKey(value: Date) {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatOutcomeLabel(value?: string): string {
  const normalized = (value || "").trim();
  if (!normalized) return "–";
  if (/^termin$/i.test(normalized)) return "Termin";
  if (/^absage$/i.test(normalized)) return "Absage";
  if (/^wiedervorlage$/i.test(normalized)) return "Wiedervorlage";
  if (/kein\s*kontakt|nicht\s*erreicht/i.test(normalized)) return "Nicht erreicht";
  if (/gespraech\s*abgebrochen|abgebrochen/i.test(normalized)) return "Abgebrochen";
  return normalized;
}

function reportOutcomeBucket(report: DashboardData["reports"][number]): "no_contact" | "aborted" | "callback" | "appointment" | "rejection" {
  const outcome = (report.outcome || "").trim();
  if (/termin/i.test(outcome)) return "appointment";
  if (/wiedervorlage/i.test(outcome)) return "callback";
  if (/absage/i.test(outcome)) return "rejection";
  if (/gespraech\s*abgebrochen/i.test(`${outcome} ${report.summary || ""}`)) return "aborted";
  return "no_contact";
}

function normalizeComparableText(value?: string) {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizePhoneDigits(value?: string) {
  return (value || "").replace(/\D+/g, "");
}

function phoneLooksEqual(a?: string, b?: string) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shortLeft = left.length > 8 ? left.slice(-8) : left;
  const shortRight = right.length > 8 ? right.slice(-8) : right;
  return shortLeft === shortRight;
}

function reportMatchesLead(
  report: DashboardData["reports"][number],
  lead: DashboardData["leads"][number],
) {
  if (report.leadId && report.leadId === lead.id) return true;
  const companyMatch = normalizeComparableText(report.company) === normalizeComparableText(lead.company);
  if (!companyMatch) return false;
  const contactMatch = normalizeComparableText(report.contactName) === normalizeComparableText(lead.contactName);
  const phoneMatch = phoneLooksEqual(report.directDial, lead.directDial) || phoneLooksEqual(report.directDial, lead.phone);
  return contactMatch || phoneMatch || report.topic === lead.topic;
}

function getLeadStatus(lead: DashboardData["leads"][number], leadReports: DashboardData["reports"]) {
  const latestReport = [...leadReports].sort((a, b) => {
    const aTime = Date.parse(a.conversationDate || "") || 0;
    const bTime = Date.parse(b.conversationDate || "") || 0;
    return bTime - aTime;
  })[0];

  if (lead.status === "termin" || latestReport?.outcome === "Termin") {
    return { color: "success", label: "Termin vereinbart", icon: "✓" };
  }
  if (lead.status === "absage" || latestReport?.outcome === "Absage") {
    return { color: "danger", label: "Absage", icon: "✕" };
  }
  if (lead.status === "wiedervorlage" || latestReport?.outcome === "Wiedervorlage" || lead.nextCallAt) {
    return { color: "warning", label: "Wiedervorlage", icon: "↻" };
  }
  if (lead.status === "angerufen" || leadReports.length > 0 || lead.attempts > 0) {
    return { color: "info", label: "In Bearbeitung", icon: "→" };
  }
  return { color: "neutral", label: "Offen", icon: "⊙" };
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function CRMDashboard() {
  // State Management
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");

  // View & Filter State
  const [activeView, setActiveView] = useState<"dashboard" | "contacts" | "calendar" | "tasks" | "settings">("dashboard");
  const [selectedLead, setSelectedLead] = useState<DashboardData["leads"][number] | null>(null);
  const [selectedReport, setSelectedReport] = useState<DashboardData["reports"][number] | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterTopic, setFilterTopic] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");

  // Import & Campaign State
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importListName, setImportListName] = useState("");
  const [importTopic, setImportTopic] = useState<Topic | "">(TOPICS[0]);
  const [campaignLists, setCampaignLists] = useState<CampaignListSummary[]>([]);
  const [runningListIds, setRunningListIds] = useState<string[]>([]);

  // Calendar State
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));

  // Computed Values
  const appointmentsByDay = useMemo(() => {
    const map = new Map<string, DashboardData["reports"]>();
    for (const report of data.reports || []) {
      if (!report.appointmentAt) continue;
      const key = toDateKey(new Date(report.appointmentAt));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(report);
    }
    return map;
  }, [data.reports]);

  const leadAmpelById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getLeadStatus>>();
    for (const lead of data.leads || []) {
      const leadReports = (data.reports || []).filter((r) => reportMatchesLead(r, lead));
      map.set(lead.id, getLeadStatus(lead, leadReports));
    }
    return map;
  }, [data.leads, data.reports]);

  const filteredLeads = useMemo(() => {
    let leads = data.leads || [];
    if (filterStatus) {
      leads = leads.filter((l) => l.status === filterStatus);
    }
    if (filterTopic) {
      leads = leads.filter((l) => l.topic === filterTopic);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      leads = leads.filter((l) =>
        l.company.toLowerCase().includes(q) ||
        (l.contactName || "").toLowerCase().includes(q) ||
        (l.phone || "").includes(q) ||
        (l.email || "").toLowerCase().includes(q)
      );
    }
    return leads;
  }, [data.leads, filterStatus, filterTopic, searchQuery]);

  const reportingStats = useMemo(() => {
    const reports = data.reports || [];
    const total = reports.length;
    const appointments = reports.filter((r) => r.outcome === "Termin").length;
    const rejections = reports.filter((r) => r.outcome === "Absage").length;
    const callbacks = reports.filter((r) => r.outcome === "Wiedervorlage").length;
    const contactRate = total > 0 ? Math.round(((appointments + rejections + callbacks) / total) * 100) : 0;
    const appointmentRate = (appointments + rejections + callbacks) > 0 ? Math.round((appointments / (appointments + rejections + callbacks)) * 100) : 0;

    return { total, appointments, rejections, callbacks, contactRate, appointmentRate };
  }, [data.reports]);

  // API Functions
  const handleFileImport = useCallback(async () => {
    if (!importFile || !importListName.trim()) return;
    setBusy(true);
    try {
      const formData = new FormData();
      formData.append("file", importFile);
      formData.append("listName", importListName);
      if (importTopic) formData.append("topic", importTopic);

      const res = await fetch("/api/campaigns/import", {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      if (!res.ok) throw new Error("Import fehlgeschlagen");
      
      const result = await res.json();
      setNotice(`✓ ${result.imported || 0} Kontakte importiert`);
      setImportFile(null);
      setImportListName("");
      
      // Reload data
      const dataRes = await fetch("/api/live", { credentials: "include" });
      if (dataRes.ok) setData(await dataRes.json());
    } catch (error) {
      setNotice(`✗ Import-Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [importFile, importListName, importTopic]);

  const handleSaveNote = useCallback(async (leadId: string, note: string) => {
    if (!selectedLead) return;
    setBusy(true);
    try {
      // In real implementation, would save to database
      const updatedLeads = data.leads.map(l => 
        l.id === leadId ? { ...l, note } : l
      );
      setData({ ...data, leads: updatedLeads });
      setSelectedLead({ ...selectedLead, note });
      setNotice("✓ Notiz gespeichert");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [data.leads, selectedLead]);

  const controlCampaignList = useCallback(async (listId: string, action: "start" | "stop" | "delete") => {
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/run-active", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, listId }),
      });

      if (!res.ok) throw new Error("Aktion fehlgeschlagen");
      
      const result = await res.json();
      setNotice(`✓ Kampagne ${action === "start" ? "gestartet" : action === "stop" ? "gestoppt" : "gelöscht"}`);
      
      // Reload data
      const dataRes = await fetch("/api/live", { credentials: "include" });
      if (dataRes.ok) setData(await dataRes.json());
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, []);

  // Initialization & Polling
  useEffect(() => {
    let cancelled = false;
    let pollInterval: NodeJS.Timeout;

    const load = async () => {
      try {
        const [dataRes, userRes] = await Promise.all([
          fetch("/api/live", { credentials: "include" }),
          fetch("/api/auth/me", { credentials: "include" }),
        ]);

        if (dataRes.ok && !cancelled) {
          const d = await dataRes.json();
          setData(d || EMPTY_DATA);
          
          // Extract campaign lists from data
          const lists: CampaignListSummary[] = [];
          const processed = new Set<string>();
          for (const lead of (d.leads || [])) {
            const listId = lead.listId || "legacy";
            if (!processed.has(listId)) {
              const leadsInList = (d.leads || []).filter((l: DashboardData["leads"][number]) => (l.listId || "legacy") === listId);
              lists.push({
                listId,
                listName: listId === "legacy" ? "Importierte Kontakte" : listId,
                active: false,
                total: leadsInList.length,
                pending: leadsInList.filter((l: DashboardData["leads"][number]) => !l.status || l.status === "neu").length,
                called: leadsInList.filter((l: DashboardData["leads"][number]) => l.attempts && l.attempts > 0).length,
                appointments: leadsInList.filter((l: DashboardData["leads"][number]) => l.status === "termin").length,
                callbacks: leadsInList.filter((l: DashboardData["leads"][number]) => l.status === "wiedervorlage").length,
                rejections: leadsInList.filter((l: DashboardData["leads"][number]) => l.status === "absage").length,
              });
              processed.add(listId);
            }
          }
          setCampaignLists(lists);
        }

        if (userRes.ok && !cancelled) {
          const u = await userRes.json();
          setCurrentUser(u || null);
        }

        if (!cancelled) {
          setNotice("");
          setLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setNotice(`Fehler beim Laden: ${error instanceof Error ? error.message : "Unbekannt"}`);
          setLoading(false);
        }
      }
    };

    load();

    // Poll every 10 seconds for updates
    pollInterval = setInterval(() => {
      if (!cancelled && activeView !== "settings") {
        fetch("/api/live", { credentials: "include" })
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d && !cancelled) setData(d); })
          .catch(() => {});
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, [activeView]);

  // ========================================================================
  // RENDER FUNCTIONS
  // ========================================================================

  function renderDashboard() {
    return (
      <div className="dashboard-view">
        <section className="kpi-grid">
          <article className="kpi-card primary">
            <div className="kpi-label">Heute termine</div>
            <div className="kpi-value">
              {(data.reports || []).filter((r) => {
                if (r.outcome !== "Termin" || !r.appointmentAt) return false;
                const d = new Date(r.appointmentAt);
                const today = new Date();
                return d.toDateString() === today.toDateString();
              }).length}
            </div>
            <div className="kpi-sub">Termine gesamt: {reportingStats.appointments}</div>
          </article>

          <article className="kpi-card">
            <div className="kpi-label">Offene Leads</div>
            <div className="kpi-value">{filteredLeads.length}</div>
            <div className="kpi-sub">Wartet auf Kontakt</div>
          </article>

          <article className="kpi-card">
            <div className="kpi-label">Wiedervorlagen</div>
            <div className="kpi-value">{reportingStats.callbacks}</div>
            <div className="kpi-sub">Follow-ups ausstehend</div>
          </article>

          <article className="kpi-card">
            <div className="kpi-label">Conversion Rate</div>
            <div className="kpi-value">{reportingStats.appointmentRate}%</div>
            <div className="kpi-sub">Termin je Kontakt</div>
          </article>
        </section>

        <section className="stats-section">
          <h3>Kennzahlen</h3>
          <div className="stats-grid">
            <div className="stat"><span>Reports</span><strong>{reportingStats.total}</strong></div>
            <div className="stat"><span>Termine</span><strong>{reportingStats.appointments}</strong></div>
            <div className="stat"><span>Wiedervorlagen</span><strong>{reportingStats.callbacks}</strong></div>
            <div className="stat"><span>Absagen</span><strong>{reportingStats.rejections}</strong></div>
            <div className="stat"><span>Kontaktrate</span><strong>{reportingStats.contactRate}%</strong></div>
          </div>
        </section>
      </div>
    );
  }

  function renderContacts() {
    return (
      <div className="contacts-view">
        <div className="view-header">
          <div className="search-filters">
            <input
              type="text"
              placeholder="Firma, Kontakt, Tel, Email suchen..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="search-input"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="filter-select"
            >
              <option value="">Alle Status</option>
              <option value="neu">Neu</option>
              <option value="angerufen">Angerufen</option>
              <option value="termin">Termin</option>
              <option value="absage">Absage</option>
              <option value="wiedervorlage">Wiedervorlage</option>
            </select>
            <select
              value={filterTopic}
              onChange={(e) => setFilterTopic(e.target.value)}
              className="filter-select"
            >
              <option value="">Alle Themen</option>
              {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div className="contacts-list">
          {filteredLeads.length === 0 ? (
            <div className="empty-state">
              <p>Keine Kontakte gefunden</p>
            </div>
          ) : (
            <table className="contacts-table">
              <thead>
                <tr>
                  <th>Firma</th>
                  <th>Kontakt</th>
                  <th>Telefon</th>
                  <th>Email</th>
                  <th>Thema</th>
                  <th>Status</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead) => {
                  const status = leadAmpelById.get(lead.id);
                  return (
                    <tr key={lead.id} className="lead-row">
                      <td><strong>{lead.company}</strong></td>
                      <td>{lead.contactName || "-"}</td>
                      <td>{lead.phone || lead.directDial || "-"}</td>
                      <td>{lead.email || "-"}</td>
                      <td>{lead.topic}</td>
                      <td>
                        <span className={`status-badge ${status?.color}`}>
                          {status?.label}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn-small"
                          onClick={() => setSelectedLead(lead)}
                        >
                          Details
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {selectedLead && (
          <div className="contact-detail-panel">
            <div className="detail-header">
              <h3>{selectedLead.company}</h3>
              <button onClick={() => setSelectedLead(null)}>✕</button>
            </div>
            <div className="detail-body">
              <div className="detail-section">
                <h4>Kontaktinformationen</h4>
                <div className="detail-grid">
                  <div><label>Ansprechpartner</label><p>{selectedLead.contactName || "-"}</p></div>
                  <div><label>Telefon</label><p>{selectedLead.phone || selectedLead.directDial || "-"}</p></div>
                  <div><label>Email</label><p>{selectedLead.email || "-"}</p></div>
                  <div><label>Ort</label><p>{selectedLead.location || "-"}</p></div>
                  <div><label>Thema</label><p>{selectedLead.topic}</p></div>
                  <div><label>Status</label><p>{leadAmpelById.get(selectedLead.id)?.label}</p></div>
                </div>
              </div>

              <div className="detail-section">
                <h4>Interaktionshistorie</h4>
                <div className="activity-timeline">
                  {((data.reports || []).filter((r) => reportMatchesLead(r, selectedLead)) || [])
                    .sort((a, b) => Date.parse(b.conversationDate || "0") - Date.parse(a.conversationDate || "0"))
                    .map((report) => (
                      <div key={report.id} className="activity-item">
                        <div className="activity-date">{formatDate(report.conversationDate)}</div>
                        <div className="activity-content">
                          <div className="activity-outcome">{formatOutcomeLabel(report.outcome)}</div>
                          <div className="activity-summary">{report.summary || "(Keine Notiz)"}</div>
                          {report.appointmentAt && (
                            <div className="activity-appointment">
                              📅 Termin: {formatDate(report.appointmentAt)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              <div className="detail-section">
                <h4>Notizen & Follow-up</h4>
                <textarea
                  placeholder="Notiz hinzufügen..."
                  className="notes-input"
                  defaultValue={selectedLead.note || ""}
                />
                <button className="btn">Speichern</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderCalendar() {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
    const start = new Date(firstOfMonth);
    start.setDate(firstOfMonth.getDate() - firstWeekday);

    const days = Array.from({ length: 42 }).map((_, i) => {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      return {
        date,
        key: toDateKey(date),
        inMonth: date.getMonth() === calendarMonth.getMonth(),
        appointments: appointmentsByDay.get(toDateKey(date)) || [],
      };
    });

    return (
      <div className="calendar-view">
        <div className="calendar-header">
          <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}>←</button>
          <h3>{calendarMonth.toLocaleDateString("de-DE", { month: "long", year: "numeric" })}</h3>
          <button onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}>→</button>
        </div>

        <div className="calendar-weekdays">
          {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((day) => (
            <div key={day} className="weekday">{day}</div>
          ))}
        </div>

        <div className="calendar-grid">
          {days.map((day) => (
            <div
              key={day.key}
              className={`calendar-day ${!day.inMonth ? "other-month" : ""} ${day.appointments.length > 0 ? "has-appointments" : ""}`}
              onClick={() => setSelectedDayKey(day.key)}
            >
              <div className="day-number">{day.date.getDate()}</div>
              {day.appointments.length > 0 && (
                <div className="day-appointments">
                  {day.appointments.slice(0, 2).map((apt, i) => (
                    <div key={i} className="apt-badge">{apt.company?.slice(0, 3)}</div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="calendar-detail">
          <h4>Termine für {new Date(selectedDayKey).toLocaleDateString("de-DE")}</h4>
          {(appointmentsByDay.get(selectedDayKey) || []).map((apt) => (
            <div key={apt.id} className="appointment-item">
              <div><strong>{apt.company}</strong></div>
              <div>{apt.contactName}</div>
              <div className="subtle">{formatDate(apt.appointmentAt)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderTasks() {
    const callbacks = (data.reports || [])
      .filter((r) => r.outcome === "Wiedervorlage" && r.nextCallAt)
      .sort((a, b) => Date.parse(a.nextCallAt || "0") - Date.parse(b.nextCallAt || "0"));

    return (
      <div className="tasks-view">
        <h3>Follow-ups & Wiedervorlagen</h3>
        {callbacks.length === 0 ? (
          <p className="subtle">Keine ausstehenden Follow-ups</p>
        ) : (
          <div className="tasks-list">
            {callbacks.map((task) => (
              <div key={task.id} className="task-card">
                <div className="task-date">{formatDate(task.nextCallAt)}</div>
                <div className="task-content">
                  <strong>{task.company}</strong>
                  <div className="subtle">{task.contactName}</div>
                  <div className="task-summary">{task.summary}</div>
                </div>
                <div className="task-actions">
                  <button className="btn-small">Fertig</button>
                  <button className="btn-small ghost">Verschieben</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="settings-view">
        <section>
          <h3>Kampagnen & Datenimport</h3>
          <div className="settings-panel">
            <h4>CSV/Excel importieren</h4>
            <input
              type="text"
              placeholder="Listenname"
              value={importListName}
              onChange={(e) => setImportListName(e.target.value)}
              className="input"
            />
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setImportFile(e.target.files?.[0] || null)}
              className="input"
            />
            <button className="btn" disabled={!importFile || !importListName}>
              Importieren
            </button>
          </div>

          {campaignLists.length > 0 && (
            <div className="settings-panel">
              <h4>Aktive Kampagnen</h4>
              <div className="campaign-list">
                {campaignLists.map((list) => (
                  <div key={list.listId} className="campaign-item">
                    <div>
                      <strong>{list.listName}</strong>
                      <div className="subtle">
                        {list.pending} offen | {list.appointments} Termine | {list.rejections} Absagen
                      </div>
                    </div>
                    <div className="campaign-controls">
                      <button className="btn-small" disabled={list.active}>Start</button>
                      <button className="btn-small ghost" disabled={!list.active}>Stop</button>
                      <button className="btn-small danger">Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    );
  }

  // ========================================================================
  // RENDER
  // ========================================================================

  if (loading) {
    return (
      <div className="app-container loading">
        <div className="loading-spinner">
          <p>{notice}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-left">
          <h1>Gloria CRM</h1>
        </div>
        <div className="header-right">
          <span className="user-name">{currentUser?.realName}</span>
        </div>
      </header>

      <nav className="app-nav">
        <button
          className={`nav-btn ${activeView === "dashboard" ? "active" : ""}`}
          onClick={() => setActiveView("dashboard")}
        >
          📊 Dashboard
        </button>
        <button
          className={`nav-btn ${activeView === "contacts" ? "active" : ""}`}
          onClick={() => setActiveView("contacts")}
        >
          👥 Kontakte ({filteredLeads.length})
        </button>
        <button
          className={`nav-btn ${activeView === "calendar" ? "active" : ""}`}
          onClick={() => setActiveView("calendar")}
        >
          📅 Termine
        </button>
        <button
          className={`nav-btn ${activeView === "tasks" ? "active" : ""}`}
          onClick={() => setActiveView("tasks")}
        >
          ✓ Follow-ups
        </button>
        <button
          className={`nav-btn ${activeView === "settings" ? "active" : ""}`}
          onClick={() => setActiveView("settings")}
        >
          ⚙ Einstellungen
        </button>
      </nav>

      <main className="app-main">
        {activeView === "dashboard" && renderDashboard()}
        {activeView === "contacts" && renderContacts()}
        {activeView === "calendar" && renderCalendar()}
        {activeView === "tasks" && renderTasks()}
        {activeView === "settings" && renderSettings()}
      </main>

      <style jsx>{`
        .app-container {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #f5f7fa;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .loading {
          align-items: center;
          justify-content: center;
        }

        .loading-spinner {
          text-align: center;
        }

        .app-header {
          background: white;
          border-bottom: 1px solid #e0e4e8;
          padding: 1rem 2rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }

        .app-header h1 {
          margin: 0;
          font-size: 1.5rem;
          color: #1f2937;
        }

        .user-name {
          color: #6b7280;
          font-size: 0.9rem;
        }

        .app-nav {
          background: white;
          border-bottom: 1px solid #e0e4e8;
          display: flex;
          gap: 0.5rem;
          padding: 0 2rem;
          overflow-x: auto;
        }

        .nav-btn {
          padding: 1rem 1.5rem;
          border: none;
          background: none;
          cursor: pointer;
          color: #6b7280;
          font-weight: 500;
          border-bottom: 3px solid transparent;
          white-space: nowrap;
          transition: all 0.2s;
        }

        .nav-btn:hover {
          color: #1f2937;
          background: #f3f4f6;
        }

        .nav-btn.active {
          color: #2563eb;
          border-bottom-color: #2563eb;
        }

        .app-main {
          flex: 1;
          overflow-y: auto;
          padding: 2rem;
        }

        /* KPI Grid */
        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .kpi-card {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .kpi-card.primary {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: white;
        }

        .kpi-label {
          font-size: 0.85rem;
          color: #6b7280;
          margin-bottom: 0.5rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .kpi-card.primary .kpi-label {
          color: rgba(255,255,255,0.8);
        }

        .kpi-value {
          font-size: 2.5rem;
          font-weight: bold;
          margin-bottom: 0.5rem;
        }

        .kpi-sub {
          font-size: 0.85rem;
          color: #9ca3af;
        }

        .kpi-card.primary .kpi-sub {
          color: rgba(255,255,255,0.7);
        }

        /* Contacts View */
        .contacts-view {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .view-header {
          background: white;
          padding: 1.5rem;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .search-filters {
          display: flex;
          gap: 1rem;
          flex-wrap: wrap;
        }

        .search-input,
        .filter-select,
        .input {
          padding: 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          font-size: 0.9rem;
        }

        .search-input {
          flex: 1;
          min-width: 200px;
        }

        .filter-select {
          min-width: 150px;
        }

        .contacts-table {
          width: 100%;
          background: white;
          border-collapse: collapse;
          border-radius: 8px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .contacts-table thead {
          background: #f9fafb;
          border-bottom: 1px solid #e0e4e8;
        }

        .contacts-table th {
          padding: 1rem;
          text-align: left;
          font-weight: 600;
          color: #6b7280;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .contacts-table td {
          padding: 1rem;
          border-bottom: 1px solid #f0f0f0;
        }

        .contacts-table tr:hover {
          background: #f9fafb;
        }

        .status-badge {
          display: inline-block;
          padding: 0.35rem 0.75rem;
          border-radius: 999px;
          font-size: 0.8rem;
          font-weight: 600;
        }

        .status-badge.success {
          background: #d1fae5;
          color: #065f46;
        }

        .status-badge.danger {
          background: #fee2e2;
          color: #7f1d1d;
        }

        .status-badge.warning {
          background: #fef3c7;
          color: #78350f;
        }

        .status-badge.info {
          background: #dbeafe;
          color: #1e40af;
        }

        .status-badge.neutral {
          background: #f3f4f6;
          color: #4b5563;
        }

        .btn-small {
          padding: 0.5rem 1rem;
          background: #2563eb;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 500;
          transition: background 0.2s;
        }

        .btn-small:hover {
          background: #1d4ed8;
        }

        .btn-small.ghost {
          background: #e5e7eb;
          color: #1f2937;
        }

        .btn-small.ghost:hover {
          background: #d1d5db;
        }

        .btn-small.danger {
          background: #dc2626;
        }

        .btn-small.danger:hover {
          background: #b91c1c;
        }

        /* Contact Detail Panel */
        .contact-detail-panel {
          position: fixed;
          right: 0;
          top: 0;
          height: 100vh;
          width: 400px;
          background: white;
          box-shadow: -4px 0 12px rgba(0,0,0,0.15);
          overflow-y: auto;
          z-index: 100;
        }

        .detail-header {
          padding: 1.5rem;
          border-bottom: 1px solid #e0e4e8;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .detail-header h3 {
          margin: 0;
          font-size: 1.25rem;
        }

        .detail-header button {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #9ca3af;
        }

        .detail-body {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .detail-section h4 {
          margin: 0 0 1rem 0;
          color: #1f2937;
          font-size: 0.95rem;
        }

        .detail-grid {
          display: grid;
          gap: 1rem;
        }

        .detail-grid > div {
          display: flex;
          flex-direction: column;
        }

        .detail-grid label {
          font-size: 0.8rem;
          color: #9ca3af;
          text-transform: uppercase;
          margin-bottom: 0.25rem;
          letter-spacing: 0.5px;
        }

        .detail-grid p {
          margin: 0;
          color: #1f2937;
        }

        .activity-timeline {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .activity-item {
          border-left: 2px solid #e0e4e8;
          padding-left: 1rem;
        }

        .activity-date {
          font-size: 0.8rem;
          color: #9ca3af;
          margin-bottom: 0.25rem;
        }

        .activity-outcome {
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 0.25rem;
        }

        .activity-summary {
          font-size: 0.9rem;
          color: #6b7280;
          margin-bottom: 0.25rem;
        }

        .activity-appointment {
          font-size: 0.85rem;
          color: #2563eb;
          margin-top: 0.5rem;
        }

        .notes-input {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          min-height: 100px;
          font-family: inherit;
          font-size: 0.9rem;
          resize: vertical;
        }

        .btn {
          padding: 0.75rem 1.5rem;
          background: #2563eb;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          transition: background 0.2s;
        }

        .btn:hover {
          background: #1d4ed8;
        }

        .btn:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }

        /* Calendar */
        .calendar-view {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
        }

        .calendar-header button {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #6b7280;
          padding: 0.5rem;
        }

        .calendar-header h3 {
          margin: 0;
          text-transform: capitalize;
        }

        .calendar-weekdays {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.5rem;
          margin-bottom: 1rem;
        }

        .weekday {
          text-align: center;
          font-weight: 600;
          color: #6b7280;
          padding: 0.75rem 0;
          font-size: 0.85rem;
        }

        .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.5rem;
          margin-bottom: 2rem;
        }

        .calendar-day {
          aspect-ratio: 1;
          background: #f9fafb;
          border: 1px solid #e0e4e8;
          border-radius: 6px;
          padding: 0.5rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .calendar-day:hover {
          background: #f3f4f6;
          border-color: #2563eb;
        }

        .calendar-day.other-month {
          background: #fafbfc;
          color: #d1d5db;
        }

        .calendar-day.has-appointments {
          border-color: #2563eb;
          background: #eff6ff;
        }

        .day-number {
          font-weight: 600;
          margin-bottom: 0.25rem;
        }

        .day-appointments {
          display: flex;
          gap: 0.25rem;
          flex-wrap: wrap;
        }

        .apt-badge {
          font-size: 0.65rem;
          background: #2563eb;
          color: white;
          padding: 0.1rem 0.35rem;
          border-radius: 3px;
        }

        .calendar-detail {
          background: #f9fafb;
          padding: 1rem;
          border-radius: 6px;
        }

        .calendar-detail h4 {
          margin: 0 0 1rem 0;
        }

        .appointment-item {
          background: white;
          padding: 1rem;
          border-radius: 6px;
          margin-bottom: 0.75rem;
          border-left: 3px solid #2563eb;
        }

        .appointment-item div {
          margin-bottom: 0.25rem;
        }

        /* Tasks */
        .tasks-view {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .tasks-view h3 {
          margin-top: 0;
        }

        .tasks-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .task-card {
          background: #f9fafb;
          border: 1px solid #e0e4e8;
          border-radius: 6px;
          padding: 1rem;
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 1rem;
          align-items: start;
        }

        .task-date {
          font-weight: 600;
          color: #2563eb;
          min-width: 100px;
        }

        .task-content {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .task-summary {
          font-size: 0.9rem;
          color: #6b7280;
          margin-top: 0.5rem;
        }

        .task-actions {
          display: flex;
          gap: 0.5rem;
        }

        /* Settings */
        .settings-view {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .settings-panel {
          background: white;
          padding: 1.5rem;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .settings-panel h4 {
          margin-top: 0;
        }

        .settings-panel input,
        .settings-panel select {
          width: 100%;
          margin-bottom: 1rem;
        }

        .campaign-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .campaign-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem;
          background: #f9fafb;
          border-radius: 6px;
          border-left: 3px solid #2563eb;
        }

        .campaign-controls {
          display: flex;
          gap: 0.5rem;
        }

        .subtle {
          color: #9ca3af;
          font-size: 0.9rem;
        }

        .empty-state {
          text-align: center;
          padding: 3rem;
          color: #9ca3af;
        }

        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 1rem;
        }

        .stat {
          background: white;
          padding: 1rem;
          border-radius: 6px;
          text-align: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .stat span {
          display: block;
          color: #6b7280;
          font-size: 0.85rem;
          margin-bottom: 0.5rem;
        }

        .stat strong {
          display: block;
          font-size: 1.75rem;
          color: #2563eb;
        }
      `}</style>
    </div>
  );
}
