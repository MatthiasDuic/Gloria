import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLeads, defaultReports, defaultScripts } from "./sample-data";
import type {
  CallReport,
  DashboardData,
  Lead,
  MetricSummary,
  ReportOutcome,
  ScriptConfig,
  Topic,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const LEADS_FILE = path.join(DATA_DIR, "leads.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");

async function ensureFile<T>(filePath: string, fallback: T) {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(filePath, "utf8");
  } catch {
    await writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  await ensureFile(filePath, fallback);

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    await writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

async function writeJson<T>(filePath: string, data: T) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function normalizeTopic(input: string): Topic {
  const value = input.trim().toLowerCase();

  if (value.includes("krankenversicherung") && value.includes("betrieb")) {
    return "betriebliche Krankenversicherung";
  }
  if (value.includes("altersvorsorge") || value === "bav") {
    return "betriebliche Altersvorsorge";
  }
  if (value.includes("gewerb")) {
    return "gewerbliche Versicherungen";
  }
  if (value.includes("privat") && value.includes("krankenversicherung")) {
    return "private Krankenversicherung";
  }
  return "Energie";
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function buildMetrics(leads: Lead[], reports: CallReport[]): MetricSummary {
  return {
    dialAttempts: leads.reduce((sum, lead) => sum + lead.attempts, 0),
    conversations: reports.length,
    appointments: reports.filter((report) => report.outcome === "Termin").length,
    rejections: reports.filter((report) => report.outcome === "Absage").length,
    callbacksOpen: leads.filter((lead) => lead.status === "wiedervorlage").length,
  };
}

export async function getDashboardData(): Promise<DashboardData> {
  const [leads, reports, scripts] = await Promise.all([
    readJson(LEADS_FILE, defaultLeads),
    readJson(REPORTS_FILE, defaultReports),
    readJson(SCRIPTS_FILE, defaultScripts),
  ]);

  return {
    leads,
    reports,
    scripts,
    metrics: buildMetrics(leads, reports),
  };
}

export async function importLeadsFromCsv(csvText: string) {
  const existing = await readJson(LEADS_FILE, defaultLeads);
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { imported: 0, total: existing.length };
  }

  const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
  const newLeads: Lead[] = lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line);
    const lookup = (name: string) => {
      const position = header.indexOf(name.toLowerCase());
      return position >= 0 ? cols[position] || "" : "";
    };

    const nextCallAt = lookup("nextCallAt");

    return {
      id: `lead-${Date.now()}-${index}`,
      company: lookup("company") || `Firma ${index + 1}`,
      contactName: lookup("contactName") || "Empfang",
      phone: lookup("phone") || "",
      email: lookup("email") || undefined,
      topic: normalizeTopic(lookup("topic") || "Energie"),
      note: lookup("note") || undefined,
      nextCallAt: nextCallAt || undefined,
      status: nextCallAt ? "wiedervorlage" : "neu",
      attempts: 0,
    };
  });

  const merged = [...newLeads, ...existing];
  await writeJson(LEADS_FILE, merged);

  return {
    imported: newLeads.length,
    total: merged.length,
  };
}

export async function saveScript(topic: Topic, payload: Partial<ScriptConfig>) {
  const scripts = await readJson(SCRIPTS_FILE, defaultScripts);
  const updated = scripts.map((script) =>
    script.topic === topic
      ? {
          ...script,
          ...payload,
        }
      : script,
  );

  await writeJson(SCRIPTS_FILE, updated);
  return updated.find((script) => script.topic === topic);
}

export async function storeCallReport(payload: {
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  summary: string;
  outcome: ReportOutcome;
  appointmentAt?: string;
  nextCallAt?: string;
  attempts?: number;
  recordingConsent?: boolean;
  recordingUrl?: string;
}) {
  const [leads, reports] = await Promise.all([
    readJson(LEADS_FILE, defaultLeads),
    readJson(REPORTS_FILE, defaultReports),
  ]);

  const report: CallReport = {
    id: `report-${Date.now()}`,
    leadId: payload.leadId,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    summary: payload.summary,
    outcome: payload.outcome,
    conversationDate: new Date().toISOString(),
    appointmentAt: payload.appointmentAt,
    nextCallAt: payload.nextCallAt,
    attempts: payload.attempts ?? 1,
    recordingConsent: Boolean(payload.recordingConsent),
    recordingUrl: payload.recordingUrl,
    emailedTo:
      process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
  };

  const updatedReports = [report, ...reports];
  const updatedLeads = leads.map((lead) => {
    const sameLead = payload.leadId
      ? lead.id === payload.leadId
      : lead.company.toLowerCase() === payload.company.toLowerCase();

    if (!sameLead) {
      return lead;
    }

    return {
      ...lead,
      attempts: payload.attempts ?? lead.attempts + 1,
      status:
        payload.outcome === "Termin"
          ? "termin"
          : payload.outcome === "Absage"
            ? "absage"
            : payload.outcome === "Wiedervorlage"
              ? "wiedervorlage"
              : "angerufen",
      nextCallAt: payload.nextCallAt,
    };
  });

  await Promise.all([
    writeJson(REPORTS_FILE, updatedReports),
    writeJson(LEADS_FILE, updatedLeads),
  ]);

  return report;
}
