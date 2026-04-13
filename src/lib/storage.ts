import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLeads, defaultReports, defaultScripts } from "./sample-data";
import {
  readReportDatabaseFromPostgres,
  writeReportDatabaseToPostgres,
} from "./report-db";
import type { RecordingEntry, ReportDatabase } from "./report-db";
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
const REPORT_DB_FILE = path.join(DATA_DIR, "report-database.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");

async function ensureFile<T>(filePath: string, fallback: T) {
  await mkdir(DATA_DIR, { recursive: true });

  try {
    await readFile(filePath, "utf8");
  } catch {
    try {
      await writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
    } catch {
      // Ignore write errors on read-only runtimes; caller will use fallback in-memory.
    }
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  await ensureFile(filePath, fallback);

  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    try {
      await writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
    } catch {
      // Ignore write errors on read-only runtimes.
    }
    return fallback;
  }
}

async function writeJson<T>(filePath: string, data: T) {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Allow callers to continue in runtimes without writable filesystem.
  }
}

function buildRecordingEntries(reports: CallReport[]): RecordingEntry[] {
  return reports
    .filter((report) => report.callSid && report.recordingUrl)
    .map((report) => ({
      id: `rec-${report.callSid}`,
      callSid: report.callSid as string,
      company: report.company,
      contactName: report.contactName,
      topic: report.topic,
      recordingUrl: report.recordingUrl as string,
      createdAt: report.conversationDate,
    }));
}

async function readReportDatabase(): Promise<ReportDatabase> {
  const postgresData = await readReportDatabaseFromPostgres();

  if (postgresData) {
    return postgresData;
  }

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(REPORT_DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReportDatabase>;
    return {
      reports: parsed.reports || [],
      recordings: parsed.recordings || [],
    };
  } catch {
    const legacyReports = await readJson(REPORTS_FILE, defaultReports);
    const migrated: ReportDatabase = {
      reports: legacyReports,
      recordings: buildRecordingEntries(legacyReports),
    };
    await writeJson(REPORT_DB_FILE, migrated);
    return migrated;
  }
}

async function readReportDatabaseWithMode(): Promise<{
  data: ReportDatabase;
  mode: "postgres" | "file";
}> {
  const postgresData = await readReportDatabaseFromPostgres();

  if (postgresData) {
    return { data: postgresData, mode: "postgres" };
  }

  const fileData = await readReportDatabase();
  return { data: fileData, mode: "file" };
}

async function writeReportDatabase(data: ReportDatabase) {
  const wroteToPostgres = await writeReportDatabaseToPostgres(data);

  if (wroteToPostgres) {
    return;
  }

  await writeJson(REPORT_DB_FILE, data);
  await writeJson(REPORTS_FILE, data.reports);
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
  const [leads, reportState, scripts] = await Promise.all([
    readJson(LEADS_FILE, defaultLeads),
    readReportDatabaseWithMode(),
    readJson(SCRIPTS_FILE, defaultScripts),
  ]);

  const reports = reportState.data.reports;

  return {
    leads,
    reports,
    scripts,
    metrics: buildMetrics(leads, reports),
    reportStorageMode: reportState.mode,
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
  callSid?: string;
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  summary?: string;
  outcome?: ReportOutcome;
  appointmentAt?: string;
  nextCallAt?: string;
  attempts?: number;
  recordingConsent?: boolean;
  recordingUrl?: string;
}) {
  const [leads, reportDb] = await Promise.all([
    readJson(LEADS_FILE, defaultLeads),
    readReportDatabase(),
  ]);
  const reports = reportDb.reports;

  const existingIndex = payload.callSid
    ? reports.findIndex((report) => report.callSid === payload.callSid)
    : -1;
  const existingReport = existingIndex >= 0 ? reports[existingIndex] : undefined;

  const report: CallReport = {
    id: existingReport?.id || `report-${Date.now()}`,
    callSid: payload.callSid || existingReport?.callSid,
    leadId: payload.leadId || existingReport?.leadId,
    company: payload.company,
    contactName: payload.contactName || existingReport?.contactName,
    topic: payload.topic,
    summary: payload.summary || existingReport?.summary || "",
    outcome: payload.outcome || existingReport?.outcome || "Kein Kontakt",
    conversationDate: existingReport?.conversationDate || new Date().toISOString(),
    appointmentAt: payload.appointmentAt || existingReport?.appointmentAt,
    nextCallAt: payload.nextCallAt || existingReport?.nextCallAt,
    attempts: payload.attempts ?? existingReport?.attempts ?? 1,
    recordingConsent: Boolean(
      payload.recordingConsent ?? existingReport?.recordingConsent,
    ),
    recordingUrl: payload.recordingUrl || existingReport?.recordingUrl,
    emailedTo:
      process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
  };

  const updatedReports = [...reports];

  if (existingIndex >= 0) {
    updatedReports[existingIndex] = report;
  } else {
    updatedReports.unshift(report);
  }

  const updatedRecordings = report.recordingUrl
    ? [
        {
          id: `rec-${report.callSid || report.id}`,
          callSid: report.callSid || report.id,
          company: report.company,
          contactName: report.contactName,
          topic: report.topic,
          recordingUrl: report.recordingUrl,
          createdAt: report.conversationDate,
        },
        ...reportDb.recordings.filter((entry) => entry.callSid !== (report.callSid || report.id)),
      ]
    : reportDb.recordings;

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
    writeReportDatabase({ reports: updatedReports, recordings: updatedRecordings }),
    writeJson(LEADS_FILE, updatedLeads),
  ]);

  return report;
}
