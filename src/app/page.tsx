"use client";

import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import type { DashboardData, LearningResponse, PlaybookConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";

const SAMPLE_CSV = `company,contactName,phone,email,topic,note,nextCallAt
Musterbau GmbH,Herr Neumann,+49 2339 555100,neumann@musterbau.de,betriebliche Krankenversicherung,120 Mitarbeitende; Recruiting Thema,
Sprockhoevel Energieberatung,Frau Peters,+49 2324 555200,peters@se-beratung.de,Energie,Vertragsverlängerung in 90 Tagen,2026-04-15T10:00:00.000Z`;

const EMPTY_DATA: DashboardData = {
  leads: [],
  reports: [],
  playbooks: [],
  reportStorageMode: "file",
  playbooksStorageMode: "file",
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

const EMPTY_LEARNING: LearningResponse = {
  insights: [],
  globalSummary: [],
};

function formatDate(value?: string) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toDateKey(value: Date) {
  // Lokales Datum (nicht UTC), damit Kalenderzellen und Termine auf demselben
  // Tag landen. toISOString() würde 2026-05-13T22:00:00 lokal als 2026-05-13
  // (UTC) speichern, aber die Kalenderzelle für den 14.05 lokal hat als Key
  // den UTC-13.05 -> Termin würde einen Tag zu spät erscheinen.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function speakText(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "de-DE";

  const germanVoice = window.speechSynthesis
    .getVoices()
    .find((voice) => voice.lang.toLowerCase().startsWith("de"));

  if (germanVoice) {
    utterance.voice = germanVoice;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function buildConversationLines(summary: string) {
  return summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Gloria:") || l.startsWith("Interessent:"))
    .map((l) => {
      const isGloria = l.startsWith("Gloria:");
      return { speaker: isGloria ? "Gloria" : "Interessent", text: l.replace(/^Gloria:|^Interessent:/, "").trim() };
    });
}

function detectLostStage(summary: string): string {
  const t = summary.toLowerCase();
  if (t.includes("appt_slot_iso") || t.includes("appt_slot_label")) {
    return "Terminbestätigung – Interessent hat nach Terminvorschlag abgesagt";
  }
  if (t.includes("prep_mode") || t.includes("prep_short") || t.includes("wann passt")) {
    return "Terminvereinbarung – Abbruch beim Erfassen der Termindaten";
  }
  if (t.includes("problem_confirm_pending") || t.includes("stellen sie sich vor")) {
    return "Nutzenargumentation – Interessent hat Mehrwert nicht gesehen";
  }
  if (t.includes("discovery") || t.includes("wie zufrieden") || t.includes("was wäre für sie")) {
    return "Bedarfsermittlung – kein Interesse nach Bedarfsabfrage";
  }
  if (t.includes("aufzeichnung") || t.includes("consent")) {
    return "Einwilligung – Gespräch nach Aufnahme-Abfrage abgebrochen";
  }
  return "Gesprächseinstieg – Entscheider nicht oder kaum erreicht";
}

function pickText(value: string | undefined, fallback?: string) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return fallback ?? "";
}

function CollapsiblePanel({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  void defaultOpen;
  return (
    <section className="panel static-panel">
      <header className="panel-summary">
        <h2>{title}</h2>
      </header>
      <div className="panel-content">{children}</div>
    </section>
  );
}

interface LiveSessionRow {
  callSid?: string;
  company: string;
  topic: string;
  startedAt: string;
  lastEventAt: string;
  lastStep: string;
  lastEventType: string;
  contactRole?: "gatekeeper" | "decision-maker";
  turns: number;
  status: "aktiv" | "beendet";
  events: Array<{
    eventType: string;
    step: string;
    text?: string;
    createdAt: string;
    contactRole?: "gatekeeper" | "decision-maker";
    turn?: number;
  }>;
}

function LiveMonitorPanel() {
  const [sessions, setSessions] = useState<LiveSessionRow[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/live?minutes=15", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as {
          sessions: LiveSessionRow[];
          activeCount: number;
          now: string;
        };
        if (cancelled) return;
        setSessions(payload.sessions || []);
        setActiveCount(payload.activeCount || 0);
        setLastUpdated(payload.now);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Fehler beim Laden");
      }
    }
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <CollapsiblePanel title="Live-Monitor" defaultOpen={false}>
      <div className="row" style={{ gap: 12, marginBottom: 10 }}>
        <span className="pill" style={{ background: activeCount > 0 ? "rgba(47,143,87,0.18)" : undefined }}>
          {activeCount} aktive Gespraech{activeCount === 1 ? "" : "e"}
        </span>
        <span className="subtle" style={{ fontSize: "0.85rem" }}>
          Fenster: letzte 15 Min - Auto-Refresh 5 s
          {lastUpdated ? ` - Stand: ${new Date(lastUpdated).toLocaleTimeString("de-DE")}` : ""}
        </span>
        {error && <span className="subtle" style={{ color: "#c24d4d", fontSize: "0.85rem" }}>- {error}</span>}
      </div>
      {sessions.length === 0 ? (
        <p className="subtle">Keine Gespraeche im aktuellen Zeitfenster.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Firma</th>
                <th>Thema</th>
                <th>Rolle</th>
                <th>Schritt</th>
                <th>Letztes Event</th>
                <th>Turns</th>
                <th>Aktualisiert</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const key = s.callSid || `${s.company}-${s.startedAt}`;
                const isOpen = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>
                        <span className={`status ${s.status === "beendet" ? "absage" : ""}`}>{s.status}</span>
                      </td>
                      <td><strong>{s.company}</strong></td>
                      <td>{s.topic}</td>
                      <td>{s.contactRole || "-"}</td>
                      <td>{s.lastStep}</td>
                      <td><code>{s.lastEventType}</code></td>
                      <td>{s.turns}</td>
                      <td>{new Date(s.lastEventAt).toLocaleTimeString("de-DE")}</td>
                      <td>
                        <button className="btn ghost" onClick={() => setExpanded(isOpen ? null : key)}>
                          {isOpen ? "Zuklappen" : "Verlauf"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={9}>
                          <div style={{ maxHeight: 220, overflowY: "auto", padding: "8px 4px", background: "#f5f8fd", borderRadius: 6 }}>
                            {s.events.slice().reverse().map((e, idx) => (
                              <div key={idx} style={{ display: "grid", gridTemplateColumns: "90px 150px 140px 1fr", gap: 8, padding: "3px 0", fontSize: "0.85rem" }}>
                                <span className="subtle">{new Date(e.createdAt).toLocaleTimeString("de-DE")}</span>
                                <span><code>{e.eventType}</code></span>
                                <span>{e.step}</span>
                                <span>{e.text ? e.text.slice(0, 180) : ""}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsiblePanel>
  );
}

export default function HomePage() {
  type SessionUser = {
    id: string;
    username: string;
    role: "master" | "user";
    realName: string;
    companyName: string;
    calendarFeedToken?: string;
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
    phoneNumbers?: ManagedPhoneNumber[];
  };

  type ManagedPhoneNumber = {
    id: string;
    userId: string;
    phoneNumber: string;
    label: string;
    active: boolean;
  };

  type CampaignListSummary = {
    listId: string;
    listName: string;
    active: boolean;
    total: number;
    pending: number;
    called: number;
    appointments: number;
    callbacks: number;
    rejections: number;
  };

  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importListName, setImportListName] = useState("");
  const [detailTopic, setDetailTopic] = useState<Topic>(TOPICS[0]);
  const [voiceTopic, setVoiceTopic] = useState<Topic>(TOPICS[0]);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceAudioUrl, setVoiceAudioUrl] = useState("");
  const [learning, setLearning] = useState<LearningResponse>(EMPTY_LEARNING);
  const [twilioTarget, setTwilioTarget] = useState("");
  const [twilioCompany, setTwilioCompany] = useState("Musterbau GmbH");
  const [twilioContactName, setTwilioContactName] = useState("Herr Neumann");
  const [twilioTopic, setTwilioTopic] = useState<Topic>(TOPICS[0]);
  const [twilioFromOptions, setTwilioFromOptions] = useState<Array<{ id?: string; number: string; label: string }>>([]);
  const [twilioFrom, setTwilioFrom] = useState("");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [managedPhoneNumbers, setManagedPhoneNumbers] = useState<ManagedPhoneNumber[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRealName, setNewRealName] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRealPhone, setNewRealPhone] = useState("");
  const [newGesellschaft, setNewGesellschaft] = useState("");
  const [newRole, setNewRole] = useState<"master" | "user">("user");
  const [newPhoneUserId, setNewPhoneUserId] = useState("");
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newPhoneLabel, setNewPhoneLabel] = useState("");
  void newPhoneUserId; void setNewPhoneUserId; void newPhoneNumber; void setNewPhoneNumber; void newPhoneLabel; void setNewPhoneLabel;
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    username: string;
    realName: string;
    companyName: string;
    address: string;
    email: string;
    realPhone: string;
    gesellschaft: string;
    role: "master" | "user";
    password: string;
    assignedPhone: string;
    assignedLabel: string;
  } | null>(null);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftScripts, setDraftScripts] = useState<Record<string, PlaybookConfig>>({});
  const [selectedReport, setSelectedReport] = useState<DashboardData["reports"][number] | null>(null);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  void settingsOpen; void setSettingsOpen;
  const [activeView, setActiveView] = useState<"overview" | "calls" | "leads" | "calendar" | "settings" | "compliance">("overview");
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));
  const [campaignLists, setCampaignLists] = useState<CampaignListSummary[]>([]);

  const activeDraft = draftScripts[detailTopic];
  const reportRows = useMemo(() => data.reports, [data.reports]);
  const appointmentReports = useMemo(
    () =>
      data.reports.filter(
        (report) =>
          Boolean(report.appointmentAt) &&
          // Kalender immer nur eigene Termine, auch fuer Master.
          (!currentUser || !report.userId || report.userId === currentUser.id),
      ),
    [data.reports, currentUser],
  );
  const appointmentsByDay = useMemo(() => {
    const grouped = new Map<string, DashboardData["reports"]>();

    for (const report of appointmentReports) {
      if (!report.appointmentAt) {
        continue;
      }

      const dayKey = toDateKey(new Date(report.appointmentAt));
      const existing = grouped.get(dayKey) || [];
      grouped.set(dayKey, [...existing, report]);
    }

    for (const [key, reports] of grouped) {
      grouped.set(
        key,
        [...reports].sort((a, b) => {
          const aTime = a.appointmentAt ? Date.parse(a.appointmentAt) : 0;
          const bTime = b.appointmentAt ? Date.parse(b.appointmentAt) : 0;
          return aTime - bTime;
        }),
      );
    }

    return grouped;
  }, [appointmentReports]);

  const reportingInsights = useMemo(() => {
    const reports = data.reports;
    const total = reports.length;
    const appointments = reports.filter((r) => r.outcome === "Termin").length;
    const rejections = reports.filter((r) => r.outcome === "Absage").length;
    const callbacks = reports.filter((r) => r.outcome === "Wiedervorlage").length;
    const noContact = reports.filter((r) => r.outcome === "Kein Kontakt").length;
    const contacts = total - noContact;
    const contactRate = total > 0 ? Math.round((contacts / total) * 100) : 0;
    const appointmentRate = contacts > 0 ? Math.round((appointments / contacts) * 100) : 0;
    const rejectionRate = contacts > 0 ? Math.round((rejections / contacts) * 100) : 0;

    const byTopic = new Map<string, { total: number; termin: number; absage: number; wiedervorlage: number; keinKontakt: number }>();
    for (const r of reports) {
      const entry = byTopic.get(r.topic) || { total: 0, termin: 0, absage: 0, wiedervorlage: 0, keinKontakt: 0 };
      entry.total++;
      if (r.outcome === "Termin") entry.termin++;
      else if (r.outcome === "Absage") entry.absage++;
      else if (r.outcome === "Wiedervorlage") entry.wiedervorlage++;
      else if (r.outcome === "Kein Kontakt") entry.keinKontakt++;
      byTopic.set(r.topic, entry);
    }
    const topicStats = Array.from(byTopic.entries())
      .map(([topic, stats]) => ({
        topic,
        ...stats,
        terminRate: stats.total > 0 ? Math.round((stats.termin / stats.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    const reasonBuckets: Array<{ label: string; match: RegExp }> = [
      { label: "Kein Interesse", match: /kein\s*interesse|nicht\s*interessiert/i },
      { label: "Bereits versorgt / anderer Anbieter", match: /bereits|schon\s*versichert|vorhanden|anderer\s*anbieter|haben\s*schon/i },
      { label: "Keine Zeit / spaeter", match: /keine\s*zeit|zu\s*besch(ae|ä)ftigt|sp(ae|ä)ter|momentan\s*nicht/i },
      { label: "Kein Budget / zu teuer", match: /kein\s*budget|zu\s*teuer|kosten\s*zu\s*hoch/i },
      { label: "Keine Werbeanrufe", match: /werbung|werbeanruf|nicht\s*anrufen|keine\s*anrufe/i },
      { label: "Falscher Ansprechpartner", match: /falsch|nicht\s*zust(ae|ä)ndig|nicht\s*der\s*richtige/i },
      { label: "Entscheidung bereits gefallen", match: /entscheidung\s*gefallen|entschieden|festgelegt/i },
    ];
    const reasonCounts = reasonBuckets.map((b) => ({ label: b.label, count: 0 }));
    let reasonOther = 0;
    for (const r of reports.filter((x) => x.outcome === "Absage")) {
      const s = r.summary || "";
      let matched = false;
      reasonBuckets.forEach((b, i) => {
        if (b.match.test(s)) {
          reasonCounts[i].count++;
          matched = true;
        }
      });
      if (!matched) reasonOther++;
    }
    const topRejections = [...reasonCounts, { label: "Sonstige / Unspezifisch", count: reasonOther }]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);

    const days: Array<{ key: string; label: string; gespraeche: number; termine: number; absagen: number }> = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      days.push({
        key: toDateKey(d),
        label: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
        gespraeche: 0,
        termine: 0,
        absagen: 0,
      });
    }
    const dayIndex = new Map(days.map((d, i) => [d.key, i] as const));
    for (const r of reports) {
      if (!r.conversationDate) continue;
      const key = toDateKey(new Date(r.conversationDate));
      const idx = dayIndex.get(key);
      if (idx === undefined) continue;
      days[idx].gespraeche++;
      if (r.outcome === "Termin") days[idx].termine++;
      else if (r.outcome === "Absage") days[idx].absagen++;
    }
    const peakDayGespraeche = Math.max(1, ...days.map((d) => d.gespraeche));

    return {
      total,
      contacts,
      appointments,
      rejections,
      callbacks,
      noContact,
      contactRate,
      appointmentRate,
      rejectionRate,
      topicStats,
      topRejections,
      days,
      peakDayGespraeche,
    };
  }, [data.reports]);

  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
    const start = new Date(firstOfMonth);
    start.setDate(firstOfMonth.getDate() - firstWeekday);

    return Array.from({ length: 42 }).map((_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = toDateKey(day);
      return {
        key,
        date: day,
        inMonth: day.getMonth() === calendarMonth.getMonth(),
        items: appointmentsByDay.get(key) || [],
      };
    });
  }, [appointmentsByDay, calendarMonth]);
  const selectedDayAppointments = useMemo(
    () => appointmentsByDay.get(selectedDayKey) || [],
    [appointmentsByDay, selectedDayKey],
  );

  async function loadDashboard() {
    const [dashboardResponse, learningResponse] = await Promise.all([
      fetch("/api/reports", { cache: "no-store" }),
      fetch("/api/learning", { cache: "no-store" }),
    ]);

    const payload = (await dashboardResponse.json()) as DashboardData;
    const learningPayload = (await learningResponse.json()) as LearningResponse;

    setData(payload);
    setLearning(learningPayload);
    const nextDrafts = payload.playbooks.reduce<Record<string, PlaybookConfig>>((acc, script) => {
      acc[script.topic] = {
        id: script.id,
        topic: script.topic,
        // Neues 3-Felder-Modell
        behavior: pickText(script.behavior, ""),
        requiredData: pickText(script.requiredData, ""),
        knowledge: pickText(script.knowledge, ""),
        objectionResponses: pickText(script.objectionResponses, ""),
        proofPoints: pickText(script.proofPoints, ""),
        opener: pickText(script.opener, ""),
        discovery: pickText(script.discovery, ""),
        objectionHandling: pickText(script.objectionHandling, ""),
        close: pickText(script.close, ""),
        aiKeyInfo: pickText(script.aiKeyInfo, ""),
        consentPrompt: pickText(
          script.consentPrompt,
          'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".',
        ),
        pkvHealthIntro: pickText(
          script.pkvHealthIntro,
          "Damit wir den Termin optimal vorbereiten koennen, muessen wir kurz ein paar Basisinformationen abklaeren.",
        ),
        pkvHealthQuestions: pickText(
          script.pkvHealthQuestions,
          [
            "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?",
            "Könnten Sie mir bitte Ihre Körpergröße und Ihr aktuelles Gewicht nennen?",
            "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
            "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
            "Gibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?",
            "Nehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?",
            "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
            "Gab es in den letzten zehn Jahren psychische Behandlungen?",
            "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
            "Bestehen bei Ihnen bekannte Allergien?",
          ].join("\n"),
        ),
        gatekeeperTask: pickText(
          script.gatekeeperTask,
          "Bitte freundlich um Weiterleitung zur zuständigen Führungskraft für dieses Thema.",
        ),
        gatekeeperBehavior: pickText(
          script.gatekeeperBehavior,
          "Erkläre kurz worum es geht wenn gefragt. Frage nach dem Namen der zuständigen Person. Bleib höflich aber bestimmt.",
        ),
        receptionTopicReason: pickText(script.receptionTopicReason, ""),
        decisionMakerTask: pickText(
          script.decisionMakerTask,
          "Vereinbare einen 15-minütigen, unverbindlichen Beratungstermin mit Herrn Matthias Duic.",
        ),
        decisionMakerBehavior: pickText(
          script.decisionMakerBehavior,
          "Nutze den Leitfaden, erkläre den Mehrwert klar und präzise, gehe auf Einwände ein und schlage konkrete Termine vor.",
        ),
        decisionMakerContext: pickText(script.decisionMakerContext, ""),
        problemBuildup: pickText(script.problemBuildup, ""),
        conceptTransition: pickText(script.conceptTransition, ""),
        appointmentConfirmation: pickText(script.appointmentConfirmation, ""),
        availableAppointmentSlots: pickText(script.availableAppointmentSlots, ""),
        appointmentGoal: pickText(
          script.appointmentGoal,
          "Ein konkreter Beratungstermin mit Herrn Matthias Duic ist vereinbart.",
        ),
      };
      return acc;
    }, {});

    // Keep the settings area available even if one topic has no persisted script yet.
    for (const topic of TOPICS) {
      if (!nextDrafts[topic]) {
        nextDrafts[topic] = {
          id: `playbook-${topic.toLowerCase().replace(/\s+/g, "-")}`,
          topic,
          behavior: "",
          requiredData: "",
          knowledge: "",
          objectionResponses: "",
          proofPoints: "",
          opener: "",
          discovery: "",
          objectionHandling: "",
          close: "",
          aiKeyInfo: "",
          consentPrompt: 'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".',
          pkvHealthIntro: "Damit wir den Termin optimal vorbereiten koennen, muessen wir kurz ein paar Basisinformationen abklaeren.",
          pkvHealthQuestions: [
            "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?",
            "Könnten Sie mir bitte Ihre Körpergröße und Ihr aktuelles Gewicht nennen?",
            "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
            "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
            "Gibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?",
            "Nehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?",
            "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
            "Gab es in den letzten zehn Jahren psychische Behandlungen?",
            "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
            "Bestehen bei Ihnen bekannte Allergien?",
          ].join("\n"),
          gatekeeperTask: "Bitte freundlich um Weiterleitung zur zuständigen Führungskraft für dieses Thema.",
          gatekeeperBehavior: "Erkläre kurz worum es geht wenn gefragt. Frage nach dem Namen der zuständigen Person. Bleib höflich aber bestimmt.",
          receptionTopicReason: "",
          decisionMakerTask: "Vereinbare einen 15-minütigen, unverbindlichen Beratungstermin mit Herrn Matthias Duic.",
          decisionMakerBehavior: "Nutze den Leitfaden, erkläre den Mehrwert klar und präzise, gehe auf Einwände ein und schlage konkrete Termine vor.",
          decisionMakerContext: "",
          problemBuildup: "",
          conceptTransition: "",
          appointmentConfirmation: "",
          availableAppointmentSlots: "",
          appointmentGoal: "Ein konkreter Beratungstermin mit Herrn Matthias Duic ist vereinbart.",
        };
      }
    }

    setDraftScripts(nextDrafts);
    setNotice(
      `Aktueller Stand: ${payload.metrics.appointments} Termin(e), ${payload.metrics.callbacksOpen} offene Wiedervorlage(n).`,
    );
    setLoading(false);
  }

  async function loadCampaignLists() {
    const response = await fetch("/api/campaigns/lists", { cache: "no-store" });
    const payload = (await response.json()) as { lists?: CampaignListSummary[] };
    if (response.ok) {
      setCampaignLists(payload.lists || []);
    }
  }

  async function loadSessionAndAdminData() {
    const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
    const mePayload = (await meResponse.json().catch(() => ({}))) as { user?: SessionUser };
    if (!meResponse.ok || !mePayload.user) {
      return;
    }

    setCurrentUser(mePayload.user);

    const phoneResponse = await fetch("/api/admin/phone-numbers", { cache: "no-store" });
    const phonePayload = (await phoneResponse.json().catch(() => ({}))) as {
      phoneNumbers?: ManagedPhoneNumber[];
    };
    if (phoneResponse.ok) {
      setManagedPhoneNumbers(phonePayload.phoneNumbers || []);
    }

    if (mePayload.user.role === "master") {
      const usersResponse = await fetch("/api/admin/users", { cache: "no-store" });
      const usersPayload = (await usersResponse.json().catch(() => ({}))) as { users?: AdminUser[] };
      if (usersResponse.ok) {
        setAdminUsers(usersPayload.users || []);
      }
    }
  }

  useEffect(() => {
    void loadDashboard();
    void loadCampaignLists();
    void loadSessionAndAdminData();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/twilio/call-options", { cache: "no-store" });
        const payload = (await response.json()) as {
          fromOptions?: Array<{ id?: string; number: string; label: string }>;
          defaultFrom?: string;
        };

        if (!response.ok) {
          return;
        }

        const fromOptions = payload.fromOptions || [];
        setTwilioFromOptions(fromOptions);
        setTwilioFrom(payload.defaultFrom || fromOptions[0]?.number || "");
      } catch {
        // Optional UI data; keep call form usable even if this fetch fails.
      }
    })();
  }, []);

  function downloadSampleCsv() {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "gloria-muster-import.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }

  async function handleCsvImport() {
    setBusy(true);

    try {
      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvText,
          listName: importListName.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        imported?: number;
        error?: string;
        listName?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "CSV konnte nicht importiert werden.");
      }

      setNotice(`Liste "${payload.listName || importListName || "Import"}" importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFileImport() {
    if (!importFile) {
      setNotice("Bitte zuerst eine CSV- oder Excel-Datei auswählen.");
      return;
    }

    setBusy(true);
    setNotice(`Dateiimport läuft (${importFile.name}) ...`);

    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const formData = new FormData();
      formData.set("file", importFile);
      formData.set("listName", importListName.trim() || importFile.name.replace(/\.[^.]+$/, ""));

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 45_000);

      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (timeout) {
        clearTimeout(timeout);
      }

      const raw = await response.text();
      const payload = ((() => {
        try {
          return JSON.parse(raw) as {
            imported?: number;
            error?: string;
            listName?: string;
          };
        } catch {
          return {} as {
            imported?: number;
            error?: string;
            listName?: string;
          };
        }
      })()) as {
        imported?: number;
        error?: string;
        listName?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || raw || "Datei konnte nicht importiert werden.");
      }

      setNotice(`Liste "${payload.listName || importListName || importFile.name}" importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      setImportFile(null);
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Dateiimport fehlgeschlagen.",
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      setBusy(false);
    }
  }

  async function controlCampaignList(listId: string, action: "start" | "stop" | "delete") {
    if (action === "delete") {
      const confirmed = confirm("Moechten Sie diese Liste wirklich loeschen? Alle zugehoerigen Firmen werden entfernt.");
      if (!confirmed) {
        return;
      }
    }

    setBusy(true);
    try {
      const response = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, listId }),
      });
      const payload = (await response.json()) as {
        lists?: CampaignListSummary[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Liste konnte nicht aktualisiert werden.");
      }

      setCampaignLists(payload.lists || []);
      if (action === "start") {
        setNotice("Liste wurde gestartet.");
      } else if (action === "stop") {
        setNotice("Liste wurde gestoppt.");
      } else {
        setNotice("Liste wurde geloescht.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Aktion fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const activeLists = campaignLists.filter((list) => list.active);

    if (activeLists.length === 0) {
      return;
    }

    const timer = setInterval(() => {
      void (async () => {
        for (const list of activeLists) {
          await fetch("/api/campaigns/lists", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run", listId: list.listId }),
          }).catch(() => undefined);
        }
        await loadCampaignLists();
        await loadDashboard();
      })();
    }, 15000);

    return () => clearInterval(timer);
  }, [campaignLists]);

  async function applyLearning(topic: Topic) {
    const confirmed = confirm(
      `Möchten Sie die vorgeschlagenen Optimierungen für "${topic}" übernehmen?`,
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Optimierung konnte nicht angewendet werden.");
      }

      setNotice(`Gloria hat das Playbook für ${topic} anhand der Gesprächsreports optimiert.`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Selbstoptimierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function optimizeWithAI(topic: Topic) {
    setBusy(true);
    try {
      const previewRes = await fetch("/api/learning/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const preview = (await previewRes.json()) as {
        error?: string;
        optimized?: { opener: string; discovery: string; objectionHandling: string; close: string; rationale: string[]; source: string };
      };
      if (!previewRes.ok || !preview.optimized) {
        throw new Error(preview.error || "Vorschau fehlgeschlagen.");
      }
      const opt = preview.optimized;
      const rationale = opt.rationale.length ? `\n\nBegruendung:\n- ${opt.rationale.join("\n- ")}` : "";
      const confirmed = confirm(
        `KI-Optimierung fuer "${topic}" (${opt.source}):\n\n` +
          `Opener: ${opt.opener.slice(0, 180)}${opt.opener.length > 180 ? "..." : ""}\n\n` +
          `Close: ${opt.close.slice(0, 180)}${opt.close.length > 180 ? "..." : ""}` +
          rationale +
          "\n\nIns Playbook uebernehmen?",
      );
      if (!confirmed) {
        setNotice("Optimierung verworfen.");
        return;
      }
      const applyRes = await fetch("/api/learning/optimize?apply=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const applied = (await applyRes.json()) as { error?: string };
      if (!applyRes.ok) throw new Error(applied.error || "Uebernahme fehlgeschlagen.");
      setNotice(`KI-optimiertes Playbook fuer ${topic} gespeichert (${opt.source}).`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "KI-Optimierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function saveScript(topic: Topic) {
    const draft = draftScripts[topic];

    if (!draft) {
      return;
    }

    setBusy(true);
    setSaveStatus(null);

    try {
      const response = await fetch("/api/playbooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const payload = (await response.json()) as {
        error?: string;
        storageMode?: "postgres" | "file";
      };

      if (!response.ok) {
        throw new Error(payload.error || "Playbook konnte nicht gespeichert werden.");
      }

      setNotice(
        `Playbook für ${topic} gespeichert und für Gloria übernommen. Gespeichert in ${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}.`,
      );
      setSaveStatus({
        type: "success",
        message: `Erfolgreich gespeichert (${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}).`,
      });
      await loadDashboard();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Playbook speichern fehlgeschlagen.";
      setNotice(errorMessage);
      setSaveStatus({ type: "error", message: errorMessage });
    } finally {
      setBusy(false);
    }
  }

  async function testVoice() {
    setBusy(true);

    setVoicePreview("Vorschau wird geladen ...");
    setVoiceAudioUrl("");

    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: voiceTopic }),
      });

      const payload = (await response.json()) as {
        preview?: string;
        provider?: "elevenlabs" | "browser";
        audioBase64?: string;
        audioMimeType?: string;
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || payload.message || "Stimmtest konnte nicht geladen werden.");
      }

      setVoicePreview(payload.preview || "Keine Vorschau verfügbar.");

      if (payload.audioBase64 && payload.audioMimeType) {
        const url = `data:${payload.audioMimeType};base64,${payload.audioBase64}`;
        setVoiceAudioUrl(url);
        void new Audio(url).play().catch(() => undefined);
      } else {
        setVoiceAudioUrl("");
        speakText(payload.preview || "");
      }

      setNotice(payload.message || `Stimmtest für ${voiceTopic} gestartet.`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `${error.message} - die Textvorschau konnte nicht geladen werden.`
          : "Stimmtest konnte nicht geladen werden.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startTwilioTestCall() {
    if (!twilioTarget.trim()) {
      setNotice("Bitte zuerst eine Zielnummer im internationalen Format eingeben, z. B. +492339123456.");
      return;
    }

    setBusy(true);

    try {
      const selectedFrom = twilioFromOptions.find((option) => option.number === twilioFrom);
      const response = await fetch("/api/twilio/test-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: twilioTarget,
          company: twilioCompany,
          contactName: twilioContactName,
          topic: twilioTopic,
          from: twilioFrom || undefined,
          phoneNumberId: selectedFrom?.id,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        sid?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Twilio-Testanruf konnte nicht gestartet werden.");
      }

      setNotice(`${payload.message || "Anruf gestartet."} SID: ${payload.sid || "-"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Anruf fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecording(reportId: string) {
    if (!confirm("Aufnahme wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(
        `/api/reports/recording?reportId=${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error("Aufnahme konnte nicht gelöscht werden.");
      }

      setNotice("Aufnahme erfolgreich gelöscht.");
      setSelectedReport((current) =>
        current?.id === reportId ? { ...current, recordingUrl: undefined } : current,
      );
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(reportId: string) {
    if (!confirm("Report und Aufnahme wirklich komplett löschen? Diese Aktion kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(
        `/api/reports?reportId=${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error("Report konnte nicht gelöscht werden.");
      }

      setNotice("Report erfolgreich gelöscht.");
      setSelectedReport(null);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllReports() {
    if (
      !confirm(
        "Wirklich ALLE Gesprächsreports und zugehörigen Aufnahmen unwiderruflich löschen?",
      )
    ) {
      return;
    }
    if (
      !confirm(
        "Letzte Sicherheitsabfrage: Diese Aktion kann nicht rückgängig gemacht werden. Fortfahren?",
      )
    ) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(`/api/reports?all=1`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        deletedReports?: number;
        deletedRecordings?: number;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Reports konnten nicht gelöscht werden.");
      }

      setSelectedReport(null);
      setNotice(
        `Alle Gesprächsreports gelöscht (${payload.deletedReports ?? 0} Reports, ${payload.deletedRecordings ?? 0} Aufnahmen entfernt).`,
      );
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function createUserByAdmin() {
    if (!newUsername || !newPassword || !newRealName || !newCompanyName) {
      setNotice("Bitte alle Pflichtfelder für den Benutzer angeben.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          realName: newRealName,
          companyName: newCompanyName,
          address: newAddress,
          email: newEmail,
          realPhone: newRealPhone,
          gesellschaft: newGesellschaft,
          role: newRole,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Benutzer konnte nicht erstellt werden.");
      }

      setNewUsername("");
      setNewPassword("");
      setNewRealName("");
      setNewCompanyName("");
      setNewAddress("");
      setNewEmail("");
      setNewRealPhone("");
      setNewGesellschaft("");
      setNewRole("user");
      setNotice("Benutzer erfolgreich erstellt.");
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Benutzer konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  async function createPhoneByAdmin() {
    if (!newPhoneUserId || !newPhoneNumber || !newPhoneLabel) {
      setNotice("Bitte User, Nummer und Label angeben.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/phone-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: newPhoneUserId,
          phoneNumber: newPhoneNumber,
          label: newPhoneLabel,
          active: true,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Rufnummer konnte nicht gespeichert werden.");
      }

      setNewPhoneNumber("");
      setNewPhoneLabel("");
      setNotice("Rufnummer gespeichert.");
      await loadSessionAndAdminData();
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rufnummer konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteUserByAdmin(userId: string, username: string) {
    if (currentUser?.id === userId) {
      setNotice("Der aktuell angemeldete Master-Benutzer kann hier nicht gelöscht werden.");
      return;
    }

    const confirmed = confirm(`Benutzer \"${username}\" wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Benutzer konnte nicht gelöscht werden.");
      }

      setNotice(`Benutzer \"${username}\" wurde gelöscht.`);
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Benutzer konnte nicht gelöscht werden.");
    } finally {
      setBusy(false);
    }
  }

  async function resetUserPassword(userId: string, username: string) {
    const next = window.prompt(`Neues Passwort fuer "${username}":`);
    if (!next || next.trim().length < 6) {
      if (next !== null) setNotice("Passwort muss mindestens 6 Zeichen haben.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Passwort-Reset fehlgeschlagen.");
      setNotice(`Passwort fuer "${username}" gesetzt.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Passwort-Reset fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleUserRole(userId: string, username: string, current: "master" | "user") {
    if (currentUser?.id === userId) {
      setNotice("Eigene Rolle kann nicht geaendert werden.");
      return;
    }
    const target: "master" | "user" = current === "master" ? "user" : "master";
    if (!confirm(`Rolle von "${username}" auf "${target}" setzen?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: target }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Rolle konnte nicht geaendert werden.");
      setNotice(`Rolle fuer "${username}" ist jetzt "${target}".`);
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rolle konnte nicht geaendert werden.");
    } finally {
      setBusy(false);
    }
  }

  function startEditUser(user: AdminUser) {
    const phone = user.phoneNumbers?.[0];
    setEditingUserId(user.id);
    setEditDraft({
      username: user.username,
      realName: user.realName,
      companyName: user.companyName,
      address: user.address || "",
      email: user.email || "",
      realPhone: user.realPhone || "",
      gesellschaft: user.gesellschaft || "",
      role: user.role,
      password: "",
      assignedPhone: phone?.phoneNumber || "",
      assignedLabel: phone?.label || "",
    });
  }

  function cancelEditUser() {
    setEditingUserId(null);
    setEditDraft(null);
  }

  async function saveEditUser(user: AdminUser) {
    if (!editDraft) return;
    if (editDraft.password && editDraft.password.length < 6) {
      setNotice("Passwort muss mindestens 6 Zeichen haben.");
      return;
    }

    setBusy(true);
    try {
      const userPayload: Record<string, unknown> = {
        username: editDraft.username,
        realName: editDraft.realName,
        companyName: editDraft.companyName,
        address: editDraft.address,
        email: editDraft.email,
        realPhone: editDraft.realPhone,
        gesellschaft: editDraft.gesellschaft,
        role: editDraft.role,
      };
      if (editDraft.password) userPayload.password = editDraft.password;

      const userRes = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(userPayload),
      });
      const userJson = (await userRes.json().catch(() => ({}))) as { error?: string };
      if (!userRes.ok) throw new Error(userJson.error || "Benutzer konnte nicht aktualisiert werden.");

      // Phone number sync (single assigned phone per row)
      const existing = user.phoneNumbers?.[0];
      const desiredNumber = editDraft.assignedPhone.trim();
      const desiredLabel = editDraft.assignedLabel.trim() || "Standard";

      if (!existing && desiredNumber) {
        const res = await fetch("/api/admin/phone-numbers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, phoneNumber: desiredNumber, label: desiredLabel, active: true }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht angelegt werden.");
      } else if (existing && !desiredNumber) {
        const res = await fetch(`/api/admin/phone-numbers?id=${encodeURIComponent(existing.id)}`, {
          method: "DELETE",
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht entfernt werden.");
      } else if (existing && desiredNumber) {
        if (existing.phoneNumber !== desiredNumber || existing.label !== desiredLabel) {
          const res = await fetch("/api/admin/phone-numbers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: existing.id, phoneNumber: desiredNumber, label: desiredLabel, active: existing.active }),
          });
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht aktualisiert werden.");
        }
      }

      setNotice(`Benutzer "${editDraft.username}" gespeichert.`);
      cancelEditUser();
      await loadSessionAndAdminData();
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">G</span>
          <div>
            <div className="brand-title">Gloria</div>
            <div className="brand-sub">Agentur Duic</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeView === "overview" ? "active" : ""}`}
            onClick={() => setActiveView("overview")}
          >
            <span className="nav-icon" aria-hidden>▦</span>
            <span>Übersicht</span>
          </button>
          <button
            className={`nav-item ${activeView === "calls" ? "active" : ""}`}
            onClick={() => setActiveView("calls")}
          >
            <span className="nav-icon" aria-hidden>☎</span>
            <span>Anrufe</span>
          </button>
          <button
            className={`nav-item ${activeView === "leads" ? "active" : ""}`}
            onClick={() => setActiveView("leads")}
          >
            <span className="nav-icon" aria-hidden>≡</span>
            <span>Offene Firmenliste</span>
          </button>
          <button
            className={`nav-item ${activeView === "calendar" ? "active" : ""}`}
            onClick={() => setActiveView("calendar")}
          >
            <span className="nav-icon" aria-hidden>▤</span>
            <span>Kalender</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <button
            className={`nav-item ${activeView === "settings" ? "active" : ""}`}
            onClick={() => setActiveView("settings")}
          >
            <span className="nav-icon" aria-hidden>⚙</span>
            <span>Einstellungen</span>
          </button>
          <button
            className={`nav-item ${activeView === "compliance" ? "active" : ""}`}
            onClick={() => setActiveView("compliance")}
          >
            <span className="nav-icon" aria-hidden>§</span>
            <span>Compliance & Ablauf</span>
          </button>
          <a className="nav-item ghost" href="/logout">
            <span className="nav-icon" aria-hidden>↩</span>
            <span>Abmelden</span>
          </a>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="topbar-eyebrow">Agentur Duic Sprockhövel</div>
            <h1 className="topbar-title">
              {activeView === "overview" ? "Übersicht" : null}
              {activeView === "calls" ? "Anrufe" : null}
              {activeView === "leads" ? "Offene Firmenliste" : null}
              {activeView === "calendar" ? "Kalender" : null}
              {activeView === "settings" ? "Einstellungen" : null}
              {activeView === "compliance" ? "Compliance & Ablauf" : null}
            </h1>
            <p className="topbar-note">{loading ? "Lade Daten ..." : notice}</p>
          </div>
          <div className="topbar-meta">
            <span className="status-pill">
              <span className={`status-dot ${data.reportStorageMode === "postgres" ? "ok" : "warn"}`} />
              Reports: {data.reportStorageMode === "postgres" ? "PostgreSQL" : "Datei"}
            </span>
            <span className="status-pill">
              <span className={`status-dot ${data.playbooksStorageMode === "postgres" ? "ok" : "warn"}`} />
              Playbooks: {data.playbooksStorageMode === "postgres" ? "PostgreSQL" : "Datei"}
            </span>
            {currentUser ? (
              <span className="user-chip">
                <span className="user-avatar">{(currentUser.username || "?").slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{currentUser.username}</strong>
                  <small>{currentUser.role === "master" ? "Master" : "Nutzer"}</small>
                </span>
              </span>
            ) : null}
          </div>
        </header>

        <div className="view-content">

      {activeView === "overview" ? (
      <>
      <section className="kpi-grid">
        <article className="kpi-card primary">
          <div className="kpi-label">Termine heute</div>
          <div className="kpi-value">{
            (data.reports || []).filter((r) => {
              if (r.outcome !== "Termin" || !r.appointmentAt) return false;
              const d = new Date(r.appointmentAt);
              const today = new Date();
              return d.toDateString() === today.toDateString();
            }).length
          }</div>
          <div className="kpi-sub">{data.metrics.appointments} Termine gesamt</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Gespräche heute</div>
          <div className="kpi-value">{
            (data.reports || []).filter((r) => {
              const d = new Date(r.conversationDate);
              const today = new Date();
              return d.toDateString() === today.toDateString();
            }).length
          }</div>
          <div className="kpi-sub">{data.metrics.conversations} Gespräche gesamt</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Offene Wiedervorlagen</div>
          <div className="kpi-value">{data.metrics.callbacksOpen}</div>
          <div className="kpi-sub">Werden automatisch zurückgerufen</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Conversion-Rate</div>
          <div className="kpi-value">{reportingInsights.appointmentRate}%</div>
          <div className="kpi-sub">Termine je Kontakt erreicht</div>
        </article>
      </section>

      <CollapsiblePanel title="Kennzahlen" defaultOpen>
        <section className="stats-grid">
          <article className="stat-card"><span>Wählversuche</span><strong>{data.metrics.dialAttempts}</strong></article>
          <article className="stat-card"><span>Gespräche</span><strong>{data.metrics.conversations}</strong></article>
          <article className="stat-card"><span>Termine</span><strong>{data.metrics.appointments}</strong></article>
          <article className="stat-card"><span>Absagen</span><strong>{data.metrics.rejections}</strong></article>
          <article className="stat-card"><span>Wiedervorlagen offen</span><strong>{data.metrics.callbacksOpen}</strong></article>
          <article className="stat-card"><span>Empfangs-Loop-Breaks</span><strong>{data.metrics.gatekeeperLoops}</strong></article>
          <article className="stat-card"><span>Durchstellquote</span><strong>{data.metrics.transferSuccessRate}%</strong></article>
        </section>
      </CollapsiblePanel>

      <CollapsiblePanel title="Reporting & Conversion" defaultOpen={false}>
        {reportingInsights.total === 0 ? (
          <p className="subtle">Noch keine Reports verfügbar. Sobald Gespräche geführt werden, erscheinen hier Funnel, Themen-Performance und Ablehnungsgründe.</p>
        ) : (
          <div className="stack" style={{ gap: "24px" }}>
            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Conversion-Funnel (alle Gespräche)</strong></p>
              <section className="stats-grid">
                <article className="stat-card"><span>Reports gesamt</span><strong>{reportingInsights.total}</strong></article>
                <article className="stat-card"><span>Kontakte erreicht</span><strong>{reportingInsights.contacts}<small className="subtle"> ({reportingInsights.contactRate}%)</small></strong></article>
                <article className="stat-card"><span>Termine</span><strong>{reportingInsights.appointments}<small className="subtle"> ({reportingInsights.appointmentRate}% v. Kontakte)</small></strong></article>
                <article className="stat-card"><span>Wiedervorlagen</span><strong>{reportingInsights.callbacks}</strong></article>
                <article className="stat-card"><span>Absagen</span><strong>{reportingInsights.rejections}<small className="subtle"> ({reportingInsights.rejectionRate}% v. Kontakte)</small></strong></article>
                <article className="stat-card"><span>Kein Kontakt</span><strong>{reportingInsights.noContact}</strong></article>
              </section>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Performance nach Thema</strong></p>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Thema</th>
                      <th style={{ textAlign: "right" }}>Reports</th>
                      <th style={{ textAlign: "right" }}>Termine</th>
                      <th style={{ textAlign: "right" }}>Absagen</th>
                      <th style={{ textAlign: "right" }}>Wiedervorlage</th>
                      <th style={{ textAlign: "right" }}>Kein Kontakt</th>
                      <th style={{ textAlign: "right" }}>Termin-Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportingInsights.topicStats.map((row) => (
                      <tr key={row.topic}>
                        <td>{row.topic}</td>
                        <td style={{ textAlign: "right" }}>{row.total}</td>
                        <td style={{ textAlign: "right" }}>{row.termin}</td>
                        <td style={{ textAlign: "right" }}>{row.absage}</td>
                        <td style={{ textAlign: "right" }}>{row.wiedervorlage}</td>
                        <td style={{ textAlign: "right" }}>{row.keinKontakt}</td>
                        <td style={{ textAlign: "right" }}><strong>{row.terminRate}%</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Top Ablehnungsgründe</strong></p>
              {reportingInsights.topRejections.length === 0 ? (
                <p className="subtle">Noch keine Absagen erfasst.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {reportingInsights.topRejections.map((r) => {
                    const pct = reportingInsights.rejections > 0 ? Math.round((r.count / reportingInsights.rejections) * 100) : 0;
                    return (
                      <li key={r.label} style={{ display: "grid", gridTemplateColumns: "260px 1fr 60px", gap: 10, alignItems: "center" }}>
                        <span>{r.label}</span>
                        <span style={{ background: "#e8edf5", borderRadius: 6, height: 10, overflow: "hidden" }}>
                          <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "linear-gradient(135deg, #c24d4d, #a03030)" }} />
                        </span>
                        <span style={{ textAlign: "right" }}><strong>{r.count}</strong> <small className="subtle">({pct}%)</small></span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="subtle" style={{ marginTop: 8, fontSize: "0.85rem" }}>
                Ableitung erfolgt per Textanalyse der Report-Zusammenfassung (Schlagwörter). "Sonstige" umfasst Absagen ohne erkennbares Muster.
              </p>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Verlauf letzte 14 Tage</strong></p>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${reportingInsights.days.length}, minmax(28px, 1fr))`, gap: 4, alignItems: "end", minHeight: 120 }}>
                {reportingInsights.days.map((d) => {
                  const h = Math.round((d.gespraeche / reportingInsights.peakDayGespraeche) * 100);
                  const terminPct = d.gespraeche > 0 ? Math.round((d.termine / d.gespraeche) * 100) : 0;
                  const absagePct = d.gespraeche > 0 ? Math.round((d.absagen / d.gespraeche) * 100) : 0;
                  return (
                    <div key={d.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <div
                        title={`${d.label}: ${d.gespraeche} Gespräche, ${d.termine} Termine, ${d.absagen} Absagen`}
                        style={{ width: "100%", height: `${Math.max(h, 2)}px`, background: "linear-gradient(180deg, #3c6fb5, #27457a)", borderRadius: 3, position: "relative", display: "flex", flexDirection: "column-reverse" }}
                      >
                        {terminPct > 0 && <div style={{ height: `${terminPct}%`, background: "#2f8f57" }} />}
                        {absagePct > 0 && <div style={{ height: `${absagePct}%`, background: "#c24d4d", opacity: 0.85 }} />}
                      </div>
                      <small className="subtle" style={{ fontSize: "0.7rem" }}>{d.label}</small>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: "0.85rem" }} className="subtle">
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#3c6fb5", marginRight: 4, borderRadius: 2 }} />Gespräche</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#2f8f57", marginRight: 4, borderRadius: 2 }} />Termine</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#c24d4d", marginRight: 4, borderRadius: 2 }} />Absagen</span>
              </div>
            </div>
          </div>
        )}
      </CollapsiblePanel>
      </>
      ) : null}

      {activeView === "calls" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Anruf bei Firma starten" defaultOpen>
          <div className="field-grid">
            <div>
              <label>Ausgangsnummer</label>
              <select
                value={twilioFrom}
                onChange={(event) => setTwilioFrom(event.target.value)}
                disabled={twilioFromOptions.length === 0}
              >
                {twilioFromOptions.length === 0 ? (
                  <option value="">Keine Nummer konfiguriert</option>
                ) : (
                  twilioFromOptions.map((option) => (
                    <option key={option.number} value={option.number}>{option.label} ({option.number})</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label>Zielnummer</label>
              <input value={twilioTarget} onChange={(event) => setTwilioTarget(event.target.value)} placeholder="+492339123456" />
            </div>
            <div>
              <label>Firma</label>
              <input value={twilioCompany} onChange={(event) => setTwilioCompany(event.target.value)} />
            </div>
            <div>
              <label>Ansprechpartner</label>
              <input value={twilioContactName} onChange={(event) => setTwilioContactName(event.target.value)} />
            </div>
            <div>
              <label>Thema</label>
              <select value={twilioTopic} onChange={(event) => setTwilioTopic(event.target.value as Topic)}>
                {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
              </select>
            </div>
          </div>
          <div className="row top-gap">
            <button className="btn" onClick={() => void startTwilioTestCall()} disabled={busy || !twilioTarget.trim()}>
              {busy ? "Anruf startet ..." : "Anruf bei Firma starten"}
            </button>
          </div>
        </CollapsiblePanel>

        <LiveMonitorPanel />

        <CollapsiblePanel title="Gesprächsreports & Aufnahmen" defaultOpen>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <span className="subtle">
              Reports und zugehörige Aufnahmen werden automatisch nach 30 Tagen gelöscht.
            </span>
            <button
              className="btn danger"
              onClick={() => void deleteAllReports()}
              disabled={busy || reportRows.length === 0}
              title="Alle Gesprächsreports & Aufnahmen löschen"
            >
              Alle Reports löschen
            </button>
          </div>
          <table>
            <thead>
              <tr><th>Firma</th><th>Thema</th><th>Ergebnis</th><th>Termin / Callback</th><th>Aufnahme</th><th></th></tr>
            </thead>
            <tbody>
              {reportRows.map((report) => (
                <tr key={report.id}>
                  <td><strong>{report.company}</strong>{report.contactName ? <div className="subtle">{report.contactName}</div> : null}</td>
                  <td>{report.topic}</td>
                  <td>
                    <span className={`status ${report.outcome === "Absage" ? "absage" : report.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                      {report.outcome}
                    </span>
                  </td>
                  <td>{formatDate(report.appointmentAt || report.nextCallAt)}</td>
                  <td>
                    {report.recordingConsent ? (
                      report.recordingUrl ? (
                        <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                          <a href={`/api/reports/recording?url=${encodeURIComponent(report.recordingUrl)}`} target="_blank" rel="noreferrer">Abspielen</a>
                          <a href={`/api/reports/recording?url=${encodeURIComponent(report.recordingUrl)}&download=1`} download>↓</a>
                          <button
                            className="btn danger"
                            style={{ fontSize: "0.78rem", padding: "3px 9px" }}
                            onClick={() => void deleteRecording(report.id)}
                            disabled={busy}
                            title="Aufnahme löschen"
                          >✕</button>
                        </div>
                      ) : "Zugestimmt"
                    ) : (
                      "Keine Freigabe"
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button
                        className="btn ghost"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => setSelectedReport(report)}
                      >Details</button>
                      <button
                        className="btn danger"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => void deleteReport(report.id)}
                        disabled={busy}
                        title="Report löschen"
                      >🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CollapsiblePanel>

      </section>
      ) : null}

      {activeView === "leads" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Aufträge per CSV laden" defaultOpen>
          <p className="subtle">Format: company, contactName, phone, email, topic, note, nextCallAt</p>
          <label>Listenname</label>
          <input
            value={importListName}
            onChange={(event) => setImportListName(event.target.value)}
            placeholder="z. B. April-Kampagne Industrie"
          />
          <label>Datei hochladen (CSV / XLSX / XLS)</label>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(event) => setImportFile(event.target.files?.[0] || null)}
          />
          <div className="row top-gap">
            <button className="btn" onClick={() => void handleFileImport()} disabled={busy || !importFile}>Datei importieren</button>
            {importFile ? <span className="subtle">Ausgewählt: {importFile.name}</span> : null}
          </div>
          <p className="subtle top-gap">Optional: CSV-Inhalt manuell einfügen.</p>
          <textarea value={csvText} onChange={(event) => setCsvText(event.target.value)} />
          <div className="row top-gap">
            <button className="btn" onClick={() => void handleCsvImport()} disabled={busy}>CSV-Text importieren</button>
            <button className="btn ghost" onClick={downloadSampleCsv}>Muster-CSV herunterladen</button>
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel title="Offene Firmenliste" defaultOpen>
          {campaignLists.length === 0 ? (
            <p className="subtle">Noch keine Listen vorhanden. Bitte zuerst CSV oder Excel hochladen.</p>
          ) : (
            <div className="stack">
              <p className="subtle">
                Aktive Listen werden automatisch Mo–Fr von 09:00–12:00 und 13:00–17:00 (Europe/Berlin) abgearbeitet. Bei „Kein Kontakt“ wird der Lead nach 1 Tag und danach nach 3 Tagen erneut versucht (max. 3 Versuche).
              </p>
              {campaignLists.map((list) => {
                const leadsForList = data.leads.filter((lead) => (lead.listId || "legacy") === list.listId);

                return (
                  <div key={list.listId} className="mini-panel">
                    <div className="row spread">
                      <h3>{list.listName}</h3>
                      <div className="row">
                        <span className="pill">Gesamt: {list.total}</span>
                        <span className="pill">Offen: {list.pending}</span>
                        <span className="pill">Termine: {list.appointments}</span>
                        <button
                          className="btn"
                          onClick={() => void controlCampaignList(list.listId, "start")}
                          disabled={busy || list.active || list.pending === 0}
                        >
                          Starten
                        </button>
                        <button
                          className="btn ghost"
                          onClick={() => void controlCampaignList(list.listId, "stop")}
                          disabled={busy || !list.active}
                        >
                          Stoppen
                        </button>
                        <button
                          className="btn danger"
                          onClick={() => void controlCampaignList(list.listId, "delete")}
                          disabled={busy}
                        >
                          Loeschen
                        </button>
                      </div>
                    </div>

                    <table className="top-gap">
                      <thead>
                        <tr><th>Firma</th><th>Ansprechpartner</th><th>Thema</th><th>Status</th><th>Nächster Anruf</th></tr>
                      </thead>
                      <tbody>
                        {leadsForList.map((lead) => (
                          <tr key={lead.id}>
                            <td><strong>{lead.company}</strong></td>
                            <td>{lead.contactName || "-"}</td>
                            <td>{lead.topic}</td>
                            <td>{lead.status}</td>
                            <td>{formatDate(lead.nextCallAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "calendar" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Kalender" defaultOpen>
          {currentUser?.calendarFeedToken ? (
            <div className="mini-panel bottom-gap">
              <h3>Kalender abonnieren</h3>
              <p className="subtle">
                Fuegen Sie diese URL in Outlook/Google/Apple als Internet-Kalender hinzu, um Ihre Gloria-Termine automatisch synchron zu halten.
              </p>
              <div className="row top-gap" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  readOnly
                  value={`${typeof window !== "undefined" ? window.location.origin : ""}/api/calendar/feed/${currentUser.calendarFeedToken}`}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{ flex: 1, minWidth: "20rem" }}
                />
                <button
                  className="btn"
                  onClick={() => {
                    const url = `${window.location.origin}/api/calendar/feed/${currentUser.calendarFeedToken}`;
                    void navigator.clipboard.writeText(url);
                  }}
                >
                  Link kopieren
                </button>
              </div>
            </div>
          ) : null}

          <div className="row spread">
            <strong>
              {new Intl.DateTimeFormat("de-DE", {
                month: "long",
                year: "numeric",
              }).format(calendarMonth)}
            </strong>
            <div className="row">
              <button
                className="btn ghost"
                onClick={() =>
                  setCalendarMonth(
                    (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
                  )
                }
              >
                ← Monat zurück
              </button>
              <button
                className="btn ghost"
                onClick={() =>
                  setCalendarMonth(
                    (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                  )
                }
              >
                Monat vor →
              </button>
            </div>
          </div>

          <div className="calendar-grid top-gap">
            {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((weekday) => (
              <div key={weekday} className="calendar-weekday">{weekday}</div>
            ))}
            {calendarDays.map((day) => {
              const isSelected = day.key === selectedDayKey;
              return (
                <button
                  key={day.key}
                  className={`calendar-day ${day.inMonth ? "" : "outside"} ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedDayKey(day.key)}
                >
                  <span>{day.date.getDate()}</span>
                  <small>{day.items.length > 0 ? `${day.items.length} Termin(e)` : "-"}</small>
                </button>
              );
            })}
          </div>

          <div className="calendar-detail top-gap">
            <div className="mini-panel">
              <h3>
                Termine am {new Intl.DateTimeFormat("de-DE", { dateStyle: "full" }).format(new Date(selectedDayKey))}
              </h3>
              {selectedDayAppointments.length > 0 ? (
                <div className="calendar-list top-gap">
                  {selectedDayAppointments.map((report) => (
                    <button
                      key={report.id}
                      className="calendar-item"
                      onClick={() => setSelectedReport(report)}
                    >
                      <strong>{formatDate(report.appointmentAt)}</strong>
                      <span>{report.company}{report.contactName ? ` · ${report.contactName}` : ""}</span>
                      <small>{report.topic} · {report.recordingUrl ? "mit Aufnahme" : "ohne Aufnahme"}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="subtle top-gap">Für diesen Tag sind noch keine Termine eingetragen.</p>
              )}
            </div>
            <div className="mini-panel">
              <h3>Automatische Einträge</h3>
              <p className="subtle top-gap">
                Gloria trägt Termine automatisch nach dem Telefonat ein. Gesprächsreport und Aufnahmen werden direkt mit dem Termin verknüpft und sind per Klick im Detaildialog einsehbar.
              </p>
              <p className="subtle top-gap">
                Quelle: Telefonie-Webhook und Abschlussreport.
              </p>
            </div>
          </div>
        </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "compliance" ? (
      <section className="stack top-section">
              <CollapsiblePanel title="Compliance & Ablauf" defaultOpen>
                <p className="subtle">
                  Dieser Bereich dokumentiert die verbindlichen Leitplanken für Gloria im Live-Telefonieprozess.
                </p>

                <p className="subtle top-gap"><strong>1) Rolle, Offenlegung und Verantwortlichkeit</strong></p>
                <ul>
                  <li>Gloria stellt sich zu Beginn jedes Gesprächs eindeutig als digitale Vertriebsassistentin der Agentur Duic in Sprockhövel vor.</li>
                  <li>Gloria handelt im Auftrag von Matthias Duic und nutzt ausschließlich die hinterlegten, freigegebenen Playbooks für das jeweilige Thema (z. B. PKV, GKV, bKV, Energie, Gewerbe).</li>
                  <li>Im Empfangskontakt verfolgt Gloria ausschließlich das Ziel einer korrekten Weiterleitung.</li>
                  <li>Im Entscheidergespräch führt Gloria ein fachlich korrektes Orientierungsgespräch mit dem Ziel der Terminvereinbarung.</li>
                  <li>Gloria trifft keine rechtsverbindlichen Aussagen, gibt keine Tarifempfehlungen und keine individuelle Beratung.</li>
                </ul>

                <p className="subtle top-gap"><strong>2) Verhaltensregeln und Gesprächsführung</strong></p>
                <ul>
                  <li>Gloria kommuniziert kurz, klar, höflich, professionell und lösungsorientiert.</li>
                  <li>Gloria verwendet keine erfundenen Fakten und argumentiert ausschließlich auf Basis der hinterlegten Informationen.</li>
                  <li>Gesprächsziele sind Terminvereinbarung, Wiedervorlage (mit dokumentiertem Zeitpunkt) oder eine klare Absage.</li>
                  <li>Während Warteschleifen oder beim Durchstellen befindet sich Gloria im Listen-Only-Modus und startet erst, wenn ein realer Gesprächspartner spricht.</li>
                  <li>Bei Terminierung bietet Gloria konkrete Zeitoptionen an; passen diese nicht, kann der Gesprächspartner eigene Vorschläge machen.</li>
                </ul>

                <p className="subtle top-gap"><strong>3) Einwilligung und Aufzeichnung (DSGVO-konform)</strong></p>
                <ul>
                  <li>Eine Aufzeichnung erfolgt ausschließlich nach ausdrücklicher Einwilligung des Entscheiders.</li>
                  <li>Die Einwilligung wird vor Beginn der Aufzeichnung abgefragt und protokolliert.</li>
                  <li>Ohne Einwilligung wird keine Aufnahme gestartet.</li>
                  <li>Der Einwilligungsstatus wird im Report gespeichert und im Dashboard angezeigt.</li>
                  <li>Bei vorhandener Aufnahme wird nur die URL-Referenz gespeichert; die Datei selbst verbleibt beim Telefonieanbieter.</li>
                  <li>Der Nutzer kann über das Dashboard Aufnahmen löschen, was die gespeicherten Referenzen unmittelbar entfernt.</li>
                </ul>

                <p className="subtle top-gap"><strong>4) Technischer Prozessablauf</strong></p>
                <ul>
                  <li>Start des Gesprächs über die Twilio-Call-APIs.</li>
                  <li>Gesprächssteuerung erfolgt turn-basiert über /api/twilio/voice und /api/twilio/voice/process.</li>
                  <li>Die Rollenlogik (Empfang vs. Entscheider) wird kontinuierlich bewertet.</li>
                  <li>Playbook-Fortschritt und Zustände werden signiert im Call-State geführt.</li>
                  <li>Nach Gesprächsende schreibt Gloria den vollständigen Report über /api/calls/webhook zurück ins System.</li>
                  <li>Kalender- und Report-Ansichten beziehen Termine direkt aus den gespeicherten Gesprächsreports.</li>
                </ul>

                <p className="subtle top-gap"><strong>5) Datenschutz, Datenspeicherung und Löschung (DSGVO-konform)</strong></p>
                <p className="subtle top-gap"><strong>5.1 Speicherort</strong></p>
                <ul>
                  <li>Primäre Speicherung erfolgt in PostgreSQL, sobald DATABASE_URL gesetzt ist.</li>
                  <li>Fallback ohne Datenbank: lokale JSON-Dateien unter /data/ (z. B. leads.json, reports.json, playbooks.json, report-database.json, conversation-events.json).</li>
                  <li>Aufnahmen werden nicht als Datei gespeichert, sondern ausschließlich als URL-Referenz.</li>
                </ul>

                <p className="subtle top-gap"><strong>5.2 Verarbeitete Daten</strong></p>
                <p className="subtle">Verarbeitet werden ausschließlich für den Zweck der Gesprächsdurchführung erforderliche Daten, unter anderem:</p>
                <ul>
                  <li>Firmenname</li>
                  <li>Ansprechpartner</li>
                  <li>Thema des Gesprächs</li>
                  <li>Gesprächsergebnis</li>
                  <li>Termin oder Wiedervorlage</li>
                  <li>Einwilligungsstatus</li>
                  <li>Anzahl der Kontaktversuche</li>
                  <li>Gesprächszusammenfassung</li>
                </ul>

                <p className="subtle top-gap"><strong>5.3 Speicherdauer</strong></p>
                <ul>
                  <li>Alle Gesprächsdaten werden maximal 30 Tage gespeichert, sofern keine gesetzliche Pflicht zur längeren Aufbewahrung besteht.</li>
                  <li>Nach Ablauf der 30 Tage werden die Daten automatisch gelöscht.</li>
                  <li>Aufnahmen (URL-Referenzen) werden ebenfalls nach 30 Tagen gelöscht oder sofort, wenn der Nutzer dies verlangt.</li>
                </ul>

                <p className="subtle top-gap"><strong>5.4 Rechte der Betroffenen</strong></p>
                <p className="subtle">Betroffene können jederzeit:</p>
                <ul>
                  <li>Auskunft über gespeicherte Daten verlangen</li>
                  <li>Berichtigung verlangen</li>
                  <li>Löschung verlangen</li>
                  <li>Widerspruch gegen Verarbeitung einlegen</li>
                  <li>Löschfunktionen für Reports und Aufnahmen sind im Dashboard integriert und wirken sofort auf die gespeicherten Datensätze.</li>
                </ul>

                <p className="subtle top-gap"><strong>6) Externe Dienstleister im Laufzeitpfad</strong></p>
                <ul>
                  <li>Twilio: Telefonie, Verbindungsstatus, Recording-Referenzen</li>
                  <li>OpenAI: Gesprächslogik in freien Dialogphasen</li>
                  <li>ElevenLabs (optional): Sprachsynthese</li>
                </ul>
                <p className="subtle">Alle Dienstleister werden ausschließlich im Rahmen der Auftragsverarbeitung genutzt. Es findet keine Weitergabe zu Werbezwecken statt.</p>
              </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "settings" ? (
      <section className="stack top-section">
              <CollapsiblePanel title="Gloria testen" defaultOpen>
                <div className="row">
                  <select value={voiceTopic} onChange={(event) => setVoiceTopic(event.target.value as Topic)}>
                    {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                  </select>
                  <button className="btn" onClick={() => void testVoice()} disabled={busy}>
                    {busy ? "Vorschau lädt ..." : "Stimme testen"}
                  </button>
                </div>
                <div className="code-box top-gap">{voicePreview || "Noch keine Vorschau geladen."}</div>
                {voiceAudioUrl ? <audio controls src={voiceAudioUrl} className="audio-player" /> : null}
              </CollapsiblePanel>

              <CollapsiblePanel title="Gloria lernt aus Gesprächen" defaultOpen>
                <ul>
                  {learning.globalSummary.map((item) => <li key={item}>{item}</li>)}
                </ul>
                <div className="insight-grid">
                  {learning.insights.map((insight) => (
                    <div key={insight.topic} className="mini-panel">
                      <h3>{insight.topic}</h3>
                      <p className="subtle">{insight.totalConversations} Gespräche · {insight.appointmentRate}% Terminquote</p>
                      <ul>
                        {insight.recommendations.slice(0, 2).map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
                      </ul>
                      <button className="btn ghost" onClick={() => void applyLearning(insight.topic)} disabled={busy}>Optimierung übernehmen</button>
                      <button className="btn" onClick={() => void optimizeWithAI(insight.topic)} disabled={busy} style={{ marginLeft: 6 }}>KI-Optimierung (Vorschau)</button>
                    </div>
                  ))}
                </div>
              </CollapsiblePanel>

              <CollapsiblePanel title="Themen-Playbook" defaultOpen>
                <div className="row spread">
                  <h2>Themen-Playbook</h2>
                  <select value={detailTopic} onChange={(event) => setDetailTopic(event.target.value as Topic)}>
                    {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                  </select>
                </div>

                {activeDraft ? (
                  <>
                    <p className="subtle">
                      Playbook für <strong>{detailTopic}</strong>. Drei klare Felder, frei formulierbar – keine starren Vorlagen mehr. Gloria nutzt diese Inhalte
                      direkt im Systemprompt jedes Calls. Änderungen gelten nur für Ihren Account und werden in der Datenbank gespeichert.
                    </p>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading"><strong>1. Verhalten & Tonalität</strong> <span className="subtle">(WIE Gloria spricht)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Wie Gloria zu diesem Thema agiert: Gesprächsziel, Argumentationslinie, Empathie-Anker, Einwandbehandlung,
                        Tonalität, was sie tun und was sie lassen soll. Frei formuliert.
                      </p>
                      <textarea
                        value={activeDraft.behavior ?? ""}
                        rows={10}
                        onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], behavior: event.target.value } }))}
                      />
                    </div>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading"><strong>2. Basisdaten / Pflichtfragen</strong> <span className="subtle">(WAS Gloria zwingend erfragen muss)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Eine Frage pro Zeile. Diese Punkte fragt Gloria in der Basisdaten-Phase einzeln ab –
                        z. B. Geburtsdatum, aktueller Versicherer, Beschwerden, Mitarbeiterzahl, etc.
                      </p>
                      <textarea
                        value={activeDraft.requiredData ?? ""}
                        rows={10}
                        onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], requiredData: event.target.value } }))}
                      />
                    </div>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading"><strong>3. Fachwissen</strong> <span className="subtle">(Konkrete Fakten gegen Floskeln)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Faktenpool, auf den Gloria zurückgreift, BEVOR sie auf Bilder/Metaphern ausweicht: Zahlen, Rahmenbedingungen,
                        erlaubte und verbotene Aussagen, typische Einwände mit konkreten Antworten. Je präziser, desto seltener fällt
                        Gloria in leere Phrasen wie „Glaskugel" oder „Landkarte".
                      </p>
                      <textarea
                        value={activeDraft.knowledge ?? ""}
                        rows={14}
                        onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], knowledge: event.target.value } }))}
                      />
                    </div>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading"><strong>4. Zahlen & Fakten</strong> <span className="subtle">(Pflicht-Anker in Phase 5)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Ein Beleg pro Zeile (z. B. Statistik, Studie, konkrete Marktzahl). Gloria muss in der Problem-Aufbau-Phase
                        mindestens einen dieser Punkte aktiv nennen, bevor sie zur Terminüberleitung wechselt.
                        Nur Zahlen verwenden, die Sie hier eintragen – nichts erfinden.
                      </p>
                      <textarea
                        value={activeDraft.proofPoints ?? ""}
                        rows={8}
                        onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], proofPoints: event.target.value } }))}
                      />
                    </div>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading"><strong>5. Einwand-Bibliothek</strong> <span className="subtle">(Verbindliche Konter-Linien)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Format pro Zeile: <code>Einwand: Konter-Linie</code>. Beispiel: <em>Kein Interesse: Genau das hören wir oft …</em>.
                        Gloria nutzt die Konter-Logik in eigenen Worten (max. 1–2 Sätze, ohne „Ich verstehe"-Vorlauf), statt Floskeln zu erfinden.
                      </p>
                      <textarea
                        value={activeDraft.objectionResponses ?? ""}
                        rows={10}
                        onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], objectionResponses: event.target.value } }))}
                      />
                    </div>

                    <div className="mini-panel top-gap">
                      <h3 className="sub-heading subtle">Feste Systemtexte anzeigen (von Gloria gesprochen, nicht editierbar)</h3>
                      <ul className="subtle top-gap">
                        <li><strong>Verbindungsaufbau:</strong> „Bitte einen kleinen Moment, die Verbindung wird hergestellt."</li>
                        <li><strong>Pause:</strong> „Ich bin noch dran. Nehmen Sie sich ruhig einen Moment."</li>
                        <li><strong>Empfang zustimmt:</strong> „Danke. Könnten Sie mich bitte kurz mit der zuständigen Person verbinden?"</li>
                        <li><strong>Unklarer Termin:</strong> „Sehr gern. Damit ich den Termin fest eintrage, brauche ich bitte ein genaues Datum mit Uhrzeit."</li>
                        <li><strong>Rückruf-Wunsch:</strong> „Danke. Damit ich beim Rückruf direkt durchkomme: Wie lautet bitte die direkte Durchwahl oder Mobilnummer?"</li>
                        <li><strong>PKV-Verabschiedung:</strong> „Vielen Dank für die Angaben. Der Termin ist fest eingeplant. Auf Wiederhören."</li>
                        <li><strong>Eingehender Rückruf (verbunden):</strong> „Vielen Dank für Ihren Rückruf. Ich verbinde Sie jetzt."</li>
                        <li><strong>Eingehender Rückruf (niemand da):</strong> „Aktuell ist kein Ansprechpartner verfügbar. Wir melden uns zeitnah."</li>
                        <li><strong>Technischer Fehler:</strong> „Entschuldigung, es ist ein technischer Fehler aufgetreten."</li>
                      </ul>
                    </div>

                    <div className="row top-gap">
                      <button className="btn" onClick={() => void saveScript(detailTopic)} disabled={busy}>Playbook speichern</button>
                      <span className="subtle">Das Playbook wird gespeichert und sofort von Gloria für neue Gespräche verwendet.</span>
                    </div>
                    {saveStatus ? (
                      <p
                        className="subtle"
                        role="status"
                        style={{
                          marginTop: 8,
                          color: saveStatus.type === "success" ? "#1f7a42" : "#b42318",
                          fontWeight: 700,
                        }}
                      >
                        {saveStatus.message}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="subtle">Für dieses Thema ist noch kein Playbook geladen.</p>
                )}
              </CollapsiblePanel>

              <CollapsiblePanel title="Benutzer & Rufnummern" defaultOpen>
                {currentUser?.role === "master" ? (
                  <>
                    <p className="subtle">Master-Admin Bereich: Benutzer vollständig verwalten – inklusive zugewiesener Rufnummer.</p>

                    <div className="mini-panel top-gap">
                      <h3>Neuen Benutzer anlegen</h3>
                      <div className="field-grid top-gap">
                        <div>
                          <label>Benutzername</label>
                          <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
                        </div>
                        <div>
                          <label>Passwort</label>
                          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                        </div>
                        <div>
                          <label>Vollständiger Name</label>
                          <input value={newRealName} onChange={(event) => setNewRealName(event.target.value)} />
                        </div>
                        <div>
                          <label>Firmenname</label>
                          <input value={newCompanyName} onChange={(event) => setNewCompanyName(event.target.value)} />
                        </div>
                        <div className="full-row">
                          <label>Adresse</label>
                          <input value={newAddress} onChange={(event) => setNewAddress(event.target.value)} placeholder="Straße, PLZ Ort" />
                        </div>
                        <div>
                          <label>E-Mail</label>
                          <input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
                        </div>
                        <div>
                          <label>Reale Rufnummer</label>
                          <input value={newRealPhone} onChange={(event) => setNewRealPhone(event.target.value)} placeholder="+49..." />
                        </div>
                        <div>
                          <label>Gesellschaft</label>
                          <input value={newGesellschaft} onChange={(event) => setNewGesellschaft(event.target.value)} placeholder="z. B. Barmenia, Allianz" />
                        </div>
                        <div>
                          <label>Rolle</label>
                          <select value={newRole} onChange={(event) => setNewRole(event.target.value as "master" | "user")}>
                            <option value="user">user</option>
                            <option value="master">master</option>
                          </select>
                        </div>
                      </div>
                      <div className="row top-gap">
                        <button className="btn" onClick={() => void createUserByAdmin()} disabled={busy}>Benutzer anlegen</button>
                      </div>
                      <p className="subtle top-gap" style={{ fontSize: "0.8rem" }}>
                        Hinweis: Die zugewiesene Rufnummer (Anrufer-ID) kann nach dem Anlegen über „Bearbeiten" gesetzt werden.
                      </p>
                    </div>

                    <div className="mini-panel top-gap">
                      <h3>Benutzerliste</h3>
                      <table className="top-gap">
                        <thead>
                          <tr>
                            <th>Benutzername</th>
                            <th>Name</th>
                            <th>Firma</th>
                            <th>Adresse</th>
                            <th>E-Mail</th>
                            <th>Reale Rufnummer</th>
                            <th>Zugew. Rufnummer</th>
                            <th>Gesellschaft</th>
                            <th>Rolle</th>
                            <th style={{ width: 1 }}>Aktion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminUsers.map((entry) => {
                            const isEditing = editingUserId === entry.id;
                            const phone = entry.phoneNumbers?.[0];
                            return (
                              <Fragment key={entry.id}>
                                <tr>
                                  <td>{entry.username}</td>
                                  <td>{entry.realName}</td>
                                  <td>{entry.companyName}</td>
                                  <td>{entry.address || <span className="subtle">—</span>}</td>
                                  <td>{entry.email || <span className="subtle">—</span>}</td>
                                  <td>{entry.realPhone || <span className="subtle">—</span>}</td>
                                  <td>{phone ? `${phone.phoneNumber}${phone.label ? ` (${phone.label})` : ""}` : <span className="subtle">—</span>}</td>
                                  <td>{entry.gesellschaft || <span className="subtle">—</span>}</td>
                                  <td>{entry.role}</td>
                                  <td>
                                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                                      <button
                                        className="btn ghost"
                                        onClick={() => (isEditing ? cancelEditUser() : startEditUser(entry))}
                                        disabled={busy}
                                      >
                                        {isEditing ? "Abbrechen" : "Bearbeiten"}
                                      </button>
                                      <button
                                        className="btn danger"
                                        onClick={() => void deleteUserByAdmin(entry.id, entry.username)}
                                        disabled={busy || currentUser?.id === entry.id}
                                      >
                                        Löschen
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                                {isEditing && editDraft ? (
                                  <tr>
                                    <td colSpan={10} style={{ background: "var(--surface-soft)" }}>
                                      <div className="field-grid">
                                        <div>
                                          <label>Benutzername</label>
                                          <input value={editDraft.username} onChange={(e) => setEditDraft({ ...editDraft, username: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>Vollständiger Name</label>
                                          <input value={editDraft.realName} onChange={(e) => setEditDraft({ ...editDraft, realName: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>Firmenname</label>
                                          <input value={editDraft.companyName} onChange={(e) => setEditDraft({ ...editDraft, companyName: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>E-Mail</label>
                                          <input type="email" value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} />
                                        </div>
                                        <div className="full-row">
                                          <label>Adresse</label>
                                          <input value={editDraft.address} onChange={(e) => setEditDraft({ ...editDraft, address: e.target.value })} placeholder="Straße, PLZ Ort" />
                                        </div>
                                        <div>
                                          <label>Zugewiesene Rufnummer (Anrufer-ID)</label>
                                          <input value={editDraft.assignedPhone} onChange={(e) => setEditDraft({ ...editDraft, assignedPhone: e.target.value })} placeholder="+49..." />
                                        </div>
                                        <div>
                                          <label>Label</label>
                                          <input value={editDraft.assignedLabel} onChange={(e) => setEditDraft({ ...editDraft, assignedLabel: e.target.value })} placeholder="z. B. Vertrieb" />
                                        </div>
                                        <div>
                                          <label>Reale Rufnummer</label>
                                          <input value={editDraft.realPhone} onChange={(e) => setEditDraft({ ...editDraft, realPhone: e.target.value })} placeholder="+49..." />
                                        </div>
                                        <div>
                                          <label>Gesellschaft</label>
                                          <input value={editDraft.gesellschaft} onChange={(e) => setEditDraft({ ...editDraft, gesellschaft: e.target.value })} placeholder="z. B. Barmenia, Allianz" />
                                        </div>
                                        <div>
                                          <label>Rolle</label>
                                          <select value={editDraft.role} onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as "master" | "user" })} disabled={currentUser?.id === entry.id}>
                                            <option value="user">user</option>
                                            <option value="master">master</option>
                                          </select>
                                        </div>
                                        <div>
                                          <label>Passwort ändern (leer = unverändert)</label>
                                          <input type="password" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} placeholder="Neues Passwort (mind. 6 Zeichen)" />
                                        </div>
                                      </div>
                                      <div className="row top-gap" style={{ gap: 8 }}>
                                        <button className="btn" onClick={() => void saveEditUser(entry)} disabled={busy}>Speichern</button>
                                        <button className="btn ghost" onClick={cancelEditUser} disabled={busy}>Abbrechen</button>
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="subtle">Ihre zugewiesenen Rufnummern:</p>
                    <table className="top-gap">
                      <thead>
                        <tr><th>Label</th><th>Rufnummer</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {managedPhoneNumbers.map((entry) => (
                          <tr key={entry.id}>
                            <td>{entry.label}</td>
                            <td>{entry.phoneNumber}</td>
                            <td>{entry.active ? "aktiv" : "inaktiv"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </CollapsiblePanel>
      </section>
      ) : null}

        </div>
      </main>

      {selectedReport && (() => {
        const conversationLines = buildConversationLines(selectedReport.summary || "");
        const lostStage = selectedReport.outcome !== "Termin" && selectedReport.outcome !== "Wiedervorlage"
          ? detectLostStage(selectedReport.summary || "")
          : null;

        return (
          <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedReport(null)}>✕</button>
              <h2>{selectedReport.company}</h2>
              <div className="row" style={{ marginTop: 8 }}>
                <span className={`status ${selectedReport.outcome === "Absage" ? "absage" : selectedReport.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                  {selectedReport.outcome}
                </span>
                <span className="subtle" style={{ fontSize: "0.85rem" }}>{formatDate(selectedReport.conversationDate)}</span>
              </div>

              <div className="report-detail-grid">
                <div className="report-detail-field">
                  <label>Ansprechpartner</label>
                  <p>{selectedReport.contactName || "–"}</p>
                </div>
                <div className="report-detail-field">
                  <label>Thema</label>
                  <p>{selectedReport.topic}</p>
                </div>
                <div className="report-detail-field">
                  <label>Direkte Durchwahl</label>
                  <p>{selectedReport.directDial || "–"}</p>
                </div>
                <div className="report-detail-field">
                  <label>Gesprächsversuche</label>
                  <p>{selectedReport.attempts}</p>
                </div>
                <div className="report-detail-field">
                  <label>Aufnahme-Einwilligung</label>
                  <p>{selectedReport.recordingConsent ? "Ja" : "Nein"}</p>
                </div>

                {/* Outcome analysis */}
                <div className="report-detail-field report-detail-full">
                  <label>Gesprächsergebnis</label>
                  {selectedReport.outcome === "Termin" ? (
                    <p className="summary-box" style={{ background: "rgba(47,143,87,0.1)", borderColor: "rgba(47,143,87,0.3)" }}>
                      ✓ Termin vereinbart{selectedReport.appointmentAt ? ` am ${formatDate(selectedReport.appointmentAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Wiedervorlage" ? (
                    <p className="summary-box" style={{ background: "rgba(183,135,34,0.12)", borderColor: "rgba(183,135,34,0.3)" }}>
                      ⟳ Wiedervorlage{selectedReport.nextCallAt ? ` – nächster Anruf am ${formatDate(selectedReport.nextCallAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Absage" ? (
                    <p className="summary-box" style={{ background: "rgba(194,77,77,0.1)", borderColor: "rgba(194,77,77,0.3)" }}>
                      ✗ Absage — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  ) : (
                    <p className="summary-box" style={{ background: "rgba(100,120,160,0.08)", borderColor: "rgba(100,120,160,0.2)" }}>
                      – Kein Kontakt — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  )}
                </div>

                {/* Conversation flow */}
                {conversationLines.length > 0 && (
                  <div className="report-detail-field report-detail-full">
                    <label>Gesprächsverlauf</label>
                    <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                      {conversationLines.map((line, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 8,
                            fontSize: "0.88rem",
                            background: line.speaker === "Gloria" ? "rgba(43,101,217,0.07)" : "rgba(32,57,93,0.05)",
                            borderLeft: `3px solid ${line.speaker === "Gloria" ? "var(--blue-500)" : "var(--gold-500)"}`,
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: "0.78rem", color: line.speaker === "Gloria" ? "var(--blue-600)" : "var(--gold-600)" }}>
                            {line.speaker}
                          </span>
                          <br />
                          {line.text}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="report-detail-field report-detail-full">
                  <label>Vollständiges Protokoll (Rohdaten)</label>
                  <pre className="code-box" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                    {selectedReport.summary || "Kein Protokoll vorhanden."}
                  </pre>
                </div>

                {selectedReport.callSid && (
                  <div className="report-detail-field">
                    <label>Call-SID</label>
                    <p style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "#4f6588" }}>{selectedReport.callSid}</p>
                  </div>
                )}
                <div className="report-detail-field">
                  <label>E-Mail-Report an</label>
                  <p>{selectedReport.emailedTo || "–"}</p>
                </div>

                {/* Recording */}
                {selectedReport.recordingConsent && (
                  <div className="report-detail-field report-detail-full">
                    <label>Aufnahme</label>
                    {selectedReport.recordingUrl ? (
                      <div className="row top-gap">
                        <a
                          href={`/api/reports/recording?url=${encodeURIComponent(selectedReport.recordingUrl)}`}
                          target="_blank"
                          rel="noreferrer"
                          className="btn ghost"
                        >Abspielen</a>
                        <a
                          href={`/api/reports/recording?url=${encodeURIComponent(selectedReport.recordingUrl)}&download=1`}
                          download
                          className="btn ghost"
                        >↓ Herunterladen</a>
                        <button
                          className="btn danger"
                          onClick={() => void deleteRecording(selectedReport.id)}
                          disabled={busy}
                        >Aufnahme löschen</button>
                      </div>
                    ) : (
                      <p className="subtle" style={{ marginTop: 6 }}>Keine Aufnahme vorhanden.</p>
                    )}
                  </div>
                )}

                {/* Delete whole report */}
                <div className="report-detail-field report-detail-full" style={{ borderTop: "1px solid var(--mist-200)", paddingTop: 14, marginTop: 4 }}>
                  <button
                    className="btn danger"
                    onClick={() => void deleteReport(selectedReport.id)}
                    disabled={busy}
                  >Report komplett löschen</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
