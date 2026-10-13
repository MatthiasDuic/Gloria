import type { CallReport, CallSource, DashboardData, Lead, LeadProductDetail, LeadTask } from "./types";

export type CrmWorkspace = "dashboard" | "campaigns" | "companies" | "private" | "calendar" | "pipeline";
export type CrmCampaignTab = "lists" | "prospects" | "followups" | "calls";

export function getCallSource(report: Pick<CallReport, "callSource" | "leadId" | "summary">, leads: Lead[] = []): CallSource {
  if (report.callSource) return report.callSource;
  if (/Testanruf ohne CRM-Zuordnung|Manuell im Dashboard/i.test(report.summary)) return "manual";
  if (report.leadId) return leads.find((lead) => lead.id === report.leadId)?.callSource || "crm";
  if (/Kampagnenanruf gestartet|Automatischer Gloria-Aufgabenanruf|Automatischer Wiedervorlage-Anruf/i.test(report.summary)) return "crm";
  return "manual";
}

export function getCallWorkspaceData(data: DashboardData, source: CallSource): DashboardData {
  return {
    ...data,
    leads: data.leads.filter((lead) => (lead.callSource || "crm") === source),
    reports: data.reports.filter((report) => getCallSource(report, data.leads) === source),
  };
}

export function getCrmWorkspaceLeads(leads: Lead[], workspace: CrmWorkspace): Lead[] {
  leads = leads.filter((lead) => lead.callSource !== "manual");
  if (workspace === "companies") return leads.filter((lead) => isLeadCustomer(lead) && lead.customerKind === "firma");
  if (workspace === "private") return leads.filter((lead) => isLeadCustomer(lead) && lead.customerKind === "privat");
  if (workspace === "campaigns") return leads.filter((lead) => !isLeadCustomer(lead));
  return leads;
}

export interface CrmCalendarEntry {
  id: string;
  callSource?: CallSource;
  leadId?: string;
  reportId?: string;
  taskId?: string;
  company: string;
  contactName?: string;
  phone?: string;
  topic: string;
  at: string;
  endAt?: string;
  calendarEventId?: string;
  kind: "appointment" | "callback" | "block";
  mode?: string;
  summary?: string;
}

