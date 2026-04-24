import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLeads, defaultReports, defaultScripts } from "./sample-data";
import { phoneMatches, normalizePhoneForMatch } from "./phone-utils";
import {
  appendCallTranscriptEventToPostgres,
  appendConversationEventToPostgres,
  bootstrapUserScriptsFromDefaults,
  clearReportRecordingInPostgres,
  deleteAllReportsFromPostgres,
  deleteReportFromPostgres,
  deleteReportsOlderThanInPostgres,
  readCampaignListsStateFromPostgres,
  readConversationEventsFromPostgres,
  readLeadsFromPostgres,
  readReportDatabaseFromPostgres,
  readScriptsFromPostgres,
  readUserScriptsFromPostgres,
  writeCampaignListsStateToPostgres,
  writeLeadsToPostgres,
  writeScriptToPostgres,
  writeReportDatabaseToPostgres,
  writeUserScriptToPostgres,
  writeScriptsToPostgres,
} from "./report-db";
import type { RecordingEntry, ReportDatabase } from "./report-db";
import type {
  CallReport,
  ConversationEvent,
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
const EVENTS_FILE = path.join(DATA_DIR, "conversation-events.json");
const SCRIPTS_FILE = path.join(DATA_DIR, "playbooks.json");
const LEGACY_SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");
const CAMPAIGN_STATE_FILE = path.join(DATA_DIR, "campaign-state.json");

interface CampaignListState {
  userId?: string;
  listId: string;
  listName: string;
  active: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastRunAt?: string;
}

interface CampaignStateFile {
  lists: CampaignListState[];
}

export type ActiveCampaignList = CampaignListState;

export async function listActiveCampaignLists(): Promise<ActiveCampaignList[]> {
  const state = await readCampaignState();
  return state.lists.filter((entry) => entry.active);
}

interface StoredConversationEvent extends ConversationEvent {
  userId?: string;
}

const LEGACY_STANDARD_OPENERS: Record<Topic, string[]> = {
  "betriebliche Krankenversicherung": [
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich kurz zum Thema betriebliche Krankenversicherung, weil viele Unternehmen damit Mitarbeiterbindung und Arbeitgeberattraktivität deutlich verbessern. Bevor wir starten: Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich hoffe, ich störe Sie gerade nicht. Viele Unternehmen nutzen die betriebliche Krankenversicherung inzwischen gezielt, um Fachkräfte leichter zu gewinnen und zu binden. Bevor wir starten: Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
  ],
  "betriebliche Altersvorsorge": [
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich zum Thema betriebliche Altersvorsorge, weil viele Arbeitgeber ihre bAV aktuell verständlicher und attraktiver für Mitarbeitende aufstellen möchten. Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich kurz zum Thema betriebliche Altersvorsorge, weil viele Arbeitgeber hier nach verständlichen und attraktiven Lösungen suchen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
  ],
  "gewerbliche Versicherungen": [
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich rufe im Auftrag von Herrn Matthias Duic an. Hintergrund ist, dass viele Unternehmen ihre gewerblichen Versicherungen gerade neu bewerten, um Preis, Leistung und Risikoschutz sauber abzugleichen. Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an, weil viele Unternehmen ihre gewerblichen Versicherungen momentan neu vergleichen, um Preis und Leistung sauber abzugleichen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
  ],
  "private Krankenversicherung": [
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich rufe im Auftrag von Herrn Matthias Duic an. Es geht um das Thema Beitragsentwicklung und Stabilität in der Krankenversicherung, weil für viele Menschen vor allem die langfristige Planbarkeit im Alter immer wichtiger wird. Vorab, dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Wir haben ein Konzept entwickelt, mit dem sich Krankenversicherungsbeiträge im Alter planbarer und stabiler aufstellen lassen. Denn egal ob gesetzlich oder privat versichert: Die Beiträge steigen meist Jahr für Jahr. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
  ],
  Energie: [
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich kurz zum Thema gewerbliche Strom- und Gasoptimierung, weil sich dort oft schnell Einsparpotenziale und bessere Konditionen aufzeigen lassen. Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an und melde mich kurz zum Thema gewerbliche Strom- und Gasoptimierung, weil sich dort häufig schnell Einsparpotenziale zeigen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
  ],
};

function normalizeLegacyScriptOpeners(scripts: ScriptConfig[]): ScriptConfig[] {
  return scripts.map((script) => {
    const currentDefault = defaultScripts.find((entry) => entry.topic === script.topic)?.opener;
    const legacyValues = LEGACY_STANDARD_OPENERS[script.topic];

    if (!currentDefault || !legacyValues.includes(script.opener)) {
      return script;
    }

    return {
      ...script,
      opener: currentDefault,
    };
  });
}

async function readLegacyPlaybooksFile(): Promise<ScriptConfig[]> {
  try {
    const raw = await readFile(LEGACY_SCRIPTS_FILE, "utf8");
    const parsed = JSON.parse(raw) as ScriptConfig[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    // No legacy file — fall back to defaults.
  }
  return defaultScripts;
}

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

async function writeJsonStrict<T>(filePath: string, data: T) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
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

async function readReportDatabase(userId?: string): Promise<ReportDatabase> {
  const postgresData = await readReportDatabaseFromPostgres(userId);

  if (postgresData) {
    return postgresData;
  }

  await mkdir(DATA_DIR, { recursive: true });

  try {
    const raw = await readFile(REPORT_DB_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ReportDatabase>;
    const parsedReports = Array.isArray(parsed.reports) ? parsed.reports : [];
    const scopedReports = userId
      ? parsedReports.filter((report) => report.userId === userId)
      : parsedReports;
    const reportCallSids = new Set(
      scopedReports
        .map((report) => report.callSid)
        .filter((callSid): callSid is string => Boolean(callSid)),
    );
    const parsedRecordings = Array.isArray(parsed.recordings) ? parsed.recordings : [];
    const scopedRecordings = userId
      ? parsedRecordings.filter((recording) => reportCallSids.has(recording.callSid))
      : parsedRecordings;
    return {
      reports: scopedReports,
      recordings: scopedRecordings,
    };
  } catch {
    const legacyReports = await readJson(REPORTS_FILE, defaultReports);
    const scopedLegacyReports = userId
      ? legacyReports.filter((report) => report.userId === userId)
      : legacyReports;
    const migrated: ReportDatabase = {
      reports: scopedLegacyReports,
      recordings: buildRecordingEntries(scopedLegacyReports),
    };
    if (!userId) {
      await writeJson(REPORT_DB_FILE, migrated);
    }
    return migrated;
  }
}

async function readReportDatabaseWithMode(userId?: string): Promise<{
  data: ReportDatabase;
  mode: "postgres" | "file";
}> {
  const postgresData = await readReportDatabaseFromPostgres(userId);

  if (postgresData) {
    return { data: postgresData, mode: "postgres" };
  }

  const fileData = await readReportDatabase(userId);
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

async function persistTranscriptChunkEvent(payload: {
  userId?: string;
  callSid?: string;
  summaryChunk?: string;
}) {
  const callSid = payload.callSid?.trim();
  const chunk = payload.summaryChunk?.trim();
  if (!callSid || !chunk) {
    return;
  }

  const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("[Script:")) {
      continue;
    }

    if (line.startsWith("Gloria:")) {
      const text = line.replace(/^Gloria:\s*/i, "").trim();
      if (text) {
        await appendCallTranscriptEventToPostgres({
          callSid,
          userId: payload.userId,
          speaker: "Gloria",
          text,
        });
      }
      continue;
    }

    if (line.startsWith("Interessent:")) {
      const text = line.replace(/^Interessent:\s*/i, "").trim();
      if (text) {
        await appendCallTranscriptEventToPostgres({
          callSid,
          userId: payload.userId,
          speaker: "Interessent",
          text,
        });
      }
    }
  }
}

function detectCsvDelimiter(line: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = -1;

  for (const delimiter of candidates) {
    const count = line.split(delimiter).length - 1;
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  return best;
}

function parseCsvLine(line: string, delimiter = ","): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      const nextChar = line[index + 1];
      if (inQuotes && nextChar === '"') {
        current += '"';
        index += 1;
        continue;
      }

      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function normalizeHeaderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[ä]/g, "ae")
    .replace(/[ö]/g, "oe")
    .replace(/[ü]/g, "ue")
    .replace(/[ß]/g, "ss")
    .replace(/[^a-z0-9]/g, "");
}

function createLeadId(indexHint = 0): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `lead-${crypto.randomUUID()}`;
  }

  return `lead-${Date.now()}-${indexHint}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureUniqueLeadIds(leads: Lead[]): Lead[] {
  const seen = new Set<string>();

  return leads.map((lead, index) => {
    let nextId = (lead.id || "").trim();

    if (!nextId || seen.has(nextId)) {
      nextId = createLeadId(index);
    }

    seen.add(nextId);

    if (nextId === lead.id) {
      return lead;
    }

    return {
      ...lead,
      id: nextId,
    };
  });
}

const CSV_HEADER_ALIASES: Record<string, string[]> = {
  company: ["company", "firma", "unternehmen", "firmenname"],
  contactName: ["contactname", "ansprechpartner", "kontakt", "kontaktperson", "name"],
  phone: ["phone", "telefon", "telefonnummer", "rufnummer", "nummer"],
  directDial: ["directdial", "durchwahl", "direktdurchwahl", "mobil", "handy"],
  email: ["email", "mail", "e-mail"],
  topic: ["topic", "thema", "bereich"],
  note: ["note", "notiz", "bemerkung", "hinweis"],
  nextCallAt: ["nextcallat", "naechsteranruf", "nachsteranruf", "naechsterrueckruf", "ruckrufzeitpunkt", "callback", "rueckruf"],
};

function buildHeaderIndex(headerRow: string[]): Record<string, number> {
  const normalizedHeader = headerRow.map((value) => normalizeHeaderKey(value));
  const indexMap: Record<string, number> = {};

  for (const [canonical, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    const candidates = aliases.map((entry) => normalizeHeaderKey(entry));
    const idx = normalizedHeader.findIndex((entry) => candidates.includes(entry));
    if (idx >= 0) {
      indexMap[canonical] = idx;
    }
  }

  return indexMap;
}

async function readConversationEvents(userId?: string): Promise<ConversationEvent[]> {
  const postgresData = await readConversationEventsFromPostgres(userId);

  if (postgresData) {
    return postgresData;
  }

  const fileEvents = await readJson<StoredConversationEvent[]>(EVENTS_FILE, []);
  const scopedEvents = userId
    ? fileEvents.filter((event) => event.userId === userId)
    : fileEvents;
  return scopedEvents.map(({ userId: _userId, ...event }) => event);
}

async function readScriptsWithMode(userId?: string): Promise<{
  data: ScriptConfig[];
  mode: "postgres" | "file";
}> {
  if (userId) {
    const userScripts = await readUserScriptsFromPostgres(userId);

    if (userScripts && userScripts.length > 0) {
      return { data: normalizeLegacyScriptOpeners(userScripts), mode: "postgres" };
    }

    const bootstrapped = await bootstrapUserScriptsFromDefaults(userId, defaultScripts);
    if (bootstrapped) {
      const afterBootstrap = await readUserScriptsFromPostgres(userId);
      if (afterBootstrap && afterBootstrap.length > 0) {
        return { data: normalizeLegacyScriptOpeners(afterBootstrap), mode: "postgres" };
      }
    }
  }

  const postgresData = await readScriptsFromPostgres();

  if (postgresData) {
    return { data: normalizeLegacyScriptOpeners(postgresData), mode: "postgres" };
  }

  const fallbackScripts = await readJson(SCRIPTS_FILE, await readLegacyPlaybooksFile());
  const bootstrappedToPostgres = await writeScriptsToPostgres(fallbackScripts);

  if (bootstrappedToPostgres) {
    return { data: normalizeLegacyScriptOpeners(fallbackScripts), mode: "postgres" };
  }

  return {
    data: normalizeLegacyScriptOpeners(fallbackScripts),
    mode: "file",
  };
}

async function readScripts(userId?: string): Promise<ScriptConfig[]> {
  const scriptsState = await readScriptsWithMode(userId);
  return scriptsState.data;
}

async function readLeads(userId?: string): Promise<Lead[]> {
  const postgresLeads = await readLeadsFromPostgres(userId);
  if (postgresLeads) {
    return postgresLeads;
  }

  const fileLeads = await readJson(LEADS_FILE, defaultLeads);
  if (!userId) {
    return fileLeads;
  }

  return fileLeads.filter((lead) => lead.userId === userId);
}

export async function findLeadForInboundCallbackByPhone(fromNumber: string): Promise<Lead | undefined> {
  const leads = await readLeads();

  const candidates = leads.filter((lead) => {
    if (lead.status === "absage") {
      return false;
    }

    return phoneMatches(fromNumber, lead.phone) || phoneMatches(fromNumber, lead.directDial);
  });

  if (candidates.length === 0) {
    return undefined;
  }

  return [...candidates].sort((a, b) => {
    const byAttempts = (b.attempts || 0) - (a.attempts || 0);
    if (byAttempts !== 0) {
      return byAttempts;
    }

    const aTs = Date.parse(a.nextCallAt || "") || 0;
    const bTs = Date.parse(b.nextCallAt || "") || 0;
    return bTs - aTs;
  })[0];
}

async function writeLeads(leads: Lead[], userId?: string): Promise<void> {
  const sanitizedLeads = ensureUniqueLeadIds(leads);
  const wroteToPostgres = await writeLeadsToPostgres(sanitizedLeads, userId);

  if (wroteToPostgres) {
    return;
  }

  if (!userId) {
    await writeJsonStrict(LEADS_FILE, sanitizedLeads);
    return;
  }

  const existingFileLeads = await readJson(LEADS_FILE, defaultLeads);
  const merged = [
    ...existingFileLeads.filter((lead) => lead.userId !== userId),
    ...sanitizedLeads,
  ];
  await writeJsonStrict(LEADS_FILE, merged);
}

async function readCampaignState(userId?: string): Promise<CampaignStateFile> {
  const postgresLists = await readCampaignListsStateFromPostgres(userId);

  if (postgresLists) {
    return { lists: postgresLists };
  }

  const fileState = await readJson<CampaignStateFile>(CAMPAIGN_STATE_FILE, { lists: [] });
  if (!userId) {
    return fileState;
  }

  return {
    lists: fileState.lists.filter((entry) => (entry as { userId?: string }).userId === userId),
  };
}

async function writeCampaignState(state: CampaignStateFile, userId?: string): Promise<void> {
  const wroteToPostgres = await writeCampaignListsStateToPostgres(state.lists, userId);

  if (wroteToPostgres) {
    return;
  }

  if (!userId) {
    await writeJsonStrict(CAMPAIGN_STATE_FILE, state);
    return;
  }

  const existing = await readJson<CampaignStateFile>(CAMPAIGN_STATE_FILE, { lists: [] });
  const merged = {
    lists: [
      ...existing.lists.filter((entry) => (entry as { userId?: string }).userId !== userId),
      ...state.lists,
    ],
  };
  await writeJsonStrict(CAMPAIGN_STATE_FILE, merged);
}

export async function appendConversationEvent(
  event: Omit<ConversationEvent, "id" | "createdAt"> & { createdAt?: string },
  options?: { userId?: string },
) {
  const normalized: ConversationEvent = {
    ...event,
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: event.createdAt || new Date().toISOString(),
  };

  const wroteToPostgres = await appendConversationEventToPostgres(normalized, options?.userId);

  if (wroteToPostgres) {
    return normalized;
  }

  const storedEvent: StoredConversationEvent = {
    ...normalized,
    userId: options?.userId,
  };
  const existing = await readJson<StoredConversationEvent[]>(EVENTS_FILE, []);
  const next = [storedEvent, ...existing].slice(0, 5000);
  await writeJson(EVENTS_FILE, next);
  return normalized;
}

function buildMetrics(
  leads: Lead[],
  reports: CallReport[],
  events: ConversationEvent[],
): MetricSummary {
  const transferRequested = events.filter((event) => event.eventType === "transfer_requested").length;
  const transferConnected = events.filter((event) => event.eventType === "transfer_connected").length;
  const transferSuccessRate =
    transferRequested > 0 ? Math.round((transferConnected / transferRequested) * 100) : 0;

  return {
    dialAttempts: leads.reduce((sum, lead) => sum + lead.attempts, 0),
    conversations: reports.length,
    appointments: reports.filter((report) => report.outcome === "Termin").length,
    rejections: reports.filter((report) => report.outcome === "Absage").length,
    callbacksOpen: leads.filter((lead) => lead.status === "wiedervorlage").length,
    gatekeeperLoops: events.filter((event) => event.eventType === "gatekeeper_loop_break").length,
    transferSuccessRate,
  };
}

export async function getDashboardData(options?: { userId?: string; role?: "master" | "user" }): Promise<DashboardData> {
  const userId = options?.userId;
  const scopeReportsToUser = options?.role === "user" && Boolean(userId);
  const scopedUserId = scopeReportsToUser ? userId : undefined;
  const [leads, reportState, scriptsState, events] = await Promise.all([
    readLeads(scopedUserId),
    readReportDatabaseWithMode(scopedUserId),
    readScriptsWithMode(userId),
    readConversationEvents(scopedUserId),
  ]);

  const reports = reportState.data.reports;

  return {
    leads,
    reports,
    playbooks: scriptsState.data,
    metrics: buildMetrics(leads, reports, events),
    reportStorageMode: reportState.mode,
    playbooksStorageMode: scriptsState.mode,
  };
}

export async function importLeadsFromCsv(
  csvText: string,
  options?: { listId?: string; listName?: string; userId?: string },
) {
  const existing = await readLeads(options?.userId);
  const listId = options?.listId || `list-${Date.now()}`;
  const listName = options?.listName?.trim() || `Import ${new Date().toLocaleString("de-DE")}`;
  const lines = csvText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { imported: 0, total: existing.length };
  }

  const delimiter = detectCsvDelimiter(lines[0]);
  const header = parseCsvLine(lines[0], delimiter);
  const headerIndex = buildHeaderIndex(header);
  const newLeads: Lead[] = lines.slice(1).map((line, index) => {
    const cols = parseCsvLine(line, delimiter);
    const lookup = (canonical: keyof typeof CSV_HEADER_ALIASES) => {
      const position = headerIndex[canonical];
      return typeof position === "number" ? (cols[position] || "").trim() : "";
    };

    const nextCallAt = lookup("nextCallAt");
    const directDial = lookup("directDial");
    const company = lookup("company");
    const contactName = lookup("contactName");
    const topic = lookup("topic");

    return {
      id: createLeadId(index),
      userId: options?.userId,
      listId,
      listName,
      company: company || `Firma ${index + 1}`,
      contactName: contactName || "Empfang",
      phone: lookup("phone") || "",
      directDial: directDial || undefined,
      email: lookup("email") || undefined,
      topic: normalizeTopic(topic || "Energie"),
      note: lookup("note") || undefined,
      nextCallAt: nextCallAt || undefined,
      status: nextCallAt ? "wiedervorlage" : "neu",
      attempts: 0,
    };
  });

  const merged = [...newLeads, ...existing];
  await writeLeads(merged, options?.userId);

  const campaignState = await readCampaignState(options?.userId);
  const alreadyKnown = campaignState.lists.some((list) => list.listId === listId);
  if (!alreadyKnown) {
    campaignState.lists.unshift({
      listId,
      listName,
      active: false,
      stoppedAt: new Date().toISOString(),
      ...(options?.userId ? { userId: options.userId } : {}),
    } as CampaignListState);
    await writeCampaignState(campaignState, options?.userId);
  }

  return {
    listId,
    listName,
    imported: newLeads.length,
    total: merged.length,
  };
}

export async function saveScript(topic: Topic, payload: Partial<ScriptConfig>, options?: { userId?: string }) {
  const scripts = await readScripts(options?.userId);
  const updated = scripts.map((script) =>
    script.topic === topic
      ? {
          ...script,
          ...payload,
        }
      : script,
  );

  const updatedScript = updated.find((script) => script.topic === topic);

  if (!updatedScript) {
    throw new Error(`Skript für Thema ${topic} konnte nicht gefunden werden.`);
  }

  if (options?.userId) {
    const wroteUserScript = await writeUserScriptToPostgres(options.userId, updatedScript, false);

    if (wroteUserScript) {
      const persistedScripts = await readUserScriptsFromPostgres(options.userId);
      const persistedScript = persistedScripts?.find((script) => script.topic === topic);

      if (!persistedScript) {
        throw new Error("Skript wurde nicht persistent in der Datenbank gefunden.");
      }

      return {
        script: persistedScript,
        storageMode: "postgres" as const,
      };
    }
  }

  const wroteToPostgres = await writeScriptToPostgres(updatedScript);

  if (wroteToPostgres) {
    const persistedScripts = await readScriptsFromPostgres();
    const persistedScript = persistedScripts?.find((script) => script.topic === topic);

    if (!persistedScript) {
      throw new Error("Skript wurde nicht persistent in der Datenbank gefunden.");
    }

    return {
      script: persistedScript,
      storageMode: "postgres" as const,
    };
  }

  await writeJsonStrict(SCRIPTS_FILE, updated);

  return {
    script: updatedScript,
    storageMode: "file" as const,
  };
}

export async function storeCallReport(payload: {
  userId?: string;
  phoneNumberId?: string;
  callSid?: string;
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  summary?: string;
  summaryChunk?: string;
  outcome?: ReportOutcome;
  appointmentAt?: string;
  nextCallAt?: string;
  directDial?: string;
  attempts?: number;
  recordingConsent?: boolean;
  recordingUrl?: string;
}) {
  await persistTranscriptChunkEvent({
    userId: payload.userId,
    callSid: payload.callSid,
    summaryChunk: payload.summaryChunk,
  });

  const [leads, reportDb] = await Promise.all([
    readLeads(payload.userId),
    readReportDatabase(),
  ]);
  const reports = reportDb.reports;

  const existingIndex = payload.callSid
    ? reports.findIndex((report) => report.callSid === payload.callSid)
    : -1;
  const existingReport = existingIndex >= 0 ? reports[existingIndex] : undefined;

  const mergeSummary = (existing: string, incoming?: string, chunk?: string) => {
    let merged = (existing || "").trim();
    const normalizedIncoming = (incoming || "").trim();
    const normalizedChunk = (chunk || "").trim();

    if (normalizedIncoming) {
      if (!merged) {
        merged = normalizedIncoming;
      } else if (normalizedIncoming.includes(merged)) {
        merged = normalizedIncoming;
      } else if (!merged.includes(normalizedIncoming)) {
        merged = `${merged}\n${normalizedIncoming}`.trim();
      }
    }

    if (normalizedChunk) {
      if (!merged) {
        merged = normalizedChunk;
      } else if (!merged.includes(normalizedChunk)) {
        merged = `${merged}\n${normalizedChunk}`.trim();
      }
    }

    return merged;
  };

  const mergedSummary = mergeSummary(
    existingReport?.summary || "",
    payload.summary,
    payload.summaryChunk,
  );

  const report: CallReport = {
    id: existingReport?.id || `report-${Date.now()}`,
    userId: payload.userId || existingReport?.userId,
    phoneNumberId: payload.phoneNumberId || existingReport?.phoneNumberId,
    callSid: payload.callSid || existingReport?.callSid,
    leadId: payload.leadId || existingReport?.leadId,
    directDial: payload.directDial || existingReport?.directDial,
    company: payload.company,
    contactName: payload.contactName || existingReport?.contactName,
    topic: payload.topic,
    summary: mergedSummary,
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

  const updatedLeads: Lead[] = leads.map((lead) => {
    const sameLead = payload.leadId
      ? lead.id === payload.leadId
      : lead.company.toLowerCase() === payload.company.toLowerCase();

    if (!sameLead) {
      return lead;
    }

    const nextAttempts = payload.attempts ?? lead.attempts + 1;

    // Auto-Retry bei "Kein Kontakt":
    // Nach Versuch 1 -> erneut in 1 Tag, nach Versuch 2 -> in 3 Tagen,
    // nach Versuch 3 -> endgueltig "absage". Nur anwenden, wenn der Report
    // bereits existierte (= Update von Twilio-Status oder finalizeCall), um
    // den Initial-Platzhalter beim Kampagnen-Start nicht zu ueberschreiben.
    const isRetryable =
      payload.outcome === "Kein Kontakt" &&
      existingIndex >= 0 &&
      !payload.nextCallAt;

    let resolvedStatus: Lead["status"];
    let resolvedNextCallAt = payload.nextCallAt;

    if (isRetryable && nextAttempts >= 3) {
      resolvedStatus = "absage";
      resolvedNextCallAt = undefined;
    } else if (isRetryable) {
      const delayDays = nextAttempts >= 2 ? 3 : 1;
      const next = new Date();
      next.setHours(9, 0, 0, 0);
      next.setDate(next.getDate() + delayDays);
      resolvedNextCallAt = next.toISOString();
      resolvedStatus = "wiedervorlage";
    } else if (payload.outcome === "Termin") {
      resolvedStatus = "termin";
    } else if (payload.outcome === "Absage") {
      resolvedStatus = "absage";
    } else if (payload.outcome === "Wiedervorlage") {
      resolvedStatus = "wiedervorlage";
    } else {
      resolvedStatus = "angerufen";
    }

    return {
      ...lead,
      attempts: nextAttempts,
      directDial: payload.directDial || lead.directDial,
      status: resolvedStatus,
      nextCallAt: resolvedNextCallAt,
    };
  });

  await Promise.all([
    writeReportDatabase({ reports: updatedReports, recordings: updatedRecordings }),
    writeLeads(updatedLeads, payload.userId),
  ]);

  return report;
}

export async function listDueCallbackLeads(limit = 25): Promise<Lead[]> {
  const leads = await readLeads();
  const now = Date.now();

  return leads
    .filter((lead) => {
      if (lead.status !== "wiedervorlage" || !lead.nextCallAt) {
        return false;
      }

      const ts = Date.parse(lead.nextCallAt);
      if (Number.isNaN(ts) || ts > now) {
        return false;
      }

      return Boolean(lead.directDial || lead.phone);
    })
    .sort((a, b) => Date.parse(a.nextCallAt || "") - Date.parse(b.nextCallAt || ""))
    .slice(0, limit);
}

export async function markLeadCallbackScheduled(leadId: string): Promise<void> {
  if (!leadId) {
    return;
  }

  const leads = await readLeads();
  const updated = leads.map((lead) =>
    lead.id === leadId
      ? {
          ...lead,
          status: "angerufen" as const,
          nextCallAt: undefined,
        }
      : lead,
  );

  await writeLeads(updated);
}

export async function getCampaignListsSummary(userId?: string): Promise<
  Array<{
    listId: string;
    listName: string;
    active: boolean;
    total: number;
    pending: number;
    called: number;
    appointments: number;
    callbacks: number;
    rejections: number;
  }>
> {
  const leads = await readLeads(userId);
  const campaignState = await readCampaignState(userId);

  const grouped = new Map<
    string,
    {
      listId: string;
      listName: string;
      total: number;
      pending: number;
      called: number;
      appointments: number;
      callbacks: number;
      rejections: number;
    }
  >();

  for (const lead of leads) {
    const listId = lead.listId || "legacy";
    const listName = lead.listName || "Standardliste";
    const existing = grouped.get(listId) || {
      listId,
      listName,
      total: 0,
      pending: 0,
      called: 0,
      appointments: 0,
      callbacks: 0,
      rejections: 0,
    };

    existing.total += 1;
    if (lead.status === "neu") {
      existing.pending += 1;
    }
    if (lead.status === "angerufen") {
      existing.called += 1;
    }
    if (lead.status === "termin") {
      existing.appointments += 1;
    }
    if (lead.status === "wiedervorlage") {
      existing.callbacks += 1;
    }
    if (lead.status === "absage") {
      existing.rejections += 1;
    }

    grouped.set(listId, existing);
  }

  return [...grouped.values()]
    .map((list) => ({
      ...list,
      active: Boolean(
        campaignState.lists.find((entry) => entry.listId === list.listId)?.active,
      ),
    }))
    .sort((a, b) => a.listName.localeCompare(b.listName, "de"));
}

export async function setCampaignListActive(
  listId: string,
  active: boolean,
  userId?: string,
): Promise<void> {
  const leads = await readLeads(userId);
  const listLead = leads.find((lead) => (lead.listId || "legacy") === listId);
  const listName = listLead?.listName || (listId === "legacy" ? "Standardliste" : listId);

  const campaignState = await readCampaignState(userId);
  const existingIndex = campaignState.lists.findIndex((entry) => entry.listId === listId);
  const next = {
    listId,
    listName,
    active,
    startedAt: active ? new Date().toISOString() : campaignState.lists[existingIndex]?.startedAt,
    stoppedAt: active ? undefined : new Date().toISOString(),
    lastRunAt: campaignState.lists[existingIndex]?.lastRunAt,
  };

  if (existingIndex >= 0) {
    campaignState.lists[existingIndex] = next;
  } else {
    campaignState.lists.unshift(next);
  }

  await writeCampaignState(campaignState, userId);
}

export async function deleteCampaignList(listId: string, userId?: string): Promise<{ removedLeads: number }> {
  const leads = await readLeads(userId);
  const campaignState = await readCampaignState(userId);

  const isInList = (lead: Lead) => {
    const leadListId = lead.listId || "legacy";
    return leadListId === listId;
  };

  const removedLeads = leads.filter(isInList).length;
  const nextLeads = leads.filter((lead) => !isInList(lead));
  const nextState = {
    lists: campaignState.lists.filter((entry) => entry.listId !== listId),
  };

  await Promise.all([
    writeLeads(nextLeads, userId),
    writeCampaignState(nextState, userId),
  ]);

  return { removedLeads };
}

export async function isCampaignListActive(listId: string, userId?: string): Promise<boolean> {
  const campaignState = await readCampaignState(userId);
  return Boolean(campaignState.lists.find((entry) => entry.listId === listId)?.active);
}

export async function pullNextLeadForCampaignList(listId: string, userId?: string): Promise<Lead | undefined> {
  const leads = await readLeads(userId);
  const index = leads.findIndex(
    (lead) => (lead.listId || "legacy") === listId && lead.status === "neu" && Boolean(lead.phone?.trim()),
  );

  if (index < 0) {
    return undefined;
  }

  const lead = leads[index];
  leads[index] = {
    ...lead,
    status: "angerufen",
    attempts: (lead.attempts || 0) + 1,
  };

  await writeLeads(leads, userId);

  const campaignState = await readCampaignState(userId);
  const stateIndex = campaignState.lists.findIndex((entry) => entry.listId === listId);
  if (stateIndex >= 0) {
    campaignState.lists[stateIndex] = {
      ...campaignState.lists[stateIndex],
      lastRunAt: new Date().toISOString(),
    };
    await writeCampaignState(campaignState, userId);
  }

  return leads[index];
}

export async function deleteReport(reportId: string): Promise<void> {
  const postgresDeleted = await deleteReportFromPostgres(reportId);

  if (!postgresDeleted) {
    const reportDb = await readReportDatabase();
    const target = reportDb.reports.find((r) => r.id === reportId);
    const updatedReports = reportDb.reports.filter((r) => r.id !== reportId);
    const updatedRecordings = target
      ? reportDb.recordings.filter(
          (rec) => rec.callSid !== (target.callSid || target.id),
        )
      : reportDb.recordings;
    await writeReportDatabase({ reports: updatedReports, recordings: updatedRecordings });
  }
}

export async function deleteAllReports(
  options: { userId?: string } = {},
): Promise<{ deletedReports: number; deletedRecordings: number }> {
  const pg = await deleteAllReportsFromPostgres(options);
  if (pg.ok) {
    return { deletedReports: pg.deletedReports, deletedRecordings: pg.deletedRecordings };
  }

  const reportDb = await readReportDatabase();
  // Der Datei-Fallback führt keine user_id, deshalb greift userId-Filter
  // dort nicht — der Master löscht hier alles, ein User nichts.
  if (options.userId) {
    return { deletedReports: 0, deletedRecordings: 0 };
  }

  const deletedReports = reportDb.reports.length;
  const deletedRecordings = reportDb.recordings.length;
  await writeReportDatabase({ reports: [], recordings: [] });
  return { deletedReports, deletedRecordings };
}

export async function deleteReportsOlderThan(
  days: number,
): Promise<{ deletedReports: number; deletedRecordings: number }> {
  const pg = await deleteReportsOlderThanInPostgres(days);
  if (pg.ok) {
    return { deletedReports: pg.deletedReports, deletedRecordings: pg.deletedRecordings };
  }

  const cutoff = Date.now() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000;
  const reportDb = await readReportDatabase();
  const keep: CallReport[] = [];
  const removedCallSids = new Set<string>();
  let deletedReports = 0;

  for (const report of reportDb.reports) {
    const ts = Date.parse(report.conversationDate);
    if (!Number.isNaN(ts) && ts < cutoff) {
      deletedReports += 1;
      if (report.callSid) {
        removedCallSids.add(report.callSid);
      }
      removedCallSids.add(report.id);
      continue;
    }
    keep.push(report);
  }

  const keepRecordings = reportDb.recordings.filter(
    (rec) => !removedCallSids.has(rec.callSid),
  );
  const deletedRecordings = reportDb.recordings.length - keepRecordings.length;

  await writeReportDatabase({ reports: keep, recordings: keepRecordings });
  return { deletedReports, deletedRecordings };
}

export async function deleteReportRecording(reportId: string): Promise<void> {
  const postgresCleared = await clearReportRecordingInPostgres(reportId);

  if (!postgresCleared) {
    const reportDb = await readReportDatabase();
    const targetReport = reportDb.reports.find((r) => r.id === reportId);
    const updatedReports = reportDb.reports.map((r) =>
      r.id === reportId ? { ...r, recordingUrl: undefined } : r,
    );
    const updatedRecordings = targetReport
      ? reportDb.recordings.filter(
          (rec) => rec.callSid !== (targetReport.callSid || targetReport.id),
        )
      : reportDb.recordings;
    await writeReportDatabase({ reports: updatedReports, recordings: updatedRecordings });
  }
}
