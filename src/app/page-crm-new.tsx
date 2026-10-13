"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CrmSavedView, CrmUiPreferences, DashboardData, Lead, LeadProductDetail, TopicPolicyConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";
import topicPolicyDefaults from "../../data/topic-policies.json";
import { buildCrmCalendarEntries, buildUnifiedCalendarEntries, getCallSource, getCallWorkspaceData, getCrmWorkspaceLeads, isLeadCustomer, type CrmCalendarEntry, type CrmCampaignTab, type CrmWorkspace } from "@/lib/crm-helpers";
import { parseReportTranscriptFallback } from "@/lib/transcript-utils";
import { saveCalendarCallback } from "@/lib/calendar-view";
import GloriaCalendar from "@/components/GloriaCalendar";

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

type ManualCustomerDraft = {
  company: string;
  contactName: string;
  phone: string;
  email: string;
  topic: Topic;
  owner: "BarmeniaGothaer" | "Agentur-Duic";
  customerKind: "privat" | "firma";
  note: string;
};

type LeadDetailsDraft = Pick<Lead, "company" | "contactName" | "phone" | "directDial" | "email" | "birthDate" | "addressStreet" | "addressPostalCode" | "addressCity" | "addressCountry" | "customerKind" | "customerOwner">;

type PipelineMoveSnapshot = {
  leadId: string;
  leadCompany: string;
  fromStage: string;
  toStage: string;
  expiresAt: number;
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

function escapeCsvCell(value?: string) {
  const normalized = String(value || "").replace(/\r?\n/g, " ").trim();
  return `"${normalized.replace(/"/g, '""')}"`;
}

function reportMatchesLead(
  report: DashboardData["reports"][number],
  lead: DashboardData["leads"][number],
) {
  if (report.leadId) return report.leadId === lead.id;
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

export default function CRMDashboard({ embedded = false }: { embedded?: boolean }) {
  // State Management
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [calendarData, setCalendarData] = useState<DashboardData>(EMPTY_DATA);
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");

  // View & Filter State
  const [activeView, setActiveView] = useState<CrmWorkspace>("dashboard");
  const [campaignTab, setCampaignTab] = useState<CrmCampaignTab>("lists");
  const [showImportForm, setShowImportForm] = useState(false);
  const [detailTab, setDetailTab] = useState<"overview" | "products" | "tasks" | "history" | "communication">("overview");
  const [selectedLead, setSelectedLead] = useState<DashboardData["leads"][number] | null>(null);
  const [selectedReport, setSelectedReport] = useState<DashboardData["reports"][number] | null>(null);
  const [reportTranscript, setReportTranscript] = useState<Array<{ speaker: string; text: string; latencyMs?: number }>>([]);
  const [reportTranscriptLoading, setReportTranscriptLoading] = useState(false);
  const [reportTranscriptError, setReportTranscriptError] = useState("");
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterTopic, setFilterTopic] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOwner, setFilterOwner] = useState<"" | "BarmeniaGothaer" | "Agentur-Duic">("");
  const [filterCustomerKind, setFilterCustomerKind] = useState<"" | "privat" | "firma">("");
  const [filterPipeline, setFilterPipeline] = useState<string>("");
  const [filterContact, setFilterContact] = useState<"" | "mitEmail" | "ohneEmail" | "mitTelefon">("");
  const [filterCampaignListId, setFilterCampaignListId] = useState("");
  const [crmSavedViews, setCrmSavedViews] = useState<CrmSavedView[]>([]);
  const [crmViewNameDraft, setCrmViewNameDraft] = useState("");
  const [crmPrefsReady, setCrmPrefsReady] = useState(false);
  const [leadNoteDraft, setLeadNoteDraft] = useState("");
  const [leadDetailsDraft, setLeadDetailsDraft] = useState<LeadDetailsDraft | null>(null);
  const [productDrafts, setProductDrafts] = useState<LeadProductDetail[]>([]);
  const [newProductDraft, setNewProductDraft] = useState({ category: "", label: "", applicationStatus: "interested" as LeadProductDetail["applicationStatus"], expectedUnits: "", expectedCommissionEUR: "", notes: "" });
  const [leadTaskAssignee, setLeadTaskAssignee] = useState<"user" | "gloria">("user");
  const [conversionKinds, setConversionKinds] = useState<Record<string, "privat" | "firma">>({});
  const [leadTaskTitleDraft, setLeadTaskTitleDraft] = useState("");
  const [leadTaskDueAtDraft, setLeadTaskDueAtDraft] = useState("");
  const [leadPipelineStageDraft, setLeadPipelineStageDraft] = useState("");
  const [outlookSubjectDraft, setOutlookSubjectDraft] = useState("");
  const [outlookBodyDraft, setOutlookBodyDraft] = useState("");
  const [outlookToDraft, setOutlookToDraft] = useState("");
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [draggedLeadId, setDraggedLeadId] = useState<string | null>(null);
  const [pipelineDropStage, setPipelineDropStage] = useState<string>("");
  const [quickPipelineStageByLeadId, setQuickPipelineStageByLeadId] = useState<Record<string, string>>({});
  const [lastPipelineMove, setLastPipelineMove] = useState<PipelineMoveSnapshot | null>(null);
  const [undoTick, setUndoTick] = useState(0);
  const [showAddCustomerForm, setShowAddCustomerForm] = useState(false);
  const [addCustomerDraft, setAddCustomerDraft] = useState<ManualCustomerDraft>({
    company: "",
    contactName: "",
    phone: "",
    email: "",
    topic: TOPICS[0],
    owner: "Agentur-Duic",
    customerKind: "firma",
    note: "",
  });

  // Import & Campaign State
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importListName, setImportListName] = useState("");
  const [importTopic, setImportTopic] = useState<Topic | "">(TOPICS[0]);
  const [campaignLists, setCampaignLists] = useState<CampaignListSummary[]>([]);
  const [runningListIds, setRunningListIds] = useState<string[]>([]);

  // Calendar State
  const [reschedulingEntry, setReschedulingEntry] = useState<CrmCalendarEntry | null>(null);
  const [rescheduleAt, setRescheduleAt] = useState("");
  const crmPrefsLastSavedKeyRef = useRef("");
  const crmPrefsAbortRef = useRef<AbortController | null>(null);
  const pipelineUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contactPanelRef = useRef<HTMLDivElement | null>(null);
  const rescheduleDialogRef = useRef<HTMLFormElement | null>(null);
  const reportPanelRef = useRef<HTMLDivElement | null>(null);
  const selectedLeadId = selectedLead?.id;
  const selectedReportId = selectedReport?.id;
  const reschedulingEntryId = reschedulingEntry?.id;

  useEffect(() => {
    if (!selectedLeadId && !selectedReportId && !reschedulingEntryId) return;
    const panel = reschedulingEntryId ? rescheduleDialogRef.current : selectedReportId ? reportPanelRef.current : contactPanelRef.current;
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusableElements = () => [...panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
    )].filter((element) => element.getClientRects().length > 0);
    document.body.style.overflow = "hidden";
    (focusableElements()[0] || panel).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (reschedulingEntryId) setReschedulingEntry(null);
        else if (selectedReportId) setSelectedReport(null);
        else setSelectedLead(null);
      } else if (event.key === "Tab") {
        const elements = focusableElements();
        const first = elements[0] || panel;
        const last = elements.at(-1) || panel;
        if (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [selectedLeadId, selectedReportId, reschedulingEntryId]);

  useEffect(() => {
    setReportTranscript(parseReportTranscriptFallback(selectedReport?.summary || ""));
    setReportTranscriptError("");
    setReportTranscriptLoading(false);
    if (!selectedReport?.callSid) return;
    const controller = new AbortController();
    setReportTranscriptLoading(true);
    void fetch(`/api/reports/transcript?callSid=${encodeURIComponent(selectedReport.callSid)}`, {
      credentials: "include", signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Gesprächsprotokoll konnte nicht geladen werden (HTTP ${response.status}).`);
      const payload = await response.json() as { events?: typeof reportTranscript };
      if (!controller.signal.aborted && payload.events?.length) setReportTranscript(payload.events);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setReportTranscriptError(error instanceof Error ? error.message : "Gesprächsprotokoll konnte nicht geladen werden.");
    }).finally(() => {
      if (!controller.signal.aborted) setReportTranscriptLoading(false);
    });
    return () => controller.abort();
  }, [selectedReport?.callSid, selectedReport?.summary]);

  // Computed Values
  const calendarEntries = useMemo(() => buildCrmCalendarEntries(data.leads, data.reports), [data.leads, data.reports]);
  const callbacks = useMemo(() => calendarEntries.filter((entry) => entry.kind === "callback"), [calendarEntries]);
  const companyCustomers = useMemo(() => getCrmWorkspaceLeads(data.leads, "companies"), [data.leads]);
  const privateCustomers = useMemo(() => getCrmWorkspaceLeads(data.leads, "private"), [data.leads]);
  const importedLists = useMemo(() => campaignLists.filter((list) =>
    !list.listName.toLowerCase().includes("manuell hinzugefügt"),
  ), [campaignLists]);
  const sharedCalendarEntries = useMemo(() => currentUser ? buildUnifiedCalendarEntries(calendarData, currentUser.id) : [], [calendarData, currentUser]);

  const leadAmpelById = useMemo(() => {
    const map = new Map<string, ReturnType<typeof getLeadStatus>>();
    for (const lead of data.leads || []) {
      const leadReports = (data.reports || []).filter((r) => reportMatchesLead(r, lead));
      map.set(lead.id, getLeadStatus(lead, leadReports));
    }
    return map;
  }, [data.leads, data.reports]);

  const filteredLeads = useMemo(() => {
    let leads = getCrmWorkspaceLeads(data.leads || [], activeView);
    if (filterStatus) {
      leads = leads.filter((l) => l.status === filterStatus);
    }
    if (filterTopic) {
      leads = leads.filter((l) => l.topic === filterTopic);
    }
    if (filterOwner) {
      leads = leads.filter((l) => (l.customerOwner || "") === filterOwner);
    }
    if (filterCustomerKind) {
      leads = leads.filter((l) => (l.customerKind || "") === filterCustomerKind);
    }
    if (filterPipeline) {
      leads = leads.filter((l) => l.crmPipeline?.stage === filterPipeline);
    }
    if (filterContact === "mitEmail") {
      leads = leads.filter((l) => Boolean((l.email || "").trim()));
    }
    if (filterContact === "ohneEmail") {
      leads = leads.filter((l) => !(l.email || "").trim());
    }
    if (filterContact === "mitTelefon") {
      leads = leads.filter((l) => Boolean((l.phone || l.directDial || "").trim()));
    }
    if (activeView === "campaigns" && filterCampaignListId) {
      leads = leads.filter((l) => (l.listId || "legacy") === filterCampaignListId);
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
  }, [activeView, data.leads, filterStatus, filterTopic, filterOwner, filterCustomerKind, filterPipeline, filterContact, filterCampaignListId, searchQuery]);

  const appointmentProspects = useMemo(() => {
    const appointments = new Map<string, { lead: Lead; appointmentAt: string }>();
    for (const report of data.reports || []) {
      if (report.outcome !== "Termin" || !report.appointmentAt) continue;
      const lead = report.leadId
        ? (data.leads || []).find((candidate) => candidate.id === report.leadId)
        : (data.leads || []).find((candidate) => reportMatchesLead(report, candidate));
      if (!lead || isLeadCustomer(lead)) continue;
      const previous = appointments.get(lead.id);
      if (!previous || Date.parse(report.appointmentAt) > Date.parse(previous.appointmentAt)) {
        appointments.set(lead.id, { lead, appointmentAt: report.appointmentAt });
      }
    }
    return [...appointments.values()].sort((a, b) => Date.parse(a.appointmentAt) - Date.parse(b.appointmentAt));
  }, [data.leads, data.reports]);

  const availablePipelineStages = useMemo(() => {
    const defaults = ["neu", "qualifiziert", "angebot", "verhandlung", "gewonnen", "verloren"];
    const dynamic = (data.leads || []).map((lead) => lead.crmPipeline?.stage || "").filter(Boolean);
    return Array.from(new Set([...defaults, ...dynamic])).sort((a, b) => a.localeCompare(b, "de"));
  }, [data.leads]);

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

  const activeCrmTab = activeView === "campaigns" && campaignTab === "followups" ? "callbacks" : activeView === "pipeline" ? "pipeline" : "customers";

  const allFilteredSelected = filteredLeads.length > 0 && filteredLeads.every((lead) => selectedLeadIds.includes(lead.id));
  const undoSecondsLeft = useMemo(() => {
    if (!lastPipelineMove) return 0;
    return Math.max(0, Math.ceil((lastPipelineMove.expiresAt - Date.now()) / 1000));
  }, [lastPipelineMove, undoTick]);

  function navigateWorkspace(workspace: CrmWorkspace, tab: CrmCampaignTab = "lists") {
    setActiveView(workspace);
    setCampaignTab(tab);
    setSearchQuery("");
    setFilterStatus("");
    setFilterTopic("");
    setFilterOwner("");
    setFilterCustomerKind("");
    setFilterPipeline("");
    setFilterContact("");
    setFilterCampaignListId("");
    setSelectedLeadIds([]);
    setShowAddCustomerForm(false);
    setSelectedLead(null);
    setSelectedReport(null);
    if (workspace === "companies" || workspace === "private") {
      setAddCustomerDraft((current) => ({
        ...current,
        company: "", contactName: "",
        customerKind: workspace === "companies" ? "firma" : "privat",
        topic: workspace === "private" ? TOPICS[1] : TOPICS[0],
      }));
    }
  }

  const loadCrmPreferences = useCallback(async () => {
    try {
      const [viewsRes, prefsRes] = await Promise.all([
        fetch("/api/crm/views", { credentials: "include", cache: "no-store" }),
        fetch("/api/crm/preferences", { credentials: "include", cache: "no-store" }),
      ]);

      const viewsPayload = (await viewsRes.json().catch(() => ({}))) as { views?: CrmSavedView[] };
      if (viewsRes.ok) {
        setCrmSavedViews(Array.isArray(viewsPayload.views) ? viewsPayload.views.slice(0, 20) : []);
      }

      const prefsPayload = (await prefsRes.json().catch(() => ({}))) as { preferences?: CrmUiPreferences };
      if (prefsRes.ok && prefsPayload.preferences) {
        const prefs = prefsPayload.preferences;
        if (typeof prefs.crmSearch === "string") setSearchQuery(prefs.crmSearch);
        if (prefs.crmTypeFilter !== undefined) setFilterOwner(prefs.crmTypeFilter || "");
        if (prefs.crmCustomerKindFilter !== undefined) setFilterCustomerKind(prefs.crmCustomerKindFilter || "");
        if (prefs.crmPipelineFilter !== undefined) setFilterPipeline(prefs.crmPipelineFilter || "");
        if (prefs.crmContactFilter !== undefined) setFilterContact(prefs.crmContactFilter || "");
        if (prefs.crmWorkspace) setActiveView(prefs.crmWorkspace);
        if (prefs.crmCampaignTab) setCampaignTab(prefs.crmCampaignTab);
        crmPrefsLastSavedKeyRef.current = JSON.stringify({
          crmTab: prefs.crmTab || "customers",
          crmWorkspace: prefs.crmWorkspace || "dashboard",
          crmCampaignTab: prefs.crmCampaignTab || "lists",
          crmSearch: prefs.crmSearch || "",
          crmTypeFilter: prefs.crmTypeFilter || "",
          crmCustomerKindFilter: prefs.crmCustomerKindFilter || "",
          crmPipelineFilter: prefs.crmPipelineFilter || "",
          crmContactFilter: prefs.crmContactFilter || "",
        });
      }
    } catch {
      // Preference sync is optional for this CRM view.
    } finally {
      setCrmPrefsReady(true);
    }
  }, []);

  async function persistCrmSavedViews(nextViews: CrmSavedView[]) {
    const response = await fetch("/api/crm/views", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ views: nextViews.slice(0, 20) }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; views?: CrmSavedView[] };
    if (!response.ok) {
      throw new Error(payload.error || "CRM-Ansichten konnten nicht gespeichert werden.");
    }
    return Array.isArray(payload.views) ? payload.views.slice(0, 20) : nextViews.slice(0, 20);
  }

  async function persistCrmUiPreferences(nextPreferences: CrmUiPreferences, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await fetch("/api/crm/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ preferences: nextPreferences }),
        signal,
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "CRM-Layout konnte nicht gespeichert werden.");
      }
      return true;
    } catch (error) {
      if (signal?.aborted || error instanceof TypeError) {
        return false;
      }
      throw error;
    }
  }

  async function saveCurrentCrmSearch() {
    const name = crmViewNameDraft.trim() || `Suche ${new Date().toLocaleDateString("de-DE")}`;
    const entry: CrmSavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      search: searchQuery,
      owner: filterOwner,
      customerKind: filterCustomerKind,
      pipelineStage: filterPipeline as CrmSavedView["pipelineStage"],
      contactFilter: filterContact,
      createdAt: new Date().toISOString(),
    };
    const nextViews = [entry, ...crmSavedViews.filter((view) => view.name !== name)].slice(0, 20);
    try {
      const persisted = await persistCrmSavedViews(nextViews);
      setCrmSavedViews(persisted);
      setCrmViewNameDraft("");
      setNotice(`Suche "${name}" gespeichert.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Suche konnte nicht gespeichert werden.");
    }
  }

  function applySavedView(view: CrmSavedView) {
    setSearchQuery(view.search || "");
    setFilterOwner(view.owner || "");
    setFilterCustomerKind(view.customerKind || "");
    setFilterPipeline(view.pipelineStage || "");
    setFilterContact(view.contactFilter || "");
    setNotice(`Suche "${view.name}" geladen.`);
  }

  const reloadLiveData = useCallback(async () => {
    const [dataRes, listsRes] = await Promise.all([
      fetch("/api/reports", { credentials: "include", cache: "no-store" }),
      fetch("/api/campaigns/lists", { credentials: "include", cache: "no-store" }),
    ]);
    if (!dataRes.ok) throw new Error(`CRM-Daten konnten nicht geladen werden (HTTP ${dataRes.status}).`);
    const payload = await dataRes.json() as DashboardData;
    setCalendarData(payload);
    setData(getCallWorkspaceData(payload, "crm"));
    if (listsRes.ok) {
      const payload = (await listsRes.json()) as { lists?: CampaignListSummary[] };
      setCampaignLists(payload.lists || []);
    }
  }, []);

  function toggleLeadSelection(leadId: string, enabled: boolean) {
    setSelectedLeadIds((current) => {
      if (enabled) {
        return current.includes(leadId) ? current : [...current, leadId];
      }
      return current.filter((id) => id !== leadId);
    });
  }

  function toggleSelectAllFiltered(enabled: boolean) {
    if (!enabled) {
      const filteredSet = new Set(filteredLeads.map((lead) => lead.id));
      setSelectedLeadIds((current) => current.filter((id) => !filteredSet.has(id)));
      return;
    }
    const filteredIds = filteredLeads.map((lead) => lead.id);
    setSelectedLeadIds((current) => [...new Set([...current, ...filteredIds])]);
  }

  async function handleDeleteLeads(leadIds: string[]) {
    if (leadIds.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_leads", leadIds }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; removed?: number };
      if (!res.ok) {
        throw new Error(payload.error || "Kontakte konnten nicht gelöscht werden.");
      }
      setSelectedLeadIds((current) => current.filter((id) => !leadIds.includes(id)));
      if (selectedLead && leadIds.includes(selectedLead.id)) {
        setSelectedLead(null);
      }
      await reloadLiveData();
      setNotice(`✓ ${payload.removed ?? leadIds.length} Kontakt(e) gelöscht`);
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteSelectedCustomers() {
    if (selectedLeadIds.length === 0) return;
    if (!confirm(`${selectedLeadIds.length} ausgewählte Kontakte wirklich löschen?`)) {
      return;
    }
    await handleDeleteLeads(selectedLeadIds);
  }

  function handleExportSelectedCustomers() {
    const selected = filteredLeads.filter((lead) => selectedLeadIds.includes(lead.id));
    if (selected.length === 0) {
      setNotice("Bitte zuerst Kontakte auswählen.");
      return;
    }

    const header = [
      "customerOwner",
      "customerKind",
      "company",
      "contactName",
      "phone",
      "email",
      "topic",
      "status",
      "nextCallAt",
      "note",
    ].join(",");

    const rows = selected.map((lead) => [
      escapeCsvCell(lead.customerOwner),
      escapeCsvCell(lead.customerKind),
      escapeCsvCell(lead.company),
      escapeCsvCell(lead.contactName),
      escapeCsvCell(lead.phone || lead.directDial),
      escapeCsvCell(lead.email),
      escapeCsvCell(lead.topic),
      escapeCsvCell(lead.status),
      escapeCsvCell(lead.nextCallAt),
      escapeCsvCell(lead.note),
    ].join(","));

    const csv = `${header}\n${rows.join("\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `crm-export-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setNotice(`✓ ${selected.length} Kontakt(e) exportiert`);
  }

  async function handleAddCustomerManually() {
    const draft = addCustomerDraft;
    if ((draft.customerKind === "firma" ? !draft.company.trim() : !draft.contactName.trim()) || !draft.phone.trim()) {
      setNotice(draft.customerKind === "firma" ? "Firma und Telefonnummer sind Pflichtfelder." : "Name und Telefonnummer sind Pflichtfelder.");
      return;
    }

    const listName = `${draft.owner} | Manuell hinzugefügt`;
    const header = "customerOwner,customerKind,company,contactName,phone,email,topic,note";
    const row = [
      escapeCsvCell(draft.owner),
      escapeCsvCell(draft.customerKind),
      escapeCsvCell(draft.customerKind === "privat" ? draft.contactName : draft.company),
      escapeCsvCell(draft.contactName),
      escapeCsvCell(draft.phone),
      escapeCsvCell(draft.email),
      escapeCsvCell(draft.topic),
      escapeCsvCell(draft.note),
    ].join(",");

    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/import", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: `${header}\n${row}`, listName, lifecycle: "customer" }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; imported?: number };
      if (!res.ok) {
        throw new Error(payload.error || "Kunde konnte nicht angelegt werden.");
      }
      await reloadLiveData();
      setShowAddCustomerForm(false);
      setAddCustomerDraft({
        company: "",
        contactName: "",
        phone: "",
        email: "",
        topic: activeView === "private" ? TOPICS[1] : TOPICS[0],
        owner: "Agentur-Duic",
        customerKind: activeView === "private" ? "privat" : "firma",
        note: "",
      });
      setNotice(`✓ Kunde angelegt (${payload.imported ?? 1} Datensatz)`);
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCompleteCallback(entry: CrmCalendarEntry) {
    const lead = data.leads.find((candidate) => candidate.id === entry.leadId);
    if (!lead) {
      setNotice("Kein passender Lead zur Wiedervorlage gefunden.");
      return;
    }

    setBusy(true);
    try {
      await saveCalendarCallback(entry, lead);
      await reloadLiveData();
      setNotice("✓ Wiedervorlage als erledigt markiert");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }

  function openReschedule(entry: CrmCalendarEntry) {
    const date = new Date(entry.at);
    setRescheduleAt(`${toDateKey(date)}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`);
    setReschedulingEntry(entry);
  }

  async function handleRescheduleCallback() {
    if (!reschedulingEntry) return;
    const entry = reschedulingEntry;
    const lead = data.leads.find((candidate) => candidate.id === entry.leadId);
    if (!lead) {
      setNotice("Kein passender Lead zur Wiedervorlage gefunden.");
      return;
    }

    const parsed = new Date(rescheduleAt);
    if (Number.isNaN(parsed.getTime())) {
      setNotice("Ungültiges Datum für die Wiedervorlage.");
      return;
    }

    setBusy(true);
    try {
      await saveCalendarCallback(entry, lead, parsed.toISOString());
      await reloadLiveData();
      setReschedulingEntry(null);
      setNotice("✓ Wiedervorlage verschoben");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }

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
      await reloadLiveData();
    } catch (error) {
      setNotice(`✗ Import-Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [importFile, importListName, importTopic, reloadLiveData]);

  const handleSaveNote = useCallback(async (leadId: string, note: string) => {
    if (!selectedLead) return;
    if (!note.trim()) {
      setNotice("✗ Bitte zuerst eine Notiz eingeben.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add_lead_note", leadId, note }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: DashboardData["leads"][number] };
      if (!res.ok || !payload.lead) {
        throw new Error(payload.error || "Notiz konnte nicht gespeichert werden.");
      }
      const updatedLead = payload.lead;
      setData((current) => ({
        ...current,
        leads: current.leads.map((lead) => lead.id === updatedLead.id ? updatedLead : lead),
      }));
      setSelectedLead(updatedLead);
      setLeadNoteDraft("");
      setNotice("✓ Notiz gespeichert");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [selectedLead]);

  const updateSelectedLead = useCallback(async (updates: Partial<Lead>, successMessage: string) => {
    if (!selectedLead) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_lead_details", leadId: selectedLead.id, updates }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: Lead };
      if (!res.ok || !payload.lead) throw new Error(payload.error || "Änderungen konnten nicht gespeichert werden.");
      setData((current) => ({ ...current, leads: current.leads.map((lead) => lead.id === payload.lead!.id ? payload.lead! : lead) }));
      setSelectedLead(payload.lead);
      setNotice(`✓ ${successMessage}`);
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [selectedLead]);

  const handleSaveProducts = useCallback(() => {
    void updateSelectedLead({
      productDetails: productDrafts,
      products: productDrafts.map((product) => product.label),
    }, "Produkte gespeichert");
  }, [productDrafts, updateSelectedLead]);

  const handleAddProduct = useCallback(() => {
    const category = newProductDraft.category.trim();
    if (!category) {
      setNotice("✗ Bitte eine Produktkategorie eintragen.");
      return;
    }
    const product: LeadProductDetail = {
      id: `product-${Date.now()}`,
      category,
      label: newProductDraft.label.trim() || category,
      applicationStatus: newProductDraft.applicationStatus,
      expectedUnits: newProductDraft.expectedUnits === "" ? undefined : Number(newProductDraft.expectedUnits),
      expectedCommissionEUR: newProductDraft.expectedCommissionEUR === "" ? undefined : Number(newProductDraft.expectedCommissionEUR),
      notes: newProductDraft.notes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    const nextProducts = [...productDrafts, product];
    setProductDrafts(nextProducts);
    void updateSelectedLead({
      productDetails: nextProducts,
      products: nextProducts.map((entry) => entry.label),
    }, "Produkt hinzugefügt");
    setNewProductDraft({ category: "", label: "", applicationStatus: "interested", expectedUnits: "", expectedCommissionEUR: "", notes: "" });
  }, [newProductDraft, productDrafts, updateSelectedLead]);

  const handleConvertProspect = useCallback(async (lead: Lead) => {
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "convert_to_customer",
          leadId: lead.id,
          updates: { customerKind: conversionKinds[lead.id] || lead.customerKind || "firma" },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: Lead };
      if (!res.ok || !payload.lead) throw new Error(payload.error || "Interessent konnte nicht umgewandelt werden.");
      setData((current) => ({ ...current, leads: current.leads.map((item) => item.id === payload.lead!.id ? payload.lead! : item) }));
      if (selectedLead?.id === payload.lead.id) setSelectedLead(payload.lead);
      setNotice(`✓ ${lead.company} wurde als Kunde gespeichert`);
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [conversionKinds, selectedLead]);

  const handleAddLeadTask = useCallback(async () => {
    if (!selectedLead || !leadTaskTitleDraft.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_lead_task",
          leadId: selectedLead.id,
          task: {
            title: leadTaskTitleDraft,
            topic: selectedLead.topic,
            dueAt: leadTaskDueAtDraft ? new Date(leadTaskDueAtDraft).toISOString() : undefined,
            assignee: leadTaskAssignee,
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: DashboardData["leads"][number] };
      if (!res.ok || !payload.lead) {
        throw new Error(payload.error || "Aufgabe konnte nicht erstellt werden.");
      }
      const updatedLead = payload.lead;
      setData((current) => ({
        ...current,
        leads: current.leads.map((lead) => lead.id === updatedLead.id ? updatedLead : lead),
      }));
      setSelectedLead(updatedLead);
      setLeadTaskTitleDraft("");
      setLeadTaskDueAtDraft("");
      setLeadTaskAssignee("user");
      setNotice("✓ Aufgabe erstellt");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [leadTaskAssignee, leadTaskDueAtDraft, leadTaskTitleDraft, selectedLead]);

  const handleCompleteLeadTask = useCallback(async (taskId: string) => {
    if (!selectedLead) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete_lead_task", leadId: selectedLead.id, taskId }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: DashboardData["leads"][number] };
      if (!res.ok || !payload.lead) {
        throw new Error(payload.error || "Aufgabe konnte nicht abgeschlossen werden.");
      }
      const updatedLead = payload.lead;
      setData((current) => ({
        ...current,
        leads: current.leads.map((lead) => lead.id === updatedLead.id ? updatedLead : lead),
      }));
      setSelectedLead(updatedLead);
      setNotice("✓ Aufgabe abgeschlossen");
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [selectedLead]);

  const clearPipelineUndo = useCallback(() => {
    if (pipelineUndoTimerRef.current) {
      clearTimeout(pipelineUndoTimerRef.current);
      pipelineUndoTimerRef.current = null;
    }
    setLastPipelineMove(null);
  }, []);

  const stageLabel = useCallback((value: string) => value || "ohne Stage", []);

  const rememberPipelineMoveForUndo = useCallback((snapshot: PipelineMoveSnapshot) => {
    if (pipelineUndoTimerRef.current) {
      clearTimeout(pipelineUndoTimerRef.current);
    }
    setLastPipelineMove(snapshot);
    pipelineUndoTimerRef.current = setTimeout(() => {
      setLastPipelineMove(null);
      pipelineUndoTimerRef.current = null;
    }, 5000);
  }, []);

  const updateLeadPipelineStage = useCallback(async (
    leadId: string,
    stage: string,
    options?: { fromStage?: string; createUndo?: boolean; noticePrefix?: string },
  ) => {
    const leadBeforeUpdate = (data.leads || []).find((lead) => lead.id === leadId);
    const fromStage = options?.fromStage ?? String(leadBeforeUpdate?.crmPipeline?.stage || "").trim();
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_lead_details",
          leadId,
          updates: {
            crmPipeline: {
              stage,
              updatedAt: new Date().toISOString(),
            },
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: DashboardData["leads"][number] };
      if (!res.ok || !payload.lead) {
        throw new Error(payload.error || "Pipeline-Stufe konnte nicht gespeichert werden.");
      }
      const updatedLead = payload.lead;
      setData((current) => ({
        ...current,
        leads: current.leads.map((lead) => lead.id === updatedLead.id ? updatedLead : lead),
      }));
      setSelectedLead((current) => (current && current.id === updatedLead.id ? updatedLead : current));
      setQuickPipelineStageByLeadId((current) => {
        const next = { ...current };
        delete next[leadId];
        return next;
      });
      setLeadPipelineStageDraft(updatedLead.crmPipeline?.stage || stage);
      if (options?.createUndo) {
        rememberPipelineMoveForUndo({
          leadId: updatedLead.id,
          leadCompany: updatedLead.company,
          fromStage,
          toStage: stage,
          expiresAt: Date.now() + 5000,
        });
      }
      setNotice(
        `${options?.noticePrefix || "✓ Pipeline-Stufe aktualisiert"}: ${updatedLead.company} (${stageLabel(fromStage)} -> ${stageLabel(stage)})`,
      );
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Pipeline-Update fehlgeschlagen.");
      return false;
    } finally {
      setBusy(false);
    }
  }, [data.leads, rememberPipelineMoveForUndo, stageLabel]);

  const handleUpdatePipelineStage = useCallback(async () => {
    if (!selectedLead || !leadPipelineStageDraft) return;
    const ok = await updateLeadPipelineStage(selectedLead.id, leadPipelineStageDraft, {
      fromStage: String(selectedLead.crmPipeline?.stage || "").trim(),
      createUndo: true,
    });
    if (ok) {
      setNotice("✓ Pipeline-Stufe gespeichert");
    }
  }, [leadPipelineStageDraft, selectedLead, updateLeadPipelineStage]);

  async function handlePipelineDrop(targetStage: string) {
    if (!draggedLeadId) return;
    if (currentUser?.role !== "master") {
      setNotice("Nur Master-User können Pipeline-Stufen ändern.");
      setDraggedLeadId(null);
      setPipelineDropStage("");
      return;
    }

    const lead = (data.leads || []).find((entry) => entry.id === draggedLeadId);
    const currentStage = String(lead?.crmPipeline?.stage || "").trim();
    if (!lead || !targetStage || currentStage === targetStage) {
      setDraggedLeadId(null);
      setPipelineDropStage("");
      return;
    }

    await updateLeadPipelineStage(lead.id, targetStage, { fromStage: currentStage, createUndo: true });
    setDraggedLeadId(null);
    setPipelineDropStage("");
  }

  const handleUndoPipelineMove = useCallback(async () => {
    if (!lastPipelineMove) return;
    const snapshot = lastPipelineMove;
    clearPipelineUndo();
    await updateLeadPipelineStage(snapshot.leadId, snapshot.fromStage, {
      fromStage: snapshot.toStage,
      noticePrefix: "↩ Rückgängig",
    });
  }, [clearPipelineUndo, lastPipelineMove, updateLeadPipelineStage]);

  const handleAddOutlookEmail = useCallback(async () => {
    if (!selectedLead || !outlookSubjectDraft.trim()) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_outlook_email",
          leadId: selectedLead.id,
          email: {
            subject: outlookSubjectDraft,
            body: outlookBodyDraft || undefined,
            to: outlookToDraft || selectedLead.email || undefined,
            sentAt: new Date().toISOString(),
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; lead?: DashboardData["leads"][number] };
      if (!res.ok || !payload.lead) {
        throw new Error(payload.error || "E-Mail-Historie konnte nicht gespeichert werden.");
      }
      const updatedLead = payload.lead;
      setData((current) => ({
        ...current,
        leads: current.leads.map((lead) => lead.id === updatedLead.id ? updatedLead : lead),
      }));
      setSelectedLead(updatedLead);
      setOutlookSubjectDraft("");
      setOutlookBodyDraft("");
      setNotice("✓ Outlook-E-Mail protokolliert");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "E-Mail-Historie fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }, [outlookBodyDraft, outlookSubjectDraft, outlookToDraft, selectedLead]);

  const controlCampaignList = useCallback(async (listId: string, action: "start" | "stop" | "delete") => {
    if (action === "delete" && !window.confirm("Diese Liste und alle zugehörigen Kontakte wirklich löschen?")) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, listId }),
      });

      const result = (await res.json()) as { error?: string; lists?: CampaignListSummary[] };
      if (!res.ok) throw new Error(result.error || "Aktion fehlgeschlagen");
      if (result.lists) setCampaignLists(result.lists);
      setNotice(`✓ Kampagne ${action === "start" ? "gestartet" : action === "stop" ? "gestoppt" : "gelöscht"}`);
      
      // Reload data
      await reloadLiveData();
    } catch (error) {
      setNotice(`✗ Fehler: ${error instanceof Error ? error.message : "Unbekannt"}`);
    } finally {
      setBusy(false);
    }
  }, [reloadLiveData]);

  // Initialization & Polling
  useEffect(() => {
    let cancelled = false;
    let pollInterval: NodeJS.Timeout;

    const load = async () => {
      try {
        const [dataRes, userRes, listsRes] = await Promise.all([
          fetch("/api/reports", { credentials: "include", cache: "no-store" }),
          fetch("/api/auth/me", { credentials: "include" }),
          fetch("/api/campaigns/lists", { credentials: "include", cache: "no-store" }),
        ]);

        if (!dataRes.ok) throw new Error(`CRM-Daten konnten nicht geladen werden (HTTP ${dataRes.status}).`);
        if (!cancelled) {
          const d = await dataRes.json() as DashboardData;
          setCalendarData(d);
          setData(getCallWorkspaceData(d, "crm"));
          
        }

        if (listsRes.ok && !cancelled) {
          const payload = (await listsRes.json()) as { lists?: CampaignListSummary[] };
          setCampaignLists(payload.lists || []);
        }

        if (userRes.ok && !cancelled) {
          const u = await userRes.json() as { user?: SessionUser };
          if (!u.user) throw new Error("Benutzerdaten fehlen in der Antwort.");
          setCurrentUser(u.user);
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
      if (!cancelled) {
        fetch("/api/reports", { credentials: "include", cache: "no-store" })
          .then(r => {
            if (!r.ok) throw new Error(`CRM-Daten konnten nicht geladen werden (HTTP ${r.status}).`);
            return r.json() as Promise<DashboardData>;
          })
          .then(d => { if (!cancelled) { setCalendarData(d); setData(getCallWorkspaceData(d, "crm")); } })
          .catch((error: unknown) => {
            if (!cancelled) setNotice(`Live-Aktualisierung fehlgeschlagen: ${error instanceof Error ? error.message : "Netzwerkfehler"}`);
          });
      }
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(pollInterval);
    };
  }, []);

  useEffect(() => {
    void loadCrmPreferences();
  }, [loadCrmPreferences]);

  useEffect(() => {
    if (!crmPrefsReady) return;

    const snapshot: CrmUiPreferences = {
      crmTab: activeCrmTab,
      crmWorkspace: activeView,
      crmCampaignTab: campaignTab,
      crmSearch: searchQuery,
      crmTypeFilter: filterOwner,
      crmCustomerKindFilter: filterCustomerKind,
      crmPipelineFilter: filterPipeline as CrmUiPreferences["crmPipelineFilter"],
      crmContactFilter: filterContact,
    };
    const nextKey = JSON.stringify(snapshot);
    if (nextKey === crmPrefsLastSavedKeyRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      crmPrefsAbortRef.current?.abort();
      const controller = new AbortController();
      crmPrefsAbortRef.current = controller;
      void persistCrmUiPreferences(snapshot, controller.signal)
        .then((saved) => {
          if (saved) {
            crmPrefsLastSavedKeyRef.current = nextKey;
          }
        })
        .catch(() => undefined);
    }, 800);

    return () => clearTimeout(timer);
  }, [activeCrmTab, activeView, campaignTab, crmPrefsReady, searchQuery, filterOwner, filterCustomerKind, filterPipeline, filterContact]);

  useEffect(() => {
    setLeadNoteDraft("");
    setLeadDetailsDraft(selectedLead ? {
      company: selectedLead.company || "",
      contactName: selectedLead.contactName || "",
      phone: selectedLead.phone || "",
      directDial: selectedLead.directDial || "",
      email: selectedLead.email || "",
      birthDate: selectedLead.birthDate || "",
      addressStreet: selectedLead.addressStreet || "",
      addressPostalCode: selectedLead.addressPostalCode || "",
      addressCity: selectedLead.addressCity || "",
      addressCountry: selectedLead.addressCountry || "",
      customerKind: selectedLead.customerKind,
      customerOwner: selectedLead.customerOwner,
    } : null);
    setProductDrafts(selectedLead
      ? selectedLead.productDetails || (selectedLead.products || []).map((label, index) => ({
        id: `legacy-product-${selectedLead.id}-${index}`,
        category: label,
        label,
        createdAt: new Date(0).toISOString(),
      }))
      : []);
    setLeadTaskTitleDraft("");
    setLeadTaskDueAtDraft("");
    setLeadTaskAssignee("user");
    setLeadPipelineStageDraft(selectedLead?.crmPipeline?.stage || "");
    setOutlookSubjectDraft("");
    setOutlookBodyDraft("");
    setOutlookToDraft(selectedLead?.email || "");
  }, [selectedLead]);

  useEffect(() => {
    const validLeadIds = new Set(filteredLeads.map((lead) => lead.id));
    setSelectedLeadIds((current) => current.filter((id) => validLeadIds.has(id)));
  }, [filteredLeads]);

  useEffect(() => {
    setDetailTab("overview");
  }, [selectedLead?.id]);

  useEffect(() => {
    if (!lastPipelineMove) return;
    const timer = setInterval(() => setUndoTick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [lastPipelineMove]);

  useEffect(() => {
    return () => {
      if (pipelineUndoTimerRef.current) {
        clearTimeout(pipelineUndoTimerRef.current);
      }
    };
  }, []);

  // ========================================================================
  // RENDER FUNCTIONS
  // ========================================================================

  function renderDashboard() {
    const today = toDateKey(new Date());
    const todaysEntries = calendarEntries.filter((entry) => toDateKey(new Date(entry.at)) === today);
    const upcoming = calendarEntries.filter((entry) => Date.parse(entry.at) >= Date.now()).slice(0, 5);
    const overdue = callbacks.filter((entry) => Date.parse(entry.at) < Date.now()).length;
    const openTasks = data.leads.flatMap((lead) => lead.tasks || []).filter((task) => task.status === "open").length;
    const customerCount = data.leads.filter(isLeadCustomer).length;
    const shortcuts: Array<{ title: string; text: string; count: number; workspace: CrmWorkspace; tab?: CrmCampaignTab; icon: string }> = [
      { title: "Kampagnen", text: "Anruflisten importieren und Gloria steuern", count: importedLists.length, workspace: "campaigns", icon: "↗" },
      { title: "Termin-Interessenten", text: "Termine prüfen und Kunden übernehmen", count: appointmentProspects.length, workspace: "campaigns", tab: "prospects", icon: "✓" },
      { title: "Firmenkunden", text: "Unternehmen, Ansprechpartner und Produkte", count: companyCustomers.length, workspace: "companies", icon: "▦" },
      { title: "Privatkunden", text: "Persönliche Daten, Verträge und Betreuung", count: privateCustomers.length, workspace: "private", icon: "◎" },
      { title: "Kalender", text: "Termine und Wiedervorlagen auf einen Blick", count: todaysEntries.length, workspace: "calendar", icon: "▤" },
      { title: "Follow-ups", text: "Offene Rückrufe und Gloria-Aufgaben", count: callbacks.length, workspace: "campaigns", tab: "followups", icon: "↻" },
    ];
    return (
      <div className="dashboard-view">
        <div className="workspace-heading">
          <div><div className="eyebrow">Ihr Arbeitsbereich</div><h2>Alles im Blick. Direkt zur nächsten Aktion.</h2><p>Kampagnen entwickeln Interessenten. Ihr Kundenbestand bleibt davon getrennt.</p></div>
          <span className="date-chip">{new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })}</span>
        </div>
        <section className="kpi-grid">
          <article className="kpi-card primary">
            <div className="kpi-label">Heute geplant</div>
            <div className="kpi-value">{todaysEntries.length}</div>
            <div className="kpi-sub">Termine und Wiedervorlagen</div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">Kundenbestand</div>
            <div className="kpi-value">{customerCount}</div>
            <div className="kpi-sub">{companyCustomers.length} Firmen · {privateCustomers.length} Privat</div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">Zur Übernahme</div>
            <div className="kpi-value">{appointmentProspects.length}</div>
            <div className="kpi-sub">Termin-Interessenten zur Prüfung</div>
          </article>
          <article className="kpi-card">
            <div className="kpi-label">Offene Aufgaben</div>
            <div className="kpi-value">{openTasks}</div>
            <div className="kpi-sub">{overdue} überfällige Wiedervorlagen</div>
          </article>
        </section>
        <section aria-label="Schnellzugriffe" className="shortcut-grid">
          {shortcuts.map((shortcut) => (
            <button className="shortcut-card" key={shortcut.title} onClick={() => navigateWorkspace(shortcut.workspace, shortcut.tab)}>
              <span className="shortcut-icon">{shortcut.icon}</span>
              <span className="shortcut-body"><strong>{shortcut.title}</strong><span>{shortcut.text}</span></span>
              <span className="shortcut-count">{shortcut.count}</span>
            </button>
          ))}
        </section>
        <section className="dashboard-panels">
          <div className="surface">
            <div className="section-heading"><h3>Als Nächstes</h3><button className="btn-small ghost" onClick={() => navigateWorkspace("calendar")}>Zum Kalender →</button></div>
            {upcoming.length ? upcoming.map((entry) => renderCalendarEntry(entry)) : <p className="subtle">Keine kommenden Termine oder Wiedervorlagen geplant.</p>}
          </div>
          <div className="surface">
            <h3>Kampagnen-Ergebnisse</h3>
            <div className="stats-grid">
              <div className="stat"><span>Gespräche / Reports</span><strong>{reportingStats.total}</strong></div>
              <div className="stat"><span>Terminquote</span><strong>{reportingStats.appointmentRate}%</strong></div>
              <div className="stat"><span>Aktive Listen</span><strong>{importedLists.filter((list) => list.active || list.currentlyDialing).length}</strong></div>
            </div>
            <p className="subtle">Die Terminquote misst vereinbarte Termine je erreichtem Kontakt, nicht gewonnene Kunden.</p>
            {data.leads.filter((lead) => isLeadCustomer(lead) && !lead.customerKind).map((lead) => (
              <button key={lead.id} className="btn-small ghost" onClick={() => setSelectedLead(lead)}>Kundentyp ergänzen: {lead.company}</button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  function renderConversions() {
    return (
      <section className="contacts-view">
        <div className="view-header">
          <h3 style={{ margin: 0 }}>Termin-Interessenten</h3>
          <p className="subtle" style={{ marginBottom: 0 }}>
            Vereinbarte Termine werden erst nach Ihrer Bestätigung als Kunden geführt.
          </p>
        </div>
        {appointmentProspects.length === 0 ? (
          <div className="empty-state"><p>Keine offenen Termin-Interessenten.</p></div>
        ) : (
          <div className="contacts-list">
            <table className="contacts-table">
              <thead><tr><th>Firma / Interessent</th><th>Ansprechpartner</th><th>Telefon</th><th>Termin</th><th>Kundentyp</th><th>Aktion</th></tr></thead>
              <tbody>
                {appointmentProspects.map(({ lead, appointmentAt }) => (
                  <tr key={lead.id}>
                    <td><strong>{lead.company}</strong></td>
                    <td>{lead.contactName || "-"}</td>
                    <td>{lead.phone || lead.directDial || "-"}</td>
                    <td>{formatDate(appointmentAt)}</td>
                    <td>
                      <select
                        className="input"
                        value={conversionKinds[lead.id] || lead.customerKind || "firma"}
                        onChange={(event) => setConversionKinds((current) => ({ ...current, [lead.id]: event.target.value as "privat" | "firma" }))}
                      >
                        <option value="firma">Firmenkunde</option>
                        <option value="privat">Privatkunde</option>
                      </select>
                    </td>
                    <td>
                      <button className="btn-small" disabled={busy} onClick={() => void handleConvertProspect(lead)}>
                        Als Kunden übernehmen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    );
  }

  function renderContacts() {
    const isPrivate = activeView === "private";
    const isCustomerWorkspace = activeView === "companies" || isPrivate;
    const forecast = filteredLeads.flatMap((lead) => lead.productDetails || []);
    return (
      <div className="contacts-view">
        <div className="view-header">
          {isCustomerWorkspace ? (
            <div className="workspace-heading">
              <div><div className="eyebrow">Kundenbestand</div><h2>{isPrivate ? "Privatkunden" : "Firmenkunden"}</h2><p>{isPrivate ? "Persönliche Betreuung, Kontaktdaten und private Verträge." : "Unternehmen, Ansprechpartner und betriebliche Produkte verwalten."}</p></div>
              <div className="customer-totals"><strong>{filteredLeads.length} Kunden</strong><span>{forecast.length} Produkte</span><span>{forecast.reduce((sum, product) => sum + (product.expectedCommissionEUR || 0), 0).toLocaleString("de-DE", { style: "currency", currency: "EUR" })} erwartete Provision</span></div>
            </div>
          ) : null}
          <div className="contacts-toolbar">
            <div className="subtle">{isCustomerWorkspace ? "Nur bestätigte Kunden. Kampagnenimporte erscheinen hier nicht automatisch." : "Interessenten dieser Anrufliste"}</div>
            <div className="bulk-actions-row">
              {isCustomerWorkspace ? <button className="btn-small" onClick={() => {
                setAddCustomerDraft((current) => ({ ...current, customerKind: isPrivate ? "privat" : "firma", topic: isPrivate ? TOPICS[1] : TOPICS[0] }));
                setShowAddCustomerForm((value) => !value);
              }}>{showAddCustomerForm ? "Formular schließen" : isPrivate ? "+ Privatkunde" : "+ Firmenkunde"}</button> : null}
              <button className="btn-small ghost" disabled={selectedLeadIds.length === 0} onClick={handleExportSelectedCustomers}>
                Export ({selectedLeadIds.length})
              </button>
              <button className="btn-small danger" disabled={busy || selectedLeadIds.length === 0} onClick={() => void handleDeleteSelectedCustomers()}>
                Löschen ({selectedLeadIds.length})
              </button>
            </div>
          </div>
          {showAddCustomerForm ? (
            <div className="add-customer-panel top-gap">
              <div className="add-customer-grid">
                {!isPrivate ? <label>Firma *<input className="input" aria-label="Firmenname" value={addCustomerDraft.company} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, company: event.target.value }))} /></label> : null}
                <label>{isPrivate ? "Vor- und Nachname *" : "Ansprechpartner"}<input className="input" value={addCustomerDraft.contactName} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, contactName: event.target.value }))} /></label>
                <label>Telefon *<input className="input" type="tel" value={addCustomerDraft.phone} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, phone: event.target.value }))} /></label>
                <label>E-Mail<input className="input" type="email" value={addCustomerDraft.email} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, email: event.target.value }))} /></label>
                <label>Thema<select className="input" value={addCustomerDraft.topic} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, topic: event.target.value as Topic }))}>
                  {TOPICS.map((topic) => (
                    <option key={topic} value={topic}>{topic}</option>
                  ))}
                </select></label>
                <label>Vertriebseinheit<select className="input" value={addCustomerDraft.owner} onChange={(event) => setAddCustomerDraft((current) => ({ ...current, owner: event.target.value as ManualCustomerDraft["owner"] }))}>
                  <option value="Agentur-Duic">Agentur-Duic</option>
                  <option value="BarmeniaGothaer">BarmeniaGothaer</option>
                </select></label>
              </div>
              <textarea
                className="notes-input top-gap"
                placeholder="Notiz"
                value={addCustomerDraft.note}
                onChange={(event) => setAddCustomerDraft((current) => ({ ...current, note: event.target.value }))}
              />
              <div className="detail-actions-row">
                <button className="btn" disabled={busy} onClick={() => void handleAddCustomerManually()}>
                  Kunde speichern
                </button>
              </div>
            </div>
          ) : null}
          <div className="search-filters">
            <input
              type="text"
              placeholder={isPrivate ? "Name, Telefon oder E-Mail suchen …" : "Firma, Ansprechpartner, Telefon oder E-Mail suchen …"}
              aria-label="Kunden und Interessenten durchsuchen"
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
            <select value={filterOwner} onChange={(e) => setFilterOwner(e.target.value as typeof filterOwner)} className="filter-select">
              <option value="">Alle Owner</option>
              <option value="BarmeniaGothaer">BarmeniaGothaer</option>
              <option value="Agentur-Duic">Agentur-Duic</option>
            </select>
            {!isCustomerWorkspace ? <select value={filterCustomerKind} onChange={(e) => setFilterCustomerKind(e.target.value as typeof filterCustomerKind)} className="filter-select">
              <option value="">Alle Kundentypen</option>
              <option value="privat">Privat</option>
              <option value="firma">Firma</option>
            </select> : null}
            <select
              value={filterPipeline}
              onChange={(e) => setFilterPipeline(e.target.value)}
              className="filter-select"
            >
              <option value="">Alle Pipeline-Stufen</option>
              {availablePipelineStages.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
            </select>
            <select
              value={filterContact}
              onChange={(e) => setFilterContact(e.target.value as typeof filterContact)}
              className="filter-select"
            >
              <option value="">Alle Kontaktarten</option>
              <option value="mitEmail">Mit E-Mail</option>
              <option value="ohneEmail">Ohne E-Mail</option>
              <option value="mitTelefon">Mit Telefon</option>
            </select>
            <input
              type="text"
              placeholder="Suche speichern als..."
              value={crmViewNameDraft}
              onChange={(e) => setCrmViewNameDraft(e.target.value)}
              className="input"
            />
            <button className="btn-small ghost" onClick={() => void saveCurrentCrmSearch()}>
              Suche speichern
            </button>
          </div>
          {crmSavedViews.length > 0 ? (
            <div className="saved-views-row">
              {crmSavedViews.map((view) => (
                <button key={view.id} className="saved-view-chip" onClick={() => applySavedView(view)}>
                  {view.name}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="contacts-list">
          {filteredLeads.length === 0 ? (
            <div className="empty-state">
              <p>{isCustomerWorkspace ? "Noch keine Kunden in dieser Auswahl." : "Keine Interessenten in dieser Auswahl."}</p>
              <p className="subtle">{isCustomerWorkspace ? "Kunden manuell anlegen oder im Kampagnen-Reiter „Termin-Interessenten“ übernehmen." : "Prüfen Sie die Filter oder importieren Sie eine Anrufliste."}</p>
            </div>
          ) : (
            <table className="contacts-table">
              <thead>
                <tr>
                  <th className="checkbox-col">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={(event) => toggleSelectAllFiltered(event.target.checked)}
                      aria-label="Alle gefilterten Kontakte auswählen"
                    />
                  </th>
                  <th>{isPrivate ? "Name" : "Firma"}</th>
                  <th>{isPrivate ? "Wohnort" : "Ansprechpartner"}</th>
                  <th>Telefon</th>
                  <th>Email</th>
                  <th>Thema</th>
                  <th>{isCustomerWorkspace ? "Letzter Kontakt" : "Status"}</th>
                  <th>{isCustomerWorkspace ? "Produkte" : "Anrufversuche"}</th>
                  <th>Aktion</th>
                </tr>
              </thead>
              <tbody>
                {filteredLeads.map((lead) => {
                  const status = leadAmpelById.get(lead.id);
                  return (
                    <tr key={lead.id} className="lead-row">
                      <td className="checkbox-col" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedLeadIds.includes(lead.id)}
                          onChange={(event) => toggleLeadSelection(lead.id, event.target.checked)}
                          aria-label={`Kontakt ${lead.company} auswählen`}
                        />
                      </td>
                      <td><strong>{isPrivate ? lead.contactName || lead.company : lead.company}</strong></td>
                      <td>{isPrivate ? lead.addressCity || lead.location || "-" : lead.contactName || "-"}</td>
                      <td>{lead.phone || lead.directDial || "-"}</td>
                      <td>{lead.email || "-"}</td>
                      <td>{lead.topic}</td>
                      <td>
                        <span className={`status-badge ${status?.color}`}>
                          {status?.label}
                        </span>
                      </td>
                      <td>{isCustomerWorkspace ? (lead.productDetails || lead.products || []).length : lead.attempts}</td>
                      <td>
                        <div className="task-actions">
                          <button
                            className="btn-small"
                            onClick={() => setSelectedLead(lead)}
                          >
                            Details
                          </button>
                          {data.reports.some((report) => reportMatchesLead(report, lead)) ? <button className="btn-small ghost" onClick={() => {
                            const report = data.reports.filter((candidate) => reportMatchesLead(candidate, lead)).sort((a, b) => Date.parse(b.conversationDate) - Date.parse(a.conversationDate))[0];
                            if (report) openReportDetail(report);
                          }}>Anrufdetails</button> : null}
                          <button
                            className="btn-small danger"
                            disabled={busy}
                            onClick={() => { if (confirm(`${lead.company} wirklich löschen?`)) void handleDeleteLeads([lead.id]); }}
                          >
                            Löschen
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    );
  }

  function renderLeadDetail() {
    return (
      <div className="detail-overlay" hidden={!selectedLead} onClick={(event) => {
        if (event.target === event.currentTarget) setSelectedLead(null);
      }}>
        {selectedLead && (
          <div ref={contactPanelRef} className="contact-detail-panel" role="dialog" aria-modal="true" tabIndex={-1} aria-label={`Kontaktakte ${selectedLead.contactName || selectedLead.company}`}>
            <div className="detail-header">
              <div><div className="eyebrow">{isLeadCustomer(selectedLead) ? selectedLead.customerKind === "privat" ? "Privatkundenakte" : "Firmenkundenakte" : "Interessentenakte"}</div><h3>{selectedLead.customerKind === "privat" ? selectedLead.contactName || selectedLead.company : selectedLead.company}</h3></div>
              <button aria-label="Kontaktakte schließen" onClick={() => setSelectedLead(null)}>✕</button>
            </div>
            <div className="subnav" aria-label="Kontaktakte">
              {([
                ["overview", "Stammdaten"], ["products", "Produkte & Anträge"], ["tasks", "Aufgaben & Notizen"],
                ["history", "Historie"], ["communication", "Kommunikation"],
              ] as const).map(([tab, label]) => <button key={tab} className={detailTab === tab ? "active" : ""} aria-pressed={detailTab === tab} onClick={() => setDetailTab(tab)}>{label}</button>)}
            </div>
            <div className="detail-body">
              <div className="detail-section" hidden={detailTab !== "overview"}>
                <h4>Stamm- und Kommunikationsdaten bearbeiten</h4>
                {leadDetailsDraft ? (
                  <>
                    <div className="add-customer-grid">
                      {leadDetailsDraft.customerKind !== "privat" ? <label>Firma<input className="input" placeholder="Firmenname" value={leadDetailsDraft.company} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, company: event.target.value } : current)} /></label> : null}
                      <label>{leadDetailsDraft.customerKind === "privat" ? "Vor- und Nachname" : "Ansprechpartner"}<input className="input" value={leadDetailsDraft.contactName} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, contactName: event.target.value } : current)} /></label>
                      <label>Telefon<input className="input" type="tel" value={leadDetailsDraft.phone} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, phone: event.target.value } : current)} /></label>
                      <label>Direktwahl / Mobil<input className="input" type="tel" value={leadDetailsDraft.directDial || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, directDial: event.target.value } : current)} /></label>
                      <label>E-Mail<input className="input" type="email" value={leadDetailsDraft.email || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, email: event.target.value } : current)} /></label>
                      {leadDetailsDraft.customerKind === "privat" ? <label>Geburtsdatum<input className="input" type="date" value={leadDetailsDraft.birthDate || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, birthDate: event.target.value } : current)} /></label> : null}
                      <label>Straße und Hausnummer<input className="input" value={leadDetailsDraft.addressStreet || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, addressStreet: event.target.value } : current)} /></label>
                      <label>PLZ<input className="input" value={leadDetailsDraft.addressPostalCode || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, addressPostalCode: event.target.value } : current)} /></label>
                      <label>Ort<input className="input" value={leadDetailsDraft.addressCity || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, addressCity: event.target.value } : current)} /></label>
                      <label>Land<input className="input" value={leadDetailsDraft.addressCountry || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, addressCountry: event.target.value } : current)} /></label>
                      <label>Kundentyp<select className="input" value={leadDetailsDraft.customerKind || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, customerKind: (event.target.value || undefined) as Lead["customerKind"] } : current)}>
                        <option value="">Kundentyp auswählen</option><option value="firma">Firmenkunde</option><option value="privat">Privatkunde</option>
                      </select></label>
                      <label>Vertriebseinheit<select className="input" value={leadDetailsDraft.customerOwner || ""} onChange={(event) => setLeadDetailsDraft((current) => current ? { ...current, customerOwner: (event.target.value || undefined) as Lead["customerOwner"] } : current)}>
                        <option value="">Vertriebseinheit</option><option value="Agentur-Duic">Agentur-Duic</option><option value="BarmeniaGothaer">BarmeniaGothaer</option>
                      </select></label>
                    </div>
                    <div className="detail-actions-row">
                      <button className="btn" disabled={busy} onClick={() => void updateSelectedLead({ ...leadDetailsDraft, company: leadDetailsDraft.customerKind === "privat" ? leadDetailsDraft.contactName : leadDetailsDraft.company, location: leadDetailsDraft.addressCity || "" }, "Kontaktdaten gespeichert")}>Kontaktdaten speichern</button>
                    </div>
                  </>
                ) : null}
                <div className="subtle top-gap">Kontaktstatus: {isLeadCustomer(selectedLead) ? "Kunde" : "Interessent"} · Thema: {selectedLead.topic}</div>
              </div>

              <div className="detail-section" hidden={detailTab !== "products"}>
                <h4>Produkte, Anträge und erwarteter Absatz</h4>
                {productDrafts.map((product, index) => (
                  <div className="add-customer-grid top-gap" key={product.id}>
                    <input className="input" placeholder="Kategorie" value={product.category} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, category: event.target.value } : item))} />
                    <input className="input" placeholder="Produkt / Tarif" value={product.label} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} />
                    <select className="input" value={product.applicationStatus || "interested"} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, applicationStatus: event.target.value as LeadProductDetail["applicationStatus"] } : item))}>
                      <option value="interested">Interessiert</option><option value="application_submitted">Antrag gestellt</option><option value="active">Aktiv / abgeschlossen</option><option value="rejected">Abgelehnt</option>
                    </select>
                    <input className="input" type="number" min="0" step="1" placeholder="Erwartete Einheiten" value={product.expectedUnits ?? ""} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, expectedUnits: event.target.value === "" ? undefined : Number(event.target.value) } : item))} />
                    <input className="input" type="number" min="0" step="0.01" placeholder="Erwartete Provision (€)" value={product.expectedCommissionEUR ?? ""} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, expectedCommissionEUR: event.target.value === "" ? undefined : Number(event.target.value) } : item))} />
                    <input className="input" placeholder="Produktnotiz" value={product.notes || ""} onChange={(event) => setProductDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, notes: event.target.value } : item))} />
                    <button className="btn-small danger" onClick={() => setProductDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index))}>Entfernen</button>
                  </div>
                ))}
                <div className="detail-actions-row"><button className="btn" disabled={busy} onClick={handleSaveProducts}>Produkte speichern</button></div>
                <div className="add-customer-grid top-gap">
                  <input className="input" placeholder="Produktkategorie *" value={newProductDraft.category} onChange={(event) => setNewProductDraft((current) => ({ ...current, category: event.target.value }))} />
                  <input className="input" placeholder="Produkt / Tarif" value={newProductDraft.label} onChange={(event) => setNewProductDraft((current) => ({ ...current, label: event.target.value }))} />
                  <select className="input" value={newProductDraft.applicationStatus} onChange={(event) => setNewProductDraft((current) => ({ ...current, applicationStatus: event.target.value as LeadProductDetail["applicationStatus"] }))}>
                    <option value="interested">Interessiert</option><option value="application_submitted">Antrag gestellt</option><option value="active">Aktiv / abgeschlossen</option><option value="rejected">Abgelehnt</option>
                  </select>
                  <input className="input" type="number" min="0" step="1" placeholder="Erwartete Einheiten" value={newProductDraft.expectedUnits} onChange={(event) => setNewProductDraft((current) => ({ ...current, expectedUnits: event.target.value }))} />
                  <input className="input" type="number" min="0" step="0.01" placeholder="Erwartete Provision (€)" value={newProductDraft.expectedCommissionEUR} onChange={(event) => setNewProductDraft((current) => ({ ...current, expectedCommissionEUR: event.target.value }))} />
                  <input className="input" placeholder="Notiz" value={newProductDraft.notes} onChange={(event) => setNewProductDraft((current) => ({ ...current, notes: event.target.value }))} />
                </div>
                <div className="detail-actions-row"><button className="btn" disabled={busy || !newProductDraft.category.trim()} onClick={handleAddProduct}>Produkt hinzufügen</button></div>
              </div>

              <div className="detail-section" hidden={detailTab !== "overview"}>
                <h4>CRM-Pipeline</h4>
                <div className="task-form-grid">
                  <select className="input" value={leadPipelineStageDraft} onChange={(event) => setLeadPipelineStageDraft(event.target.value)}>
                    <option value="">Bitte wählen</option>
                    <option value="neu">neu</option>
                    <option value="qualifiziert">qualifiziert</option>
                    <option value="angebot">angebot</option>
                    <option value="verhandlung">verhandlung</option>
                    <option value="gewonnen">gewonnen</option>
                    <option value="verloren">verloren</option>
                  </select>
                  <div className="subtle">Aktuell: {selectedLead.crmPipeline?.stage || "-"}</div>
                  <button className="btn" disabled={busy || !leadPipelineStageDraft} onClick={() => void handleUpdatePipelineStage()}>
                    Pipeline speichern
                  </button>
                </div>
              </div>

              <div className="detail-section" hidden={detailTab !== "history"}>
                <h4>Interaktionshistorie</h4>
                <div className="activity-timeline">
                  {(selectedLead.activities || []).map((activity) => (
                    <div key={activity.id} className="activity-item"><div className="activity-date">{formatDate(activity.createdAt)}</div><div className="activity-content">{activity.message}</div></div>
                  ))}
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
                          {report.nextCallAt ? <div className="subtle">Vereinbarter Rückruf: {formatDate(report.nextCallAt)}</div> : null}
                          <button className="btn-small ghost" onClick={() => openReportDetail(report)}>Anrufdetails</button>
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              <div className="detail-section" hidden={detailTab !== "tasks"}>
                <h4>Notizen</h4>
                {selectedLead.note ? <div className="activity-item"><div className="activity-content">{selectedLead.note}</div></div> : null}
                {(selectedLead.notes || []).map((note) => (
                  <div className="activity-item" key={note.id}>
                    <div className="activity-date">{formatDate(note.createdAt)}</div>
                    <div className="activity-content">{note.text}</div>
                  </div>
                ))}
                <textarea
                  placeholder="Neue Notiz hinzufügen..."
                  className="notes-input"
                  value={leadNoteDraft}
                  onChange={(event) => setLeadNoteDraft(event.target.value)}
                />
                <div className="detail-actions-row">
                  <button className="btn" disabled={busy || !leadNoteDraft.trim()} onClick={() => void handleSaveNote(selectedLead.id, leadNoteDraft)}>
                    Notiz hinzufügen
                  </button>
                </div>
              </div>

              <div className="detail-section" hidden={detailTab !== "tasks"}>
                <h4>Aufgaben</h4>
                <div className="task-form-grid">
                  <input
                    type="text"
                    className="input"
                    placeholder="Neue Aufgabe..."
                    value={leadTaskTitleDraft}
                    onChange={(event) => setLeadTaskTitleDraft(event.target.value)}
                  />
                  <input
                    type="datetime-local"
                    className="input"
                    value={leadTaskDueAtDraft}
                    onChange={(event) => setLeadTaskDueAtDraft(event.target.value)}
                  />
                  <select className="input" value={leadTaskAssignee} onChange={(event) => setLeadTaskAssignee(event.target.value as "user" | "gloria")}>
                    <option value="user">Zuständig: Benutzer</option>
                    <option value="gloria">Gloria einbeziehen</option>
                  </select>
                  <button className="btn" disabled={busy || !leadTaskTitleDraft.trim() || (leadTaskAssignee === "gloria" && !leadTaskDueAtDraft)} onClick={() => void handleAddLeadTask()}>
                    Aufgabe anlegen
                  </button>
                </div>
                {leadTaskAssignee === "gloria" ? <p className="subtle">Gloria ruft zum Fälligkeitszeitpunkt automatisch an. Bitte Datum und Uhrzeit festlegen.</p> : null}
                <div className="tasks-list top-gap">
                  {(selectedLead.tasks || []).length === 0 ? (
                    <p className="subtle">Keine Aufgaben vorhanden</p>
                  ) : (
                    (selectedLead.tasks || []).map((task) => (
                      <div key={task.id} className="task-card compact">
                        <div className="task-content">
                          <strong>{task.title}</strong>
                          <div className="subtle">Zuständig: {task.assignee === "gloria" ? "Gloria" : "Benutzer"}</div>
                          {task.scheduledAt ? <div className="subtle">Anruf von Gloria gestartet: {formatDate(task.scheduledAt)}</div> : null}
                          <div className="subtle">{task.dueAt ? `Fällig: ${formatDate(task.dueAt)}` : "Ohne Fälligkeitsdatum"}</div>
                          <div className="subtle">Status: {task.status === "done" ? "Erledigt" : "Offen"}</div>
                        </div>
                        {task.status !== "done" ? (
                          <div className="task-actions">
                            <button className="btn-small" disabled={busy} onClick={() => void handleCompleteLeadTask(task.id)}>
                              Erledigt
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="detail-section" hidden={detailTab !== "communication"}>
                <h4>Kommunikation</h4>
                <div className="task-form-grid">
                  <input
                    type="text"
                    className="input"
                    placeholder="Betreff"
                    value={outlookSubjectDraft}
                    onChange={(event) => setOutlookSubjectDraft(event.target.value)}
                  />
                  <input
                    type="email"
                    className="input"
                    placeholder="Empfänger"
                    value={outlookToDraft}
                    onChange={(event) => setOutlookToDraft(event.target.value)}
                  />
                  <button className="btn" disabled={busy || !outlookSubjectDraft.trim()} onClick={() => void handleAddOutlookEmail()}>
                    Mail protokollieren
                  </button>
                </div>
                <textarea
                  placeholder="Inhalt / Gesprächsnotiz zur E-Mail"
                  className="notes-input top-gap"
                  value={outlookBodyDraft}
                  onChange={(event) => setOutlookBodyDraft(event.target.value)}
                />
                <div className="activity-timeline top-gap">
                  {(selectedLead.emailHistory || []).length === 0 ? (
                    <p className="subtle">Keine Kommunikationshistorie vorhanden</p>
                  ) : (
                    (selectedLead.emailHistory || []).map((entry) => (
                      <div key={entry.id} className="activity-item">
                        <div className="activity-date">{formatDate(entry.sentAt || entry.createdAt)}</div>
                        <div className="activity-content">
                          <div className="activity-outcome">{entry.source === "outlook" ? "Outlook" : "Gloria"}: {entry.subject}</div>
                          {entry.to ? <div className="activity-summary">An: {entry.to}</div> : null}
                          {entry.body ? <div className="activity-summary">{entry.body}</div> : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  function renderCalendarEntry(entry: CrmCalendarEntry) {
    const lead = data.leads.find((candidate) => candidate.id === entry.leadId);
    const overdue = entry.kind === "callback" && Date.parse(entry.at) < Date.now();
    return (
      <article key={entry.id} className={`agenda-entry ${entry.kind} ${overdue ? "overdue" : ""}`}>
        <div className="agenda-time">{new Date(entry.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}<small>{new Date(entry.at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })}</small></div>
        <div className="agenda-body">
          <span className={`event-label ${entry.kind}`}>{entry.kind === "appointment" ? "Termin" : entry.taskId ? "Gloria-Aufgabe" : "Wiedervorlage"}{overdue ? " · Überfällig" : ""}</span>
          <strong>{lead?.customerKind === "privat" ? entry.contactName || entry.company : entry.company}</strong>
          {entry.contactName && lead?.customerKind !== "privat" ? <span>{entry.contactName}</span> : null}
          <span className="subtle">{entry.topic}{entry.mode ? ` · ${entry.mode}` : ""}</span>
          {entry.taskId ? <span className="subtle">{entry.summary}</span> : null}
          {entry.phone ? <a href={`tel:${entry.phone}`}>{entry.phone}</a> : null}
        </div>
        <div className="task-actions">
          {entry.reportId ? <button className="btn-small ghost" onClick={() => {
            const report = data.reports.find((candidate) => candidate.id === entry.reportId);
            if (report) openReportDetail(report);
          }}>Anrufdetails</button> : null}
          {lead ? <button className="btn-small ghost" onClick={() => setSelectedLead(lead)}>Kontaktakte</button> : null}
          {entry.kind === "callback" && lead ? <>
            <button className="btn-small ghost" disabled={busy} onClick={() => openReschedule(entry)}>Verschieben</button>
            <button className="btn-small" disabled={busy} onClick={() => void handleCompleteCallback(entry)}>Erledigt</button>
          </> : null}
        </div>
      </article>
    );
  }

  function renderCalendar() {
    return (
      <div className="calendar-view">
        <div className="workspace-heading">
          <div><div className="eyebrow">Zeit für Ihre Kontakte</div><h2>Kalender</h2><p>Ihr gemeinsamer Kalender für CRM und manuelle Anrufe.</p></div>
        </div>
        <GloriaCalendar entries={sharedCalendarEntries} leads={calendarData.leads} onOpenReport={(entry) => {
          const report = calendarData.reports.find((candidate) => candidate.id === entry.reportId);
          if (report) openReportDetail(report);
          else setNotice("Der zugehörige Anrufreport ist nicht mehr verfügbar.");
        }} onOpenContact={setSelectedLead} onChanged={reloadLiveData} />
      </div>
    );
  }

  function renderPipeline() {
    return (
      <div className="contacts-view">
        <div className="view-header">
          <h3 style={{ margin: 0 }}>Pipeline-Ansicht</h3>
          <p className="subtle" style={{ marginBottom: 0 }}>Kontakte nach CRM-Pipeline gruppiert.</p>
        </div>
        <div className="pipeline-board">
          {availablePipelineStages.length === 0 ? (
            <div className="empty-state">
              <p>Keine Pipeline-Stufen vorhanden</p>
            </div>
          ) : (
            availablePipelineStages.map((stage) => {
              const stageLeads = filteredLeads.filter((lead) => (lead.crmPipeline?.stage || "neu") === stage);
              return (
                <div
                  key={stage}
                  className={`pipeline-column ${pipelineDropStage === stage ? "drop-target" : ""}`}
                  onDragOver={(event) => {
                    if (!draggedLeadId || busy) return;
                    event.preventDefault();
                    setPipelineDropStage(stage);
                  }}
                  onDragLeave={() => {
                    if (pipelineDropStage === stage) {
                      setPipelineDropStage("");
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    void handlePipelineDrop(stage);
                  }}
                >
                  <div className="pipeline-column-header">
                    <strong>{stage}</strong>
                    <span>{stageLeads.length}</span>
                  </div>
                  <div className="pipeline-column-body">
                    {stageLeads.map((lead) => (
                      <div key={lead.id} className={`pipeline-card-wrap ${draggedLeadId === lead.id ? "dragging" : ""}`}>
                        <button
                          className="pipeline-card"
                          onClick={() => setSelectedLead(lead)}
                          draggable={!busy && currentUser?.role === "master"}
                          onDragStart={() => setDraggedLeadId(lead.id)}
                          onDragEnd={() => {
                            setDraggedLeadId(null);
                            setPipelineDropStage("");
                          }}
                          title={currentUser?.role === "master" ? "Ziehen zum Verschieben der Stage" : "Nur Master-User können Stages ändern"}
                        >
                          <strong>{lead.company}</strong>
                          <span>{lead.contactName || "-"}</span>
                          <small>{lead.topic}</small>
                        </button>
                        <div className="pipeline-quick-controls" onClick={(event) => event.stopPropagation()}>
                          <select
                            className="input"
                            value={quickPipelineStageByLeadId[lead.id] || stage}
                            onChange={(event) => {
                              const nextStage = event.target.value;
                              setQuickPipelineStageByLeadId((current) => ({ ...current, [lead.id]: nextStage }));
                            }}
                            aria-label={`Pipeline-Stufe für ${lead.company}`}
                          >
                            {availablePipelineStages.map((candidateStage) => (
                              <option key={`${lead.id}-${candidateStage}`} value={candidateStage}>{candidateStage}</option>
                            ))}
                          </select>
                          <button
                            className="btn-small ghost"
                            disabled={busy || currentUser?.role !== "master" || (quickPipelineStageByLeadId[lead.id] || stage) === stage}
                            onClick={() => void updateLeadPipelineStage(lead.id, quickPipelineStageByLeadId[lead.id] || stage, {
                              fromStage: stage,
                              createUndo: true,
                            })}
                          >
                            Setzen
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  function openReportDetail(report: DashboardData["reports"][number]) {
    setSelectedLead(null);
    setSelectedReport(report);
  }

  async function deleteCrmReport(report: DashboardData["reports"][number]) {
    const sourceLabel = getCallSource(report, calendarData.leads) === "manual" ? "Manueller Report" : "CRM-Report";
    if (!confirm(`${sourceLabel} für ${report.company} wirklich löschen?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/reports?reportId=${encodeURIComponent(report.id)}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "CRM-Report konnte nicht gelöscht werden.");
      setSelectedReport(null);
      await reloadLiveData();
      setNotice(`✓ ${sourceLabel} gelöscht. Andere Anrufe bleiben unverändert.`);
    } catch (error) {
      setNotice(`✗ ${error instanceof Error ? error.message : "CRM-Report konnte nicht gelöscht werden."}`);
    } finally {
      setBusy(false);
    }
  }

  function renderCrmReports() {
    const listLeadIds = new Set(data.leads.filter((lead) => (lead.listId || "legacy") === filterCampaignListId).map((lead) => lead.id));
    const query = searchQuery.trim().toLowerCase();
    const reports = data.reports.filter((report) => {
      if (filterCampaignListId && (!report.leadId || !listLeadIds.has(report.leadId))) return false;
      return !query || `${report.company} ${report.contactName || ""} ${report.topic} ${report.summary}`.toLowerCase().includes(query);
    }).sort((a, b) => Date.parse(b.conversationDate) - Date.parse(a.conversationDate));
    return (
      <section className="surface">
        <div className="section-heading"><div><h3>CRM-Gesprächsreports</h3><p className="subtle">Anrufe aus Kampagnen, CRM-Wiedervorlagen und Gloria-Aufgaben. Manuelle Einzelanrufe bleiben im Bereich „Anrufe“.</p></div><span className="subtle">{reports.length} Anrufe</span></div>
        <div className="contacts-toolbar">
          <input className="input" aria-label="CRM-Anrufe durchsuchen" placeholder="Kontakt, Thema oder Gespräch durchsuchen" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          <select className="filter-select" aria-label="Anrufe nach Liste filtern" value={filterCampaignListId} onChange={(event) => setFilterCampaignListId(event.target.value)}>
            <option value="">Alle CRM-Anrufe</option>
            {importedLists.map((list) => <option value={list.listId} key={list.listId}>{list.listName}</option>)}
          </select>
        </div>
        {reports.length === 0 ? <p className="empty-state">Keine CRM-Anrufe in dieser Auswahl.</p> : <div className="contacts-list"><table className="contacts-table">
          <thead><tr><th>Kontakt</th><th>Ergebnis</th><th>Gespräch</th><th>Zusammenfassung</th><th>Aktion</th></tr></thead>
          <tbody>{reports.map((report) => <tr key={report.id}>
            <td><strong>{report.company}</strong><div className="subtle">{report.contactName || "Kein Ansprechpartner"}</div><div className="subtle">{report.topic}</div></td>
            <td>{formatOutcomeLabel(report.outcome)}</td><td>{formatDate(report.conversationDate)}</td>
            <td>{report.summary.replace(/---\s*GESPRAECHSPROTOKOLL[\s\S]*$/i, "").slice(0, 220) || "Noch keine Zusammenfassung"}</td>
            <td><button className="btn-small" onClick={() => openReportDetail(report)}>Anrufdetails</button></td>
          </tr>)}</tbody>
        </table></div>}
      </section>
    );
  }

  function renderReportDetail() {
    if (!selectedReport) return null;
    const manual = getCallSource(selectedReport, calendarData.leads) === "manual";
    const sourceLabel = manual ? "Manuelle Anrufdetails" : "CRM-Anrufdetails";
    const lead = calendarData.leads.find((candidate) => candidate.id === selectedReport.leadId)
      || data.leads.find((candidate) => candidate.id === selectedReport.leadId);
    return (
      <div className="detail-overlay" onClick={(event) => { if (event.target === event.currentTarget) setSelectedReport(null); }}>
        <div ref={reportPanelRef} className="contact-detail-panel" role="dialog" aria-modal="true" tabIndex={-1} aria-label={`${sourceLabel} ${selectedReport.company}`}>
          <div className="detail-header"><div><div className="eyebrow">{sourceLabel}</div><h3>{selectedReport.company}</h3></div><button aria-label="Anrufdetails schließen" onClick={() => setSelectedReport(null)}>✕</button></div>
          <div className="detail-body">
            <div className="detail-section"><h4>Gesprächsergebnis</h4>
              <dl className="report-facts"><div><dt>Ansprechpartner</dt><dd>{selectedReport.contactName || "-"}</dd></div><div><dt>Thema</dt><dd>{selectedReport.topic}</dd></div><div><dt>Angerufene Nummer</dt><dd>{selectedReport.calledPhone || selectedReport.directDial || lead?.phone || "-"}</dd></div><div><dt>Datum</dt><dd>{formatDate(selectedReport.conversationDate)}</dd></div><div><dt>Ergebnis</dt><dd>{formatOutcomeLabel(selectedReport.outcome)}</dd></div><div><dt>Versuche</dt><dd>{selectedReport.attempts}</dd></div></dl>
              {selectedReport.appointmentAt ? <p>Termin: {formatDate(selectedReport.appointmentAt)}{selectedReport.appointmentMode ? ` · ${selectedReport.appointmentMode}` : ""}</p> : null}
              {selectedReport.nextCallAt ? <p>Im Gespräch vereinbarter Rückruf: {formatDate(selectedReport.nextCallAt)}</p> : null}
              {lead?.status === "wiedervorlage" && lead.nextCallAt ? <p>Aktuelle Wiedervorlage: {formatDate(lead.nextCallAt)}</p> : null}
              {lead && !manual ? <button className="btn-small ghost" onClick={() => { setSelectedReport(null); setSelectedLead(lead); }}>Kontaktakte öffnen</button> : null}
            </div>
            <div className="detail-section"><h4>Zusammenfassung</h4><p className="report-summary">{selectedReport.summary.replace(/---\s*GESPRAECHSPROTOKOLL[\s\S]*$/i, "").trim() || "Noch keine Zusammenfassung vorhanden."}</p></div>
            <div className="detail-section"><h4>Gesprächsprotokoll</h4>
              {reportTranscriptLoading ? <p className="subtle">Protokoll wird geladen …</p> : null}
              {reportTranscriptError ? <p role="alert">{reportTranscriptError}</p> : null}
              {!reportTranscriptLoading && reportTranscript.length === 0 ? <p className="subtle">Noch kein Wort-für-Wort-Protokoll vorhanden.</p> : null}
              {reportTranscript.map((turn, index) => <div className="activity-item" key={index}><strong>{turn.speaker}</strong><p className="report-summary">{turn.text}</p>{turn.latencyMs !== undefined ? <small className="subtle">Reaktionszeit: {turn.latencyMs} ms</small> : null}</div>)}
            </div>
            {selectedReport.recordingUrl && selectedReport.recordingConsent ? <div className="detail-section"><h4>Aufnahme</h4><audio controls preload="none" src={`/api/reports/recording?url=${encodeURIComponent(selectedReport.recordingUrl)}`} /></div> : null}
            {selectedReport.outcome === "Termin" && selectedReport.callSid ? <div className="detail-section"><h4>Kundenterminbogen</h4><a className="btn-small ghost" href={`/api/export/appointment-form?callSid=${encodeURIComponent(selectedReport.callSid)}`} target="_blank" rel="noreferrer">PDF öffnen</a></div> : null}
            <p className="subtle">E-Mail-Report an: {selectedReport.emailedTo || "-"}</p>
            {selectedReport.callSid ? <p className="subtle">Anruf-ID: {selectedReport.callSid}</p> : null}
            <button className="btn-small danger" disabled={busy} onClick={() => void deleteCrmReport(selectedReport)}>{manual ? "Manuellen Report löschen" : "CRM-Report löschen"}</button>
          </div>
        </div>
      </div>
    );
  }

  function renderCampaigns() {
    const runningListIds = new Set(importedLists.filter((list) => list.active || list.currentlyDialing).map((list) => list.listId));
    const activeLists = importedLists.filter((list) => runningListIds.has(list.listId));
    const completedLists = importedLists.filter((list) => !runningListIds.has(list.listId));

    const renderCampaignList = (list: CampaignListSummary) => {
      const leads = (data.leads || []).filter((lead) => (lead.listId || "legacy") === list.listId);
      const isRunning = runningListIds.has(list.listId);
      const progress = list.total ? Math.round(((list.total - list.pending) / list.total) * 100) : 0;
      return (
        <article key={list.listId} className={`campaign-item ${isRunning ? "campaign-running" : ""}`}>
          <div className="campaign-heading">
            <div>
              <strong>{list.listName}</strong>
              <div className="subtle">{list.total} Kontakte | {list.pending} offen | {list.called} angerufen | {list.appointments} Termine</div>
            </div>
            <span className={`campaign-state ${isRunning ? "running" : "stopped"}`}>{isRunning ? (list.currentlyDialing ? "Gloria ruft an" : "Aktiv") : (list.pending === 0 ? "Beendet" : "Gestoppt")}</span>
          </div>
          <div className="campaign-progress" aria-label={`${progress}% bearbeitet`}><span style={{ width: `${progress}%` }} /></div>
          <div className="campaign-controls">
            <button className="btn-small" disabled={busy || isRunning || list.pending === 0} onClick={() => void controlCampaignList(list.listId, "start")}>Starten</button>
            <button className="btn-small ghost" disabled={busy || !isRunning} onClick={() => void controlCampaignList(list.listId, "stop")}>Stoppen</button>
            <button className="btn-small ghost" onClick={() => { setSearchQuery(""); setFilterCampaignListId(list.listId); }}>Liste öffnen ({leads.length})</button>
            <button className="btn-small ghost" onClick={() => { setSearchQuery(""); setFilterCampaignListId(list.listId); setCampaignTab("calls"); }}>Anrufdetails</button>
          </div>
        </article>
      );
    };

    return (
      <div className="campaigns-view">
        <div className="workspace-heading">
          <div><div className="eyebrow">Von der Liste zum Termin</div><h2>Kampagnen</h2><p>Importierte Anruflisten, Termin-Interessenten und Follow-ups in einem Arbeitsbereich.</p></div>
          <button className="btn" onClick={() => { setCampaignTab("lists"); setFilterCampaignListId(""); setShowImportForm((value) => !value); }}>{showImportForm ? "Import schließen" : "+ Anrufliste importieren"}</button>
        </div>
        <div className="subnav" aria-label="Kampagnenbereiche">
          {([
            ["lists", `Anruflisten (${importedLists.length})`],
            ["prospects", `Termin-Interessenten (${appointmentProspects.length})`],
            ["followups", `Follow-ups (${callbacks.length})`],
            ["calls", `Gesprächsreports (${data.reports.length})`],
          ] as const).map(([tab, label]) => <button key={tab} className={campaignTab === tab ? "active" : ""} aria-pressed={campaignTab === tab} onClick={() => { setCampaignTab(tab); setSelectedLeadIds([]); }}>{label}</button>)}
        </div>
        {campaignTab === "lists" ? <>
        {showImportForm ? renderSettings() : null}
        {filterCampaignListId ? <>
          <div className="list-breadcrumb"><button className="btn-small ghost" onClick={() => { setFilterCampaignListId(""); setSearchQuery(""); }}>← Alle Anruflisten</button><strong>{importedLists.find((list) => list.listId === filterCampaignListId)?.listName || "Anrufliste"}</strong></div>
          {renderContacts()}
        </> : <div className="surface">
        <section className="task-section">
          <div className="section-heading"><h3>Aktive Anruflisten</h3><span className="subtle">Gloria bearbeitet diese Listen automatisch.</span></div>
          {activeLists.length === 0 ? <p className="subtle">Keine aktive Anrufliste.</p> : <div className="campaign-list">{activeLists.map(renderCampaignList)}</div>}
        </section>
        <section className="task-section">
          <div className="section-heading"><h3>Beendete & gestoppte Listen</h3><span className="subtle">Listen können weiterbearbeitet und erneut gestartet werden.</span></div>
          {completedLists.length === 0 ? <p className="subtle">Keine beendeten oder gestoppten Listen.</p> : <div className="campaign-list">{completedLists.map(renderCampaignList)}</div>}
        </section>
        {importedLists.length === 0 ? <div className="empty-state"><h3>Ihre erste Kampagne beginnt mit einer Liste</h3><p>Importieren Sie eine CSV- oder Excel-Datei. Diese Kontakte bleiben Interessenten, bis Sie sie ausdrücklich als Kunden übernehmen.</p><button className="btn" onClick={() => setShowImportForm(true)}>Anrufliste importieren</button></div> : null}
        </div>}
        </> : null}
        {campaignTab === "prospects" ? renderConversions() : null}
        {campaignTab === "calls" ? renderCrmReports() : null}
        {campaignTab === "followups" ? <div className="surface">
        <section className="task-section">
        <div className="section-heading"><h3>Follow-ups & Wiedervorlagen</h3><span className="subtle">Nur offene Rückrufe und noch nicht gestartete Gloria-Aufgaben</span></div>
        {callbacks.length === 0 ? (
          <p className="subtle">Keine ausstehenden Follow-ups</p>
        ) : (
          <div className="tasks-list">
            {callbacks.map(renderCalendarEntry)}
          </div>
        )}
        </section>
        </div> : null}
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="settings-view">
        <section>
          <div className="settings-panel">
            <h3>Anrufliste importieren</h3>
            <p className="subtle">CSV, XLSX oder XLS mit Firma / Name, Telefonnummer und optionalen Kontaktdaten.</p>
            <label>Listenname
            <input
              type="text"
              placeholder="Listenname"
              value={importListName}
              onChange={(e) => setImportListName(e.target.value)}
              className="input"
            />
            </label>
            <label>Gesprächsthema<select className="input" value={importTopic} onChange={(event) => setImportTopic(event.target.value)}>{TOPICS.map((topic) => <option value={topic} key={topic}>{topic}</option>)}</select></label>
            <label>Importdatei
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => setImportFile(e.target.files?.[0] || null)}
              className="input"
            />
            </label>
            <button className="btn" disabled={!importFile || !importListName || busy} onClick={() => void handleFileImport()}>
              Importieren
            </button>
          </div>

        </section>
      </div>
    );
  }

  // ========================================================================
  // RENDER
  // ========================================================================

  if (loading) {
    return (
      <div className={`app-container ${embedded ? "embedded" : ""} loading`}>
        <div className="loading-spinner">
          <p>{notice}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`gloria-crm app-container ${embedded ? "embedded" : ""}`}>
      {lastPipelineMove ? (
        <div className="pipeline-toast" role="status" aria-live="polite">
          <div>
            <strong>{lastPipelineMove.leadCompany}</strong>
            <span> verschoben: {stageLabel(lastPipelineMove.fromStage)} {"->"} {stageLabel(lastPipelineMove.toStage)}</span>
          </div>
          <div className="pipeline-toast-actions">
            <span className="pipeline-toast-timer">{undoSecondsLeft}s</span>
            <button className="btn-small ghost" disabled={busy} onClick={() => void handleUndoPipelineMove()}>Rückgängig</button>
          </div>
        </div>
      ) : null}
      {embedded ? (
        <div className="embedded-hero">
          <div>
            <div className="embedded-kicker">Gloria CRM</div>
            <h2>Kontakte entwickeln. Kunden betreuen.</h2>
            <p>
              Kampagnen, Kundenbestand und Kalender in einem Arbeitsbereich.
            </p>
          </div>
          <div className="embedded-meta">
            <span className="embedded-chip">{companyCustomers.length + privateCustomers.length} Kunden</span>
            <span className="embedded-chip">{importedLists.length} Anruflisten</span>
          </div>
        </div>
      ) : (
        <header className="app-header">
          <div className="header-left">
            <h1>Gloria CRM</h1>
          </div>
          <div className="header-right">
            <span className="user-name">{currentUser?.realName}</span>
          </div>
        </header>
      )}

      <nav className={`app-nav ${embedded ? "embedded" : ""}`} aria-label="CRM-Arbeitsbereiche">
        {([
          ["dashboard", "Dashboard"], ["campaigns", "Kampagnen"], ["companies", "Firmenkunden"],
          ["private", "Privatkunden"], ["calendar", "Kalender"], ["pipeline", "Vertriebspipeline"],
        ] as const).map(([workspace, label]) => (
          <button key={workspace} className={`nav-btn ${activeView === workspace ? "active" : ""}`} aria-current={activeView === workspace ? "page" : undefined} onClick={() => navigateWorkspace(workspace)}>{label}</button>
        ))}
      </nav>
      {notice ? <div className={`crm-notice ${notice.startsWith("✗") ? "error" : ""}`} role="status" aria-live="polite"><span>{notice}</span><button aria-label="Meldung schließen" onClick={() => setNotice("")}>✕</button></div> : null}

      <main className={`app-main ${embedded ? "embedded" : ""}`}>
        {activeView === "dashboard" && renderDashboard()}
        {activeView === "campaigns" && renderCampaigns()}
        {(activeView === "companies" || activeView === "private") && renderContacts()}
        {activeView === "pipeline" && renderPipeline()}
        {activeView === "calendar" && renderCalendar()}
      </main>
      {renderLeadDetail()}
      {renderReportDetail()}
      {reschedulingEntry ? <div className="reschedule-overlay"><form ref={rescheduleDialogRef} role="dialog" aria-modal="true" aria-label="Wiedervorlage verschieben" tabIndex={-1} className="surface reschedule-dialog" onSubmit={(event) => { event.preventDefault(); void handleRescheduleCallback(); }}>
        <h3>Wiedervorlage verschieben</h3><p>{reschedulingEntry.company}</p>
        <label>Neuer Zeitpunkt<input className="input" type="datetime-local" required value={rescheduleAt} onChange={(event) => setRescheduleAt(event.target.value)} /></label>
        <div className="detail-actions-row"><button type="button" className="btn-small ghost" onClick={() => setReschedulingEntry(null)}>Abbrechen</button><button className="btn" disabled={busy || !rescheduleAt}>Speichern</button></div>
      </form></div> : null}

      <style jsx global>{`
        .gloria-crm.app-container {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #f5f7fa;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        .gloria-crm .pipeline-toast {
          position: fixed;
          right: 18px;
          bottom: 18px;
          z-index: 110;
          display: flex;
          gap: 1rem;
          align-items: center;
          justify-content: space-between;
          background: #0f2d4d;
          color: #f3f8ff;
          border: 1px solid #355a83;
          border-radius: 10px;
          padding: 0.7rem 0.85rem;
          min-width: 340px;
          box-shadow: 0 14px 34px rgba(10, 24, 44, 0.34);
        }

        .gloria-crm .pipeline-toast-actions {
          display: flex;
          align-items: center;
          gap: 0.55rem;
        }

        .gloria-crm .pipeline-toast-timer {
          font-size: 0.8rem;
          color: #a9c0dc;
          min-width: 2rem;
          text-align: right;
        }

        .gloria-crm.app-container.embedded {
          height: auto;
          min-height: 100%;
          border-radius: 24px;
          overflow: hidden;
          border: 1px solid rgba(195, 208, 224, 0.9);
          box-shadow: 0 24px 60px rgba(17, 24, 39, 0.08);
        }

        .gloria-crm .embedded-hero {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 1rem;
          padding: 1.4rem 1.5rem 1rem;
          background: linear-gradient(135deg, #f9fbff, #eef4fb 60%, #f5f8fc);
          border-bottom: 1px solid #dde6f0;
        }

        .gloria-crm .embedded-kicker {
          font-size: 0.78rem;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #3b5f8a;
          margin-bottom: 0.4rem;
        }

        .gloria-crm .embedded-hero h2 {
          margin: 0;
          font-size: 1.55rem;
          color: #142235;
        }

        .gloria-crm .embedded-hero p {
          margin: 0.45rem 0 0;
          max-width: 42rem;
          color: #56708f;
          line-height: 1.5;
        }

        .gloria-crm .embedded-meta {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          justify-content: flex-end;
          gap: 0.6rem;
        }

        .gloria-crm .embedded-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.5rem 0.8rem;
          border-radius: 999px;
          background: rgba(255,255,255,0.86);
          border: 1px solid #d9e3ef;
          color: #234264;
          font-size: 0.82rem;
          font-weight: 700;
        }

        .gloria-crm .loading {
          align-items: center;
          justify-content: center;
        }

        .gloria-crm .loading-spinner {
          text-align: center;
        }

        .gloria-crm .app-header {
          background: white;
          border-bottom: 1px solid #e0e4e8;
          padding: 1rem 2rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }

        .gloria-crm .app-header h1 {
          margin: 0;
          font-size: 1.5rem;
          color: #1f2937;
        }

        .gloria-crm .user-name {
          color: #6b7280;
          font-size: 0.9rem;
        }

        .gloria-crm .app-nav {
          background: white;
          border-bottom: 1px solid #e0e4e8;
          display: flex;
          gap: 0.5rem;
          padding: 0 2rem;
          overflow-x: auto;
        }

        .gloria-crm .app-nav.embedded {
          padding: 0.8rem 1.25rem;
          background: #f7fafd;
          border-bottom: 1px solid #e1e9f2;
          gap: 0.4rem;
        }

        .gloria-crm .nav-btn {
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

        .gloria-crm .nav-btn:hover {
          color: #1f2937;
          background: #f3f4f6;
        }

        .gloria-crm .nav-btn.active {
          color: #2563eb;
          border-bottom-color: #2563eb;
        }

        .gloria-crm .app-nav.embedded .nav-btn {
          border-bottom: none;
          border: 1px solid transparent;
          border-radius: 999px;
          padding: 0.75rem 1.05rem;
          background: transparent;
        }

        .gloria-crm .app-nav.embedded .nav-btn.active {
          background: white;
          border-color: #d9e3ef;
          color: #163b68;
          box-shadow: 0 8px 18px rgba(23, 54, 93, 0.08);
        }

        .gloria-crm .app-main {
          flex: 1;
          overflow-y: auto;
          padding: 2rem;
        }

        .gloria-crm.app-container.embedded .app-main {
          min-height: 70vh;
          padding: 1.4rem;
          background: linear-gradient(180deg, #f6f9fc 0%, #f3f7fb 100%);
        }

        .gloria-crm .app-main.embedded {
          overflow-y: visible;
        }

        /* KPI Grid */
        .gloria-crm .kpi-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 1rem;
          margin-bottom: 2rem;
        }

        .gloria-crm .kpi-card {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .kpi-card.primary {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          color: white;
        }

        .gloria-crm .kpi-label {
          font-size: 0.85rem;
          color: #6b7280;
          margin-bottom: 0.5rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .gloria-crm .kpi-card.primary .kpi-label {
          color: rgba(255,255,255,0.8);
        }

        .gloria-crm .kpi-value {
          font-size: 2.5rem;
          font-weight: bold;
          margin-bottom: 0.5rem;
        }

        .gloria-crm .kpi-sub {
          font-size: 0.85rem;
          color: #9ca3af;
        }

        .gloria-crm .kpi-card.primary .kpi-sub {
          color: rgba(255,255,255,0.7);
        }

        /* Contacts View */
        .gloria-crm .contacts-view {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .gloria-crm .view-header {
          background: white;
          padding: 1.5rem;
          border-radius: 16px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .search-filters {
          display: flex;
          gap: 1rem;
          flex-wrap: wrap;
        }

        .gloria-crm .contacts-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          flex-wrap: wrap;
          margin-bottom: 1rem;
        }

        .gloria-crm .bulk-actions-row {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .gloria-crm .add-customer-panel {
          border: 1px solid #dbe4ef;
          border-radius: 10px;
          padding: 1rem;
          background: #f8fbff;
        }

        .gloria-crm .add-customer-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 0.75rem;
        }

        .gloria-crm .search-input, .gloria-crm .filter-select, .gloria-crm .input {
          padding: 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          font-size: 0.9rem;
        }

        .gloria-crm .search-input {
          flex: 1;
          min-width: 200px;
        }

        .gloria-crm .filter-select {
          min-width: 150px;
        }

        .gloria-crm .contacts-table {
          width: 100%;
          background: white;
          border-collapse: collapse;
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .contacts-table thead {
          background: #f9fafb;
          border-bottom: 1px solid #e0e4e8;
        }

        .gloria-crm .contacts-table th {
          padding: 1rem;
          text-align: left;
          font-weight: 600;
          color: #6b7280;
          font-size: 0.85rem;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .gloria-crm .contacts-table td {
          padding: 1rem;
          border-bottom: 1px solid #f0f0f0;
        }

        .gloria-crm .checkbox-col {
          width: 44px;
          text-align: center;
        }

        .gloria-crm .contacts-table tr:hover {
          background: #f9fafb;
        }

        .gloria-crm .status-badge {
          display: inline-block;
          padding: 0.35rem 0.75rem;
          border-radius: 999px;
          font-size: 0.8rem;
          font-weight: 600;
        }

        .gloria-crm .status-badge.success {
          background: #d1fae5;
          color: #065f46;
        }

        .gloria-crm .status-badge.danger {
          background: #fee2e2;
          color: #7f1d1d;
        }

        .gloria-crm .status-badge.warning {
          background: #fef3c7;
          color: #78350f;
        }

        .gloria-crm .status-badge.info {
          background: #dbeafe;
          color: #1e40af;
        }

        .gloria-crm .status-badge.neutral {
          background: #f3f4f6;
          color: #4b5563;
        }

        .gloria-crm .btn-small {
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

        .gloria-crm .btn-small:hover {
          background: #1d4ed8;
        }

        .gloria-crm .btn-small.ghost {
          background: #e5e7eb;
          color: #1f2937;
        }

        .gloria-crm .btn-small.ghost:hover {
          background: #d1d5db;
        }

        .gloria-crm .btn-small.danger {
          background: #dc2626;
        }

        .gloria-crm .btn-small.danger:hover {
          background: #b91c1c;
        }

        /* Contact Detail Panel */
        .gloria-crm .contact-detail-panel {
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

        @media (max-width: 900px) {
          .gloria-crm .embedded-hero {
            flex-direction: column;
          }

          .gloria-crm .embedded-meta {
            justify-content: flex-start;
          }
        }

        .gloria-crm .detail-header {
          padding: 1.5rem;
          border-bottom: 1px solid #e0e4e8;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .gloria-crm .detail-header h3 {
          margin: 0;
          font-size: 1.25rem;
        }

        .gloria-crm .detail-header button {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #9ca3af;
        }

        .gloria-crm .detail-body {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 2rem;
        }

        .gloria-crm .detail-section h4 {
          margin: 0 0 1rem 0;
          color: #1f2937;
          font-size: 0.95rem;
        }

        .gloria-crm .detail-grid {
          display: grid;
          gap: 1rem;
        }

        .gloria-crm .detail-grid > div {
          display: flex;
          flex-direction: column;
        }

        .gloria-crm .detail-grid label {
          font-size: 0.8rem;
          color: #9ca3af;
          text-transform: uppercase;
          margin-bottom: 0.25rem;
          letter-spacing: 0.5px;
        }

        .gloria-crm .detail-grid p {
          margin: 0;
          color: #1f2937;
        }

        .gloria-crm .activity-timeline {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .gloria-crm .activity-item {
          border-left: 2px solid #e0e4e8;
          padding-left: 1rem;
        }

        .gloria-crm .activity-date {
          font-size: 0.8rem;
          color: #9ca3af;
          margin-bottom: 0.25rem;
        }

        .gloria-crm .activity-outcome {
          font-weight: 600;
          color: #1f2937;
          margin-bottom: 0.25rem;
        }

        .gloria-crm .activity-summary {
          font-size: 0.9rem;
          color: #6b7280;
          margin-bottom: 0.25rem;
        }

        .gloria-crm .activity-appointment {
          font-size: 0.85rem;
          color: #2563eb;
          margin-top: 0.5rem;
        }

        .gloria-crm .notes-input {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 6px;
          min-height: 100px;
          font-family: inherit;
          font-size: 0.9rem;
          resize: vertical;
        }

        .gloria-crm .detail-actions-row {
          display: flex;
          justify-content: flex-end;
          margin-top: 0.75rem;
        }

        .gloria-crm .task-form-grid {
          display: grid;
          grid-template-columns: 1.6fr 1fr auto;
          gap: 0.75rem;
          align-items: center;
        }

        .gloria-crm .btn {
          padding: 0.75rem 1.5rem;
          background: #2563eb;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-weight: 500;
          transition: background 0.2s;
        }

        .gloria-crm .btn:hover {
          background: #1d4ed8;
        }

        .gloria-crm .btn:disabled {
          background: #d1d5db;
          cursor: not-allowed;
        }

        /* Calendar */
        .gloria-crm .calendar-view {
          background: white;
          border-radius: 8px;
          padding: 2rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .calendar-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 2rem;
        }

        .gloria-crm .calendar-header button {
          background: none;
          border: none;
          font-size: 1.5rem;
          cursor: pointer;
          color: #6b7280;
          padding: 0.5rem;
        }

        .gloria-crm .calendar-header h3 {
          margin: 0;
          text-transform: capitalize;
        }

        .gloria-crm .calendar-weekdays {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.5rem;
          margin-bottom: 1rem;
        }

        .gloria-crm .weekday {
          text-align: center;
          font-weight: 600;
          color: #6b7280;
          padding: 0.75rem 0;
          font-size: 0.85rem;
        }

        .gloria-crm .calendar-grid {
          display: grid;
          grid-template-columns: repeat(7, 1fr);
          gap: 0.5rem;
          margin-bottom: 2rem;
        }

        .gloria-crm .calendar-day {
          aspect-ratio: 1;
          background: #f9fafb;
          border: 1px solid #e0e4e8;
          border-radius: 6px;
          padding: 0.5rem;
          cursor: pointer;
          transition: all 0.2s;
        }

        .gloria-crm .calendar-day:hover {
          background: #f3f4f6;
          border-color: #2563eb;
        }

        .gloria-crm .calendar-day.other-month {
          background: #fafbfc;
          color: #d1d5db;
        }

        .gloria-crm .calendar-day.has-appointments {
          border-color: #2563eb;
          background: #eff6ff;
        }

        .gloria-crm .day-number {
          font-weight: 600;
          margin-bottom: 0.25rem;
        }

        .gloria-crm .day-appointments {
          display: flex;
          gap: 0.25rem;
          flex-wrap: wrap;
        }

        .gloria-crm .apt-badge {
          font-size: 0.65rem;
          background: #2563eb;
          color: white;
          padding: 0.1rem 0.35rem;
          border-radius: 3px;
        }

        .gloria-crm .apt-badge.callback {
          background: #d97706;
        }

        .gloria-crm .calendar-legend {
          display: flex;
          gap: 1rem;
          margin: 0 0 1rem;
          color: #4b5563;
          font-size: 0.85rem;
        }

        .gloria-crm .calendar-legend span {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
        }

        .gloria-crm .calendar-legend i {
          width: 0.7rem;
          height: 0.7rem;
          border-radius: 2px;
          background: #2563eb;
        }

        .gloria-crm .calendar-legend i.callback {
          background: #d97706;
        }

        .gloria-crm .calendar-detail {
          background: #f9fafb;
          padding: 1rem;
          border-radius: 6px;
        }

        .gloria-crm .calendar-detail h4 {
          margin: 0 0 1rem 0;
        }

        .gloria-crm .appointment-item {
          background: white;
          padding: 1rem;
          border-radius: 6px;
          margin-bottom: 0.75rem;
          border-left: 3px solid #2563eb;
        }

        .gloria-crm .appointment-item.callback {
          border-left-color: #d97706;
        }

        .gloria-crm .calendar-entry-kind {
          color: #2563eb;
          font-size: 0.75rem;
          font-weight: 700;
          text-transform: uppercase;
          margin-bottom: 0.35rem;
        }

        .gloria-crm .appointment-item.callback .calendar-entry-kind {
          color: #b45309;
        }

        .gloria-crm .appointment-item div {
          margin-bottom: 0.25rem;
        }

        /* Tasks */
        .gloria-crm .tasks-view {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .tasks-view h3 {
          margin-top: 0;
        }

        .gloria-crm .tasks-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .gloria-crm .task-card {
          background: #f9fafb;
          border: 1px solid #e0e4e8;
          border-radius: 6px;
          padding: 1rem;
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 1rem;
          align-items: start;
        }

        .gloria-crm .task-card.compact {
          padding: 0.9rem 1rem;
        }

        .gloria-crm .task-date {
          font-weight: 600;
          color: #2563eb;
          min-width: 100px;
        }

        .gloria-crm .task-content {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
        }

        .gloria-crm .task-summary {
          font-size: 0.9rem;
          color: #6b7280;
          margin-top: 0.5rem;
        }

        .gloria-crm .task-actions {
          display: flex;
          gap: 0.5rem;
        }

        .gloria-crm .pipeline-column.drop-target {
          border: 2px dashed #2563eb;
          border-radius: 10px;
          background: #eef5ff;
        }

        .gloria-crm .pipeline-card-wrap {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.35rem;
          border: 1px solid #d8e2ee;
          border-radius: 8px;
          background: #ffffff;
          margin-bottom: 0.55rem;
        }

        .gloria-crm .pipeline-card-wrap.dragging {
          opacity: 0.55;
          transform: scale(0.98);
        }

        .gloria-crm .pipeline-card {
          width: 100%;
          text-align: left;
          border: 1px solid #d8e2ee;
          border-radius: 8px;
          background: #f8fbff;
          padding: 0.75rem;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          cursor: pointer;
        }

        .gloria-crm .pipeline-quick-controls {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 0.5rem;
        }

        @media (max-width: 900px) {
          .gloria-crm .pipeline-toast {
            left: 12px;
            right: 12px;
            min-width: 0;
          }

          .gloria-crm .pipeline-quick-controls {
            grid-template-columns: 1fr;
          }

          .gloria-crm .task-form-grid {
            grid-template-columns: 1fr;
          }
        }

        /* Settings */
        .gloria-crm .settings-view {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .gloria-crm .settings-panel {
          background: white;
          padding: 1.5rem;
          border-radius: 8px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .settings-panel h4 {
          margin-top: 0;
        }

        .gloria-crm .settings-panel input, .gloria-crm .settings-panel select {
          width: 100%;
          margin-bottom: 1rem;
        }

        .gloria-crm .campaign-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .gloria-crm .campaign-item {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0.75rem;
          padding: 1rem;
          background: #f9fafb;
          border-radius: 6px;
          border-left: 3px solid #2563eb;
        }

        .gloria-crm .campaign-running { border-left-color: #16a34a; }

        .gloria-crm .campaign-heading, .gloria-crm .section-heading {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .gloria-crm .campaign-state { font-size: 0.8rem; font-weight: 600; }
        .gloria-crm .campaign-state.running { color: #15803d; }
        .gloria-crm .campaign-state.stopped { color: #6b7280; }

        .gloria-crm .campaign-controls {
          display: flex;
          gap: 0.5rem;
          flex-wrap: wrap;
        }

        .gloria-crm .campaign-leads {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
          gap: 0.5rem;
          border-top: 1px solid #e5e7eb;
          padding-top: 0.75rem;
        }

        .gloria-crm .campaign-lead {
          display: flex;
          justify-content: space-between;
          gap: 0.5rem;
          padding: 0.45rem 0.6rem;
          border: 1px solid #e5e7eb;
          border-radius: 4px;
          background: white;
          color: #374151;
          cursor: pointer;
          text-align: left;
        }

        .gloria-crm .campaign-lead:hover { border-color: #93c5fd; }
        .gloria-crm .task-section { margin-bottom: 2rem; }

        .gloria-crm .subtle {
          color: #9ca3af;
          font-size: 0.9rem;
        }

        .gloria-crm .empty-state {
          text-align: center;
          padding: 3rem;
          color: #9ca3af;
        }

        .gloria-crm .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 1rem;
        }

        .gloria-crm .stat {
          background: white;
          padding: 1rem;
          border-radius: 6px;
          text-align: center;
          box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        }

        .gloria-crm .stat span {
          display: block;
          color: #6b7280;
          font-size: 0.85rem;
          margin-bottom: 0.5rem;
        }

        .gloria-crm .stat strong {
          display: block;
          font-size: 1.75rem;
          color: #2563eb;
        }

        .gloria-crm.app-container { height: auto; min-height: 100vh; color: #172b43; background: #f3f6fa; }
        .gloria-crm h1, .gloria-crm h2, .gloria-crm h3, .gloria-crm h4 { font-family: inherit; }
        .gloria-crm.app-container [hidden] { display: none !important; }
        .gloria-crm.app-container button, .gloria-crm.app-container input, .gloria-crm.app-container select, .gloria-crm.app-container textarea { font: inherit; }
        .gloria-crm.app-container button:focus-visible, .gloria-crm.app-container a:focus-visible, .gloria-crm.app-container input:focus-visible, .gloria-crm.app-container select:focus-visible { outline: 3px solid #60a5fa; outline-offset: 3px; }
        .gloria-crm.app-container button:disabled { cursor: not-allowed; opacity: 0.6; }
        .gloria-crm .app-main { padding: 1.5rem; overflow: visible; }
        .gloria-crm .workspace-heading { display: flex; justify-content: space-between; align-items: center; gap: 1.5rem; margin-bottom: 1.5rem; }
        .gloria-crm .workspace-heading h2 { font-size: 1.6rem; line-height: 1.25; margin: 0.3rem 0 0.5rem; letter-spacing: -0.04em; color: #122c49; }
        .gloria-crm .workspace-heading p { color: #62758b; margin: 0; line-height: 1.6; max-width: 48rem; }
        .gloria-crm .eyebrow { color: #557392; font-size: 0.72rem; font-weight: 750; letter-spacing: 0.09em; text-transform: uppercase; }
        .gloria-crm .date-chip { padding: 0.6rem 0.85rem; background: white; border: 1px solid #dce5ee; border-radius: 8px; font-size: 0.85rem; white-space: nowrap; color: #54697f; }
        .gloria-crm .subtle { color: #61748a; line-height: 1.5; }
        .gloria-crm .surface { background: white; border: 1px solid #dfe7f0; border-radius: 14px; padding: 1.5rem; box-shadow: 0 4px 18px rgba(23,43,67,0.03); }
        .gloria-crm .surface h3 { margin-top: 0; font-size: 1.05rem; }
        .gloria-crm .app-nav, .gloria-crm .app-nav.embedded { padding: 0.6rem 1.25rem; gap: 0.3rem; background: white; }
        .gloria-crm .nav-btn { white-space: nowrap; border-radius: 8px; padding: 0.8rem 1rem; border: none; color: #526780; font-weight: 600; font-size: 0.9rem; }
        .gloria-crm .nav-btn.active { color: #163e6c; background: #eaf1fb; border: none; }
        .gloria-crm .nav-btn:hover { background: #f0f4fa; }
        .gloria-crm .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
        .gloria-crm .kpi-card { border: 1px solid #dfe7f0; border-radius: 12px; box-shadow: none; padding: 1.25rem; }
        .gloria-crm .kpi-sub { color: #61748a; }
        .gloria-crm .kpi-card.primary { background: linear-gradient(130deg,#163e6c,#285b8c); color: white; }
        .gloria-crm .kpi-card.primary .kpi-label, .gloria-crm .kpi-card.primary .kpi-sub { color: #d3e4f5; }
        .gloria-crm .kpi-card.primary .kpi-value { color: white; }
        .gloria-crm .shortcut-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
        .gloria-crm .shortcut-card { display: flex; align-items: center; gap: 1rem; padding: 1.25rem; border: 1px solid #dfe7f0; border-radius: 12px; background: white; text-align: left; cursor: pointer; transition: border-color 0.15s, box-shadow 0.15s; color: #172b43; }
        .gloria-crm .shortcut-card:hover { border-color: #8dabd1; box-shadow: 0 6px 20px rgba(23,43,67,0.07); }
        .gloria-crm .shortcut-icon { display: grid; place-items: center; width: 40px; height: 40px; flex-shrink: 0; border-radius: 10px; background: #edf3fc; color: #255386; font-size: 1.5rem; }
        .gloria-crm .shortcut-body { display: flex; flex-direction: column; gap: 0.35rem; flex: 1; }
        .gloria-crm .shortcut-body strong { font-size: 0.95rem; }
        .gloria-crm .shortcut-body > span { color: #65798e; font-size: 0.8rem; line-height: 1.5; }
        .gloria-crm .shortcut-count { font-size: 1.25rem; font-weight: 700; color: #3d5e83; }
        .gloria-crm .dashboard-panels { display: grid; grid-template-columns: 1.4fr 1fr; gap: 1.25rem; }
        .gloria-crm .stats-grid { grid-template-columns: repeat(auto-fit,minmax(120px,1fr)); }
        .gloria-crm .stat { box-shadow: none; border: 1px solid #edf0f5; background: #f9fbfd; }
        .gloria-crm .crm-notice { display: flex; justify-content: space-between; align-items: center; padding: 0.8rem 1.5rem; background: #edf7f1; color: #235c3e; border-bottom: 1px solid #cce7d7; gap: 1rem; }
        .gloria-crm .crm-notice.error { background: #fff0ee; color: #9f302c; border-color: #f4d0cc; }
        .gloria-crm .crm-notice button { border: none; background: transparent; cursor: pointer; color: inherit; }
        .gloria-crm .subnav { display: flex; flex-wrap: wrap; gap: 0.25rem; padding: 0.4rem; border: 1px solid #e0e7ef; background: #f5f8fc; border-radius: 10px; margin-bottom: 1.5rem; }
        .gloria-crm .subnav button { background: transparent; border: none; padding: 0.7rem 1rem; border-radius: 7px; color: #596f88; cursor: pointer; font-weight: 600; font-size: 0.85rem; }
        .gloria-crm .subnav button.active { background: white; color: #163e6c; box-shadow: 0 1px 5px rgba(23,43,67,0.1); }
        .gloria-crm .subnav.compact { margin: 0; flex-shrink: 0; }
        .gloria-crm .customer-totals { display: flex; flex-direction: column; align-items: flex-end; gap: 0.35rem; color: #61748a; font-size: 0.82rem; }
        .gloria-crm .customer-totals strong { font-size: 1.2rem; color: #173d67; }
        .gloria-crm .contacts-view { border: 1px solid #dfe7f0; border-radius: 14px; overflow: hidden; background: white; }
        .gloria-crm .contacts-list { overflow-x: auto; }
        .gloria-crm .contacts-table th { font-size: 0.73rem; text-transform: uppercase; letter-spacing: 0.04em; color: #61748a; background: #f7f9fc; }
        .gloria-crm .contacts-table td { font-size: 0.88rem; }
        .gloria-crm .contacts-table tbody tr:hover { background: #f7faff; }
        .gloria-crm .input, .gloria-crm .filter-select, .gloria-crm .search-input, .gloria-crm .notes-input { border-color: #d8e2ed; border-radius: 8px; color: #20364e; background: white; min-height: 40px; }
        .gloria-crm .search-filters { gap: 0.65rem; }
        .gloria-crm .search-input { flex: 1; min-width: 240px; }
        .gloria-crm .add-customer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .gloria-crm .add-customer-grid label, .gloria-crm .settings-panel label, .gloria-crm .reschedule-dialog label { font-size: 0.82rem; color: #566e87; display: flex; flex-direction: column; gap: 0.45rem; }
        .gloria-crm .add-customer-grid .input { width: 100%; box-sizing: border-box; }
        .gloria-crm .btn { background: #214f82; border-radius: 8px; font-weight: 600; }
        .gloria-crm .btn:hover { background: #173e6a; }
        .gloria-crm .btn-small { border-radius: 7px; font-size: 0.8rem; white-space: nowrap; }
        .gloria-crm .campaign-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1rem; }
        .gloria-crm .campaign-item { background: #fafcfe; border: 1px solid #dfe7f0; border-left: 4px solid #90a6bd; border-radius: 10px; padding: 1.2rem; }
        .gloria-crm .campaign-running { border-left-color: #249767; }
        .gloria-crm .campaign-heading { align-items: flex-start; }
        .gloria-crm .campaign-heading strong { font-size: 1rem; }
        .gloria-crm .campaign-heading .subtle { font-size: 0.8rem; margin-top: 0.45rem; }
        .gloria-crm .campaign-state { white-space: nowrap; background: #edf1f5; border-radius: 6px; padding: 0.3rem 0.5rem; }
        .gloria-crm .campaign-state.running { background: #e8f6ee; }
        .gloria-crm .campaign-progress { height: 5px; background: #e8eef5; border-radius: 5px; overflow: hidden; }
        .gloria-crm .campaign-progress span { display: block; height: 100%; background: #7197c2; }
        .gloria-crm .list-breadcrumb { display: flex; align-items: center; gap: 1rem; padding: 0.5rem 0 1rem; }
        .gloria-crm .calendar-view { padding: 1.5rem; border: 1px solid #dfe7f0; border-radius: 14px; box-shadow: none; }
        .gloria-crm .calendar-header { margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
        .gloria-crm .calendar-controls { display: flex; align-items: center; gap: 0.5rem; }
        .gloria-crm .calendar-controls h3 { font-size: 1.15rem; min-width: 170px; text-align: center; }
        .gloria-crm .calendar-header .btn-small { font-size: 0.85rem; border: 1px solid #dfe7f0; }
        .gloria-crm .calendar-layout { display: grid; grid-template-columns: minmax(0,1fr) 310px; gap: 1.25rem; align-items: start; }
        .gloria-crm .calendar-month { min-width: 0; }
        .gloria-crm .calendar-weekdays { gap: 0; margin-bottom: 0; }
        .gloria-crm .calendar-grid { gap: 0; margin: 0; border: 1px solid #dde6ef; border-radius: 10px; overflow: hidden; }
        .gloria-crm .calendar-day { aspect-ratio: auto; min-height: 112px; border: none; border-right: 1px solid #e7edf4; border-bottom: 1px solid #e7edf4; border-radius: 0; background: white; padding: 0.5rem; text-align: left; color: #354d66; overflow: hidden; min-width: 0; }
        .gloria-crm .calendar-day.other-month { background: #f9fbfd; color: #98a7b8; }
        .gloria-crm .calendar-day:hover { background: #f5f8fd; }
        .gloria-crm .calendar-day.selected { box-shadow: inset 0 0 0 2px #719aca; background: #f3f7fd; }
        .gloria-crm .day-number { display: inline-flex; align-items: center; justify-content: center; width: 25px; height: 25px; font-size: 0.82rem; border-radius: 50%; }
        .gloria-crm .calendar-day.today .day-number { background: #214f82; color: white; }
        .gloria-crm .day-appointments { display: flex; flex-direction: column; gap: 3px; }
        .gloria-crm .calendar-event { font-size: 0.66rem; line-height: 1.5; border-radius: 3px; padding: 2px 4px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden; display: block; border-left: 2px solid; }
        .gloria-crm .calendar-event.appointment { color: #1d4da0; background: #e8f0ff; border-color: #2563eb; }
        .gloria-crm .calendar-event.callback { color: #9c510a; background: #fff1db; border-color: #d97706; }
        .gloria-crm .calendar-period { display: grid; gap: 0.75rem; overflow-x: auto; padding-bottom: 0.5rem; }
        .gloria-crm .calendar-period-week { grid-template-columns: repeat(7, minmax(210px, 1fr)); }
        .gloria-crm .calendar-period-workweek { grid-template-columns: repeat(5, minmax(210px, 1fr)); }
        .gloria-crm .calendar-period-day { min-width: 0; background: #f8fafc; border: 1px solid #dde6ef; border-radius: 8px; padding: 0.75rem; }
        .gloria-crm .calendar-period-day h4 { margin: 0 0 1rem; }
        .gloria-crm .calendar-period-day h4.today { color: #2563eb; }
        .gloria-crm .calendar-period-week .agenda-entry, .gloria-crm .calendar-period-workweek .agenda-entry { flex-wrap: wrap; gap: 0.5rem; padding: 0.65rem; }
        .gloria-crm .calendar-period .agenda-body { min-width: 0; overflow-wrap: anywhere; }
        .gloria-crm .calendar-period .task-actions { width: 100%; justify-content: flex-start; }
        .gloria-crm .day-appointments small { color: #62758b; font-size: 0.64rem; }
        .gloria-crm .calendar-detail { background: #f7f9fc; border: 1px solid #e0e7ef; border-radius: 10px; padding: 1rem; }
        .gloria-crm .calendar-detail h4 { margin: 0.4rem 0 1rem; font-size: 0.95rem; }
        .gloria-crm .calendar-legend { flex-wrap: wrap; gap: 1rem; }
        .gloria-crm .agenda-entry { display: flex; align-items: flex-start; gap: 1rem; padding: 1rem; border: 1px solid #e2e9f2; border-left: 4px solid #2563eb; border-radius: 8px; background: white; margin-bottom: 0.7rem; }
        .gloria-crm .agenda-entry.callback { border-left-color: #d97706; }
        .gloria-crm .agenda-time { font-size: 0.95rem; font-weight: 700; color: #314e70; min-width: 46px; }
        .gloria-crm .agenda-time small { display: block; font-size: 0.7rem; font-weight: 400; color: #74869a; margin-top: 0.3rem; }
        .gloria-crm .agenda-body { display: flex; flex-direction: column; gap: 0.3rem; flex: 1; min-width: 0; font-size: 0.85rem; overflow-wrap: anywhere; }
        .gloria-crm .agenda-body > strong { color: #223c58; }
        .gloria-crm .agenda-body a { color: #336495; text-decoration: none; }
        .gloria-crm .event-label { font-size: 0.65rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; color: #2563eb; }
        .gloria-crm .event-label.callback { color: #ad620e; }
        .gloria-crm .agenda-entry.overdue .event-label { font-weight: 800; }
        .gloria-crm .agenda-entry .task-actions { flex-wrap: wrap; justify-content: flex-end; }
        .gloria-crm .calendar-detail .agenda-entry { flex-wrap: wrap; padding: 0.85rem; gap: 0.6rem; }
        .gloria-crm .calendar-detail .task-actions { width: 100%; justify-content: flex-start; }
        .gloria-crm .calendar-agenda section { margin: 0 0 1.5rem; }
        .gloria-crm .calendar-agenda h4 { color: #556d85; padding-bottom: 0.75rem; border-bottom: 1px solid #e7edf4; }
        .gloria-crm .detail-overlay, .gloria-crm .reschedule-overlay { position: fixed; inset: 0; background: rgba(13,32,53,0.42); z-index: 120; display: flex; justify-content: flex-end; }
        .gloria-crm .contact-detail-panel { position: relative; height: 100%; width: min(780px,100%); max-width: 100vw; box-shadow: -12px 0 40px rgba(13,32,53,0.18); }
        .gloria-crm .contact-detail-panel .subnav { margin: 1rem 1.5rem 0; }
        .gloria-crm .detail-header { background: #f8fafd; }
        .gloria-crm .detail-body { gap: 1.5rem; }
        .gloria-crm .activity-content { white-space: pre-wrap; }
        .gloria-crm .report-summary { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
        .gloria-crm .report-facts { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 1rem; }
        .gloria-crm .report-facts dt { color: #61748a; font-size: 0.8rem; }
        .gloria-crm .report-facts dd { margin: 0.3rem 0 0; overflow-wrap: anywhere; }
        .gloria-crm audio { max-width: 100%; }
        .gloria-crm .activity-item { border-radius: 8px; }
        .gloria-crm .task-form-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
        .gloria-crm .reschedule-overlay { z-index: 130; align-items: center; justify-content: center; padding: 1rem; }
        .gloria-crm .reschedule-dialog { width: min(420px,100%); }
        .gloria-crm .detail-actions-row { gap: 0.75rem; }
        @media (max-width: 1200px) {
          .gloria-crm .calendar-layout { grid-template-columns: minmax(0,1fr); }
          .gloria-crm .calendar-detail { display: block; }
          .gloria-crm .calendar-detail .agenda-entry { flex-wrap: nowrap; }
          .gloria-crm .calendar-detail .task-actions { width: auto; }
          .gloria-crm .shortcut-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
        }
        @media (max-width: 760px) {
          .gloria-crm .app-main, .gloria-crm .app-main.embedded { padding: 1rem; }
          .gloria-crm .workspace-heading { flex-direction: column; align-items: flex-start; gap: 1rem; }
          .gloria-crm .workspace-heading h2 { font-size: 1.3rem; }
          .gloria-crm .date-chip { display: none; }
          .gloria-crm .kpi-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }
          .gloria-crm .shortcut-grid, .gloria-crm .dashboard-panels, .gloria-crm .campaign-list { grid-template-columns: minmax(0,1fr); }
          .gloria-crm .surface, .gloria-crm .calendar-view { padding: 1rem; }
          .gloria-crm .customer-totals { align-items: flex-start; }
          .gloria-crm .contacts-toolbar, .gloria-crm .section-heading { flex-wrap: wrap; }
          .gloria-crm .calendar-controls h3 { min-width: 0; font-size: 1rem; }
          .gloria-crm .calendar-day { min-height: 85px; padding: 3px; }
          .gloria-crm .calendar-event { font-size: 0; padding: 2px; border-left-width: 3px; }
          .gloria-crm .calendar-event b { font-size: 0.58rem; font-weight: 600; }
          .gloria-crm .calendar-weekdays .weekday { padding: 0.5rem 0; font-size: 0.75rem; }
          .gloria-crm .calendar-detail .agenda-entry, .gloria-crm .agenda-entry { flex-wrap: wrap; }
          .gloria-crm .agenda-entry .task-actions { width: 100%; justify-content: flex-start; }
          .gloria-crm .add-customer-grid, .gloria-crm .task-form-grid { grid-template-columns: minmax(0,1fr); }
          .gloria-crm .subnav button { padding: 0.6rem 0.7rem; font-size: 0.8rem; }
          .gloria-crm .detail-body, .gloria-crm .detail-header { padding: 1rem; }
          .gloria-crm .contact-detail-panel .subnav { margin: 1rem; }
          .gloria-crm .search-input { min-width: 0; width: 100%; }
        }
      `}</style>
    </div>
  );
}