export function buildCrmCalendarEntries(leads: Lead[], reports: CallReport[]): CrmCalendarEntry[] {
  const entries = new Map<string, CrmCalendarEntry>();
  const byId = new Map(leads.map((lead) => [lead.id, lead]));
  const contactDisplayName = (lead: Lead) => lead.customerKind === "privat" ? lead.contactName || lead.company : lead.company;
  const normalizeIdentity = (value?: string) => (value || "").trim().toLocaleLowerCase("de-DE");
  const orderedReports = [...reports].sort((a, b) => (Date.parse(b.conversationDate) || 0) - (Date.parse(a.conversationDate) || 0));
  const unmatchedCallbacks = new Set<string>();
  const latestReportByLead = new Map<string, CallReport>();
  for (const report of orderedReports) {
    const candidates = report.leadId ? [] : leads.filter((lead) => {
      if (normalizeIdentity(lead.company) !== normalizeIdentity(report.company) || lead.topic !== report.topic) return false;
      const phone = (report.calledPhone || report.directDial || "").replace(/\D/g, "");
      const samePhone = phone && [lead.phone, lead.directDial].some((value) => (value || "").replace(/\D/g, "") === phone);
      return samePhone || (report.contactName && normalizeIdentity(lead.contactName) === normalizeIdentity(report.contactName));
    });
    const lead = report.leadId ? byId.get(report.leadId) : candidates.length === 1 ? candidates[0] : undefined;
    if (lead && !latestReportByLead.has(lead.id)) latestReportByLead.set(lead.id, report);
    const identity = lead?.id || report.leadId || `${normalizeIdentity(report.company)}|${normalizeIdentity(report.contactName)}|${report.topic}`;
    const isAppointment = report.outcome === "Termin";
    const at = isAppointment ? report.appointmentAt : report.nextCallAt;
    const isLatestOutcome = !unmatchedCallbacks.has(identity);
    unmatchedCallbacks.add(identity);
    if (!isAppointment && (lead || report.leadId || !isLatestOutcome || report.outcome !== "Wiedervorlage")) continue;
    if (!at || !Number.isFinite(Date.parse(at))) continue;
    const key = `${isAppointment ? "appointment" : "callback"}|${identity}|${new Date(at).toISOString()}`;
    if (entries.has(key)) continue;
    entries.set(key, {
      id: report.id, reportId: report.id, leadId: lead?.id,
      company: lead ? contactDisplayName(lead) : report.company,
      contactName: lead?.contactName || report.contactName,
      phone: lead?.directDial || lead?.phone || report.calledPhone || report.directDial,
      topic: report.topic, at, kind: isAppointment ? "appointment" : "callback",
      mode: isAppointment ? report.appointmentMode : undefined, summary: report.summary,
    });
  }
  for (const lead of leads) {
    if (lead.status === "wiedervorlage" && lead.nextCallAt && Number.isFinite(Date.parse(lead.nextCallAt))) {
      entries.set(`callback|${lead.id}`, {
        id: `callback-${lead.id}`, leadId: lead.id, reportId: latestReportByLead.get(lead.id)?.id, company: contactDisplayName(lead),
        contactName: lead.contactName, phone: lead.directDial || lead.phone,
        topic: lead.topic, at: lead.nextCallAt, kind: "callback",
      });
    }
    for (const task of lead.tasks || []) {
      if (task.assignee !== "gloria" || task.status !== "open" || task.scheduledAt
        || !task.dueAt || !Number.isFinite(Date.parse(task.dueAt))) continue;
      entries.set(`task|${lead.id}|${task.id}`, {
        id: `task-${lead.id}-${task.id}`, taskId: task.id, leadId: lead.id, company: contactDisplayName(lead),
        contactName: lead.contactName, phone: lead.directDial || lead.phone,
        topic: task.topic || lead.topic, at: task.dueAt, kind: "callback", summary: task.title,
      });
    }
  }
  return [...entries.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function buildUnifiedCalendarEntries(data: DashboardData, userId?: string): CrmCalendarEntry[] {
  const scoped = {
    ...data,
    leads: data.leads.filter((lead) => !userId || !lead.userId || lead.userId === userId),
    reports: data.reports.filter((report) => !userId || !report.userId || report.userId === userId),
  };
  const callEntries = (["crm", "manual"] as const).flatMap((callSource) => {
    const workspace = getCallWorkspaceData(scoped, callSource);
    return buildCrmCalendarEntries(workspace.leads, workspace.reports).map((entry) => ({ ...entry, callSource }));
  });
  const ownEntries: CrmCalendarEntry[] = (data.calendarEvents || [])
    .filter((event) => !userId || event.userId === userId)
    .map((event) => ({
      id: event.id, calendarEventId: event.id, callSource: "manual",
      company: event.title, topic: event.type === "block" ? "Sperrzeit" : "Folgetermin",
      at: event.startAt, endAt: event.endAt, kind: event.type === "block" ? "block" : "appointment",
      summary: event.note,
    }));
  return [...callEntries, ...ownEntries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function isLeadCustomer(lead: Pick<Lead, "lifecycle" | "listName">): boolean {
  return lead.lifecycle === "customer" || (
    lead.lifecycle === undefined && (lead.listName || "").toLowerCase().includes("manuell hinzugefügt")
  );
}

export function isDueGloriaTask(task: Pick<LeadTask, "assignee" | "status" | "dueAt" | "scheduledAt">, now = Date.now()): boolean {
  const dueAt = Date.parse(task.dueAt || "");
  return task.assignee === "gloria"
    && task.status === "open"
    && !task.scheduledAt
    && Number.isFinite(dueAt)
    && dueAt <= now;
}

export type LeadAffiliationRole =
  | "Mitarbeiter"
  | "Geschäftsführer"
  | "Inhaber"
  | "Vorstand"
  | "Beirat"
  | "Kontakt"
  | "Sonstige";

export interface LeadAffiliation {
  id: string;
  companyId?: string;
  companyName: string;
  role: LeadAffiliationRole | string;
  createdAt: string;
}

export interface LeadPersonData {
  customerKind?: "privat" | "firma";
  company?: string;
  contactName?: string;
  birthDate?: string;
  affiliations?: LeadAffiliation[];
}

export function buildEffectiveLeadCompanyName(lead: LeadPersonData): string {
  const trimmedCompany = (lead.company || "").trim();
  if (lead.customerKind === "privat") {
    const trimmedContact = (lead.contactName || "").trim();
    if (trimmedCompany) return trimmedCompany;
    if (trimmedContact) return trimmedContact;
    return "Privatperson";
  }

  return trimmedCompany || "Neue Firma";
}

export function resolveLeadCompanyValue(lead: LeadPersonData): string {
  if (lead.customerKind === "privat") {
    return buildEffectiveLeadCompanyName(lead);
  }
  return (lead.company || "").trim() || "Neue Firma";
}

export function normalizeLeadAffiliationRole(rawRole?: string): LeadAffiliationRole | string {
  const cleaned = (rawRole || "").trim();
  if (!cleaned) return "Mitarbeiter";

  const lower = cleaned.toLowerCase();
  if (lower.includes("geschaeftsfuehrer") || lower.includes("geschäftsführer") || lower.includes("ceo") || lower.includes("leiter")) {
    return "Geschäftsführer";
  }
  if (lower.includes("inhaber") || lower.includes("eigentuemer") || lower.includes("owner")) {
    return "Inhaber";
  }
  if (lower.includes("vorstand")) return "Vorstand";
  if (lower.includes("beirat")) return "Beirat";
  if (lower.includes("kontakt")) return "Kontakt";
  if (lower.includes("mitarbeiter")) return "Mitarbeiter";
  return cleaned;
}

export function normalizeLeadBirthDate(rawValue?: string): string | undefined {
  const value = (rawValue || "").trim();
  if (!value) return undefined;

  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (isoMatch) return value;

  const germanMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(value);
  if (germanMatch) {
    const [, day, month, yearRaw] = germanMatch;
    const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return value;
}

export function buildLeadProductRecord(input: Partial<LeadProductDetail> & { category: string; label?: string }): LeadProductDetail {
  const category = String(input.category || "").trim() || "Sonstige";
  const label = String(input.label || category).trim() || category;
  return {
    id: input.id || `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    label,
    insurer: input.insurer?.trim() || undefined,
    contractNumber: input.contractNumber?.trim() || undefined,
    premium: input.premium?.trim() || undefined,
    paymentMethod: input.paymentMethod?.trim() || "monatlich",
    productType: input.productType?.trim() || undefined,
    energyType: input.energyType?.trim() || undefined,
    startDate: input.startDate?.trim() || undefined,
    endDate: input.endDate?.trim() || undefined,
    applicationStatus: input.applicationStatus,
    expectedUnits: typeof input.expectedUnits === "number" && Number.isFinite(input.expectedUnits)
      ? Math.max(0, input.expectedUnits)
      : undefined,
    expectedCommissionEUR: typeof input.expectedCommissionEUR === "number" && Number.isFinite(input.expectedCommissionEUR)
      ? Math.max(0, input.expectedCommissionEUR)
      : undefined,
    notes: input.notes?.trim() || undefined,
    documentName: input.documentName?.trim() || undefined,
    documentUrl: input.documentUrl?.trim() || undefined,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function normalizeLeadProductDetails(input: unknown): LeadProductDetail[] | undefined {
  const source = Array.isArray(input) ? input : [];
  const next = source
    .map((entry) => {
      if (typeof entry === "string") {
        return buildLeadProductRecord({ category: entry, label: entry });
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const product = entry as Partial<LeadProductDetail> & { category?: string; label?: string };
      const category = String(product.category || product.label || "").trim();
      if (!category) {
        return null;
      }
      return buildLeadProductRecord({
        ...product,
        category,
        label: product.label || category,
      });
    })
    .filter((entry): entry is LeadProductDetail => Boolean(entry));

  return next.length ? next : undefined;
}

export function getLeadCustomerKindFormConfig(customerKind: "privat" | "firma") {
  if (customerKind === "privat") {
    return {
      companyLabel: "Privatperson / Firma (optional)",
      companyPlaceholder: "optional – wird aus Name abgeleitet",
      requireCompany: false,
      showBirthDate: true,
    };
  }

  return {
    companyLabel: "Firma",
    companyPlaceholder: "Musterbau GmbH",
    requireCompany: true,
    showBirthDate: false,
  };
}

export function resolveExclusiveDetailModal<TLead = unknown, TReport = unknown>(options: {
  lead?: TLead | null;
  report?: TReport | null;
}): { lead: TLead | null; report: TReport | null } {
  if (options.lead !== undefined) {
    return { lead: options.lead ?? null, report: null };
  }

  if (options.report !== undefined) {
    return { lead: null, report: options.report ?? null };
  }

  return { lead: null, report: null };
}
