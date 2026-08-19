import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { defaultLeads, defaultReports, defaultScripts } from "./sample-data";
import { phoneMatches, normalizePhoneForMatch } from "./phone-utils";
import {
  appendCallTranscriptEventToPostgres,
  appendConversationEventToPostgres,
  bootstrapUserScriptsFromDefaults,
  clearReportRecordingInPostgres,
  diagnosePostgresConnection,
  deleteAllReportsFromPostgres,
  deleteReportFromPostgres,
  deleteReportsOlderThanInPostgres,
  getLastPostgresFailureReason,
  isDatabaseUrlConfigured,
  readCampaignListsStateFromPostgres,
  readConversationEventsFromPostgres,
  findUserById,
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
const SCRIPTS_FILE = path.join(DATA_DIR, "topic-policies.json");
const LEGACY_SCRIPTS_FILE = path.join(DATA_DIR, "scripts.json");
const CAMPAIGN_STATE_FILE = path.join(DATA_DIR, "campaign-state.json");

/** Retry configuration for transient PostgreSQL errors */
const POSTGRES_RETRY_CONFIG = {
  maxAttempts: 3,
  delayMs: [200, 500, 1000], // exponential backoff: 200ms, 500ms, 1000ms
};

/**
 * Retry wrapper for PostgreSQL operations that may fail transiently.
 * Logs failures and alerts on final failure.
 */
async function withPostgresRetry<T>(
  operation: () => Promise<T | null>,
  operationName: string,
): Promise<T | null> {
  for (let attempt = 1; attempt <= POSTGRES_RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === POSTGRES_RETRY_CONFIG.maxAttempts;
      const message = error instanceof Error ? error.message : String(error);
      const delayMs = POSTGRES_RETRY_CONFIG.delayMs[attempt - 1] || 1000;

      if (isLastAttempt) {
        console.error(
          `[ALERT] PostgreSQL ${operationName} failed after ${attempt} attempts: ${message}`,
        );
        // Will fall back to file storage
        return null;
      }

      console.warn(
        `PostgreSQL ${operationName} attempt ${attempt} failed (${message}), retrying in ${delayMs}ms...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

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

function normalizeTopicPolicies(scripts: ScriptConfig[]): ScriptConfig[] {
  return scripts.map((script) => ({
    ...script,
    topicSummary: script.topicSummary || script.callObjective || "",
    behavior: script.behavior || "",
    conversationGuardrails: script.conversationGuardrails || "",
    requiredQuestions: script.requiredQuestions || script.requiredData || "",
  }));
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
  const postgresData = await withPostgresRetry(
    () => readReportDatabaseFromPostgres(userId),
    `readReportDatabase(userId=${userId})`,
  );

  if (postgresData) {
    return { data: postgresData, mode: "postgres" };
  }

  console.info("Falling back to file storage for report database");
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
  return input.trim() || "Energie";
}

async function filterScriptsByUserAccess(
  scripts: ScriptConfig[],
  userId?: string,
): Promise<ScriptConfig[]> {
  if (!userId) {
    return scripts;
  }

  const user = await findUserById(userId);
  if (!user) {
    return [];
  }

  if (!user.allowedPlaybookTopics || user.allowedPlaybookTopics.length === 0) {
    return scripts;
  }

  const allowed = new Set(user.allowedPlaybookTopics);
  return scripts.filter((script) => allowed.has(script.topic));
}

async function persistTranscriptChunkEvent(payload: {
  userId?: string;
  callSid?: string;
  summaryChunk?: string;
  company?: string;
  topic?: Topic;
  step?: string;
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
        if (payload.company && payload.topic) {
          await appendConversationEvent(
            {
              callSid,
              company: payload.company,
              topic: payload.topic,
              step: payload.step || "conversation",
              eventType: "utterance_gloria",
              text,
            },
            { userId: payload.userId },
          );
        }
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
        if (payload.company && payload.topic) {
          await appendConversationEvent(
            {
              callSid,
              company: payload.company,
              topic: payload.topic,
              step: payload.step || "conversation",
              eventType: "utterance_caller",
              text,
            },
            { userId: payload.userId },
          );
        }
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
  location: ["location", "ort", "stadt"],
  topic: ["topic", "thema", "bereich"],
  note: ["note", "notiz", "bemerkung", "hinweis"],
  nextCallAt: ["nextcallat", "naechsteranruf", "nachsteranruf", "naechsterrueckruf", "ruckrufzeitpunkt", "callback", "rueckruf"],
};

function buildHeaderIndex(headerRow: string[]): Record<string, number> {
  const normalizedHeader = headerRow.map((value) => normalizeHeaderKey(value));
  const indexMap: Record<string, number> = {};

  for (const [canonical, aliases] of Object.entries(CSV_HEADER_ALIASES)) {
    const candidates = aliases.map((entry) => normalizeHeaderKey(entry));
    // Prefer alias order over column order for deterministic header mapping.
    const idx = candidates.reduce<number>((found, candidate) => {
      if (found >= 0) {
        return found;
      }
      return normalizedHeader.indexOf(candidate);
    }, -1);
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
    const userScripts = await withPostgresRetry(
      () => readUserScriptsFromPostgres(userId),
      `readUserScripts(userId=${userId})`,
    );

    if (userScripts && userScripts.length > 0) {
      return {
        data: await filterScriptsByUserAccess(normalizeTopicPolicies(userScripts), userId),
        mode: "postgres",
      };
    }

    const bootstrapped = await bootstrapUserScriptsFromDefaults(userId, defaultScripts);
    if (bootstrapped) {
      const afterBootstrap = await withPostgresRetry(
        () => readUserScriptsFromPostgres(userId),
        `readUserScripts(userId=${userId}) after bootstrap`,
      );
      if (afterBootstrap && afterBootstrap.length > 0) {
        return {
          data: await filterScriptsByUserAccess(normalizeTopicPolicies(afterBootstrap), userId),
          mode: "postgres",
        };
      }
    }
  }

  const postgresData = await withPostgresRetry(
    () => readScriptsFromPostgres(),
    "readScripts(global)",
  );

  if (postgresData) {
    return {
      data: await filterScriptsByUserAccess(normalizeTopicPolicies(postgresData), userId),
      mode: "postgres",
    };
  }

  console.info("Falling back to file storage for topic policies");
  const fallbackScripts = await readJson(SCRIPTS_FILE, await readLegacyPlaybooksFile());
  const bootstrappedToPostgres = await writeScriptsToPostgres(fallbackScripts);

  if (bootstrappedToPostgres) {
    return { data: normalizeTopicPolicies(fallbackScripts), mode: "postgres" };
  }

  return {
    data: await filterScriptsByUserAccess(normalizeTopicPolicies(fallbackScripts), userId),
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

export async function getLeadById(leadId: string, userId?: string): Promise<Lead | undefined> {
  if (!leadId) return undefined;
  const leads = await readLeads(userId);
  return leads.find((lead) => lead.id === leadId);
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

  // In production (Vercel), Postgres is required since file system is read-only
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    if (isDatabaseUrlConfigured()) {
      const lastFailure = getLastPostgresFailureReason();
      if (lastFailure) {
        throw new Error(`Postgres storage write failed: ${lastFailure}`);
      }

      const diagnosis = await diagnosePostgresConnection();
      throw new Error(`Postgres storage is unavailable. ${diagnosis}`);
    }

    throw new Error(
      "DATABASE_URL is not configured. Please set DATABASE_URL environment variable for Postgres storage."
    );
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

  // In production (Vercel), Postgres is required since file system is read-only.
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    if (isDatabaseUrlConfigured()) {
      const lastFailure = getLastPostgresFailureReason();
      if (lastFailure) {
        throw new Error(`Postgres storage write failed: ${lastFailure}`);
      }

      const diagnosis = await diagnosePostgresConnection();
      throw new Error(`Postgres storage is unavailable. ${diagnosis}`);
    }

    throw new Error(
      "DATABASE_URL is not configured. Please set DATABASE_URL environment variable for Postgres storage.",
    );
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

export async function getRecentConversationEvents(
  options?: { userId?: string; minutes?: number; limit?: number },
): Promise<ConversationEvent[]> {
  const minutes = options?.minutes ?? 30;
  const limit = options?.limit ?? 200;
  const events = await readConversationEvents(options?.userId);
  const cutoff = Date.now() - minutes * 60_000;
  return events
    .filter((e) => {
      const t = e.createdAt ? Date.parse(e.createdAt) : 0;
      return !Number.isNaN(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
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

function deduplicateReports(reports: CallReport[]): CallReport[] {
  // First pass: Deduplicate by callSid (most reliable key)
  const byCallSid = new Map<string, CallReport>();
  const withoutCallSid: CallReport[] = [];

  for (const report of reports) {
    if (report.callSid?.trim()) {
      const callSid = report.callSid.trim();
      const existing = byCallSid.get(callSid);
      if (!existing) {
        byCallSid.set(callSid, report);
      } else {
        // Keep the one with the later timestamp (most complete report)
        const existingTime = Date.parse(existing.conversationDate || "") || 0;
        const reportTime = Date.parse(report.conversationDate || "") || 0;
        if (reportTime > existingTime) {
          byCallSid.set(callSid, report);
        }
      }
    } else {
      withoutCallSid.push(report);
    }
  }

  // Second pass: Deduplicate remaining reports without callSid by leadId or composite key
  const byFallbackKey = new Map<string, CallReport>();
  for (const report of withoutCallSid) {
    const key = report.leadId?.trim() || `${report.company || "?"}::${report.topic || "?"}::${report.conversationDate || "?"}`;
    if (!key) continue;

    const existing = byFallbackKey.get(key);
    if (!existing) {
      byFallbackKey.set(key, report);
    } else {
      const existingTime = Date.parse(existing.conversationDate || "") || 0;
      const reportTime = Date.parse(report.conversationDate || "") || 0;
      if (reportTime > existingTime) {
        byFallbackKey.set(key, report);
      }
    }
  }

  const allReports = [...byCallSid.values(), ...byFallbackKey.values()];
  return allReports.sort((a, b) => {
    const aTime = Date.parse(a.conversationDate || "") || 0;
    const bTime = Date.parse(b.conversationDate || "") || 0;
    return bTime - aTime;
  });
}

export async function getDashboardData(options?: { userId?: string; role?: "master" | "user" }): Promise<DashboardData> {
  const userId = options?.userId;
  // Tenant isolation: sobald ein userId-Kontext vorhanden ist, werden
  // Reports/Leads/Events strikt auf diesen User gescoped.
  const scopeReportsToUser = Boolean(userId);
  const scopedUserId = scopeReportsToUser ? userId : undefined;
  const [leads, reportState, scriptsState, events] = await Promise.all([
    readLeads(scopedUserId),
    readReportDatabaseWithMode(scopedUserId),
    readScriptsWithMode(userId),
    readConversationEvents(scopedUserId),
  ]);

  const reports = deduplicateReports(reportState.data.reports);

  return {
    leads,
    reports,
    topicPolicies: scriptsState.data,
    metrics: buildMetrics(leads, reports, events),
    reportStorageMode: reportState.mode,
    topicPoliciesStorageMode: scriptsState.mode,
  };
}

export async function importLeadsFromCsv(
  csvText: string,
  options?: { listId?: string; listName?: string; userId?: string; overrideTopic?: string },
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
    const location = lookup("location");
    const topic = options?.overrideTopic || lookup("topic");

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
      location: location || undefined,
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
  if (options?.userId) {
    const user = await findUserById(options.userId);
    if (!user) {
      throw new Error("Benutzer nicht gefunden.");
    }

    if (user.allowedPlaybookTopics.length > 0 && !user.allowedPlaybookTopics.includes(topic)) {
      throw new Error(`Das Thema "${topic}" ist für diesen Benutzer nicht freigegeben.`);
    }
  }

  const scripts = await readScripts(options?.userId);
  const existing = scripts.find((script) => script.topic === topic);
  const updatedScript: ScriptConfig = {
    id: existing?.id || `playbook-${topic.toLowerCase().replace(/\s+/g, "-")}`,
    topic,
    topicSummary: existing?.topicSummary || "",
    behavior: existing?.behavior || "",
    conversationGuardrails: existing?.conversationGuardrails || "",
    requiredQuestions: existing?.requiredQuestions || "",
    opener: existing?.opener || "",
    discovery: existing?.discovery || "",
    objectionHandling: existing?.objectionHandling || "",
    close: existing?.close || "",
    ...payload,
  };

  const updated = existing
    ? scripts.map((script) => (script.topic === topic ? updatedScript : script))
    : [updatedScript, ...scripts];

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
    company: payload.company,
    topic: payload.topic,
  });

  const reportDb = await readReportDatabase();
  const reports = reportDb.reports;
  const callSid = payload.callSid?.trim() || undefined;

  const existingIndex = callSid
    ? reports.findIndex((report) => report.callSid?.trim() === callSid)
    : -1;
  const existingReport = existingIndex >= 0 ? reports[existingIndex] : undefined;

  let resolvedUserId = payload.userId || existingReport?.userId;

  if (!resolvedUserId && payload.leadId) {
    const existingLead = await getLeadById(payload.leadId);
    if (existingLead?.userId) {
      resolvedUserId = existingLead.userId;
    }
  }

  const leads = await readLeads(resolvedUserId);

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
    userId: resolvedUserId || existingReport?.userId,
    phoneNumberId: payload.phoneNumberId || existingReport?.phoneNumberId,
    callSid: callSid || existingReport?.callSid,
    leadId: payload.leadId || existingReport?.leadId,
    directDial: payload.directDial || existingReport?.directDial,
    company: payload.company,
    contactName: payload.contactName || existingReport?.contactName,
    topic: payload.topic,
    summary: mergedSummary,
    outcome: payload.outcome || existingReport?.outcome || "Nicht erreicht / kein Kontakt",
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

  const updatedReports = callSid
    ? reports.filter((report, index) => index === existingIndex || report.callSid?.trim() !== callSid)
    : [...reports];
  const updatedIndex = callSid
    ? updatedReports.findIndex((report) => report.callSid?.trim() === callSid)
    : existingIndex;

  if (updatedIndex >= 0) {
    updatedReports[updatedIndex] = report;
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
      payload.outcome === "Nicht erreicht / kein Kontakt" &&
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
    } else if (payload.outcome === "Gespräch abgebrochen") {
      resolvedStatus = "angerufen";
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
    writeLeads(updatedLeads, resolvedUserId),
  ]);

  // Live-Monitor: Terminal-Event mit dem finalen Outcome anhaengen, damit
  // der Live-Monitor das Gespraech als beendet markieren kann.
  if (payload.outcome && payload.callSid && payload.company && payload.topic) {
    const outcomeToEventType: Record<ReportOutcome, string> = {
      Termin: "appointment_booked",
      Absage: "rejection_final",
      Wiedervorlage: "callback_scheduled",
      "Nicht erreicht / kein Kontakt": "call_completed",
      "Gespräch abgebrochen": "call_completed",
    };
    await appendConversationEvent(
      {
        callSid: payload.callSid,
        company: payload.company,
        topic: payload.topic,
        step: "finished",
        eventType: outcomeToEventType[payload.outcome] || "call_completed",
        text: payload.appointmentAt
          ? `Termin: ${payload.appointmentAt}`
          : payload.nextCallAt
            ? `Wiedervorlage: ${payload.nextCallAt}`
            : undefined,
      },
      { userId: resolvedUserId },
    );
  }

  return report;
}

export async function getLatestReportSummaryForLead(
  leadId: string,
  userId?: string,
): Promise<string | undefined> {
  if (!leadId) return undefined;
  const reportDb = await readReportDatabase(userId);
  const candidates = reportDb.reports
    .filter((r) => r.leadId === leadId && (!userId || r.userId === userId))
    .filter((r) => r.summary && !/^Automatischer Wiedervorlage-Anruf gestartet/i.test(r.summary));
  if (candidates.length === 0) return undefined;
  candidates.sort(
    (a, b) => Date.parse(b.conversationDate || "") - Date.parse(a.conversationDate || ""),
  );
  return candidates[0].summary;
}

export async function listDueCallbackLeads(limit = 25): Promise<Lead[]> {
  const [leads, campaignState] = await Promise.all([
    readLeads(),
    readCampaignState(),
  ]);

  const activeListsByUser = new Map<string, Set<string>>();
  for (const entry of campaignState.lists) {
    if (!entry.active) continue;
    const userKey = entry.userId || "__global__";
    if (!activeListsByUser.has(userKey)) {
      activeListsByUser.set(userKey, new Set());
    }
    activeListsByUser.get(userKey)!.add(entry.listId || "legacy");
  }

  const now = Date.now();

  return leads
    .filter((lead) => {
      const userKey = lead.userId || "__global__";
      const activeLists = activeListsByUser.get(userKey);
      const listId = lead.listId || "legacy";
      if (!activeLists || !activeLists.has(listId)) {
        return false;
      }

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
    currentlyDialing: boolean;
    total: number;
    pending: number;
    called: number;
    appointments: number;
    callbacks: number;
    rejections: number;
  }>
> {
  const [leads, campaignState, scopedEvents, globalEvents] = await Promise.all([
    readLeads(userId),
    readCampaignState(userId),
    getRecentConversationEvents({ userId, minutes: 20, limit: 400 }),
    userId ? getRecentConversationEvents({ minutes: 20, limit: 400 }) : Promise.resolve([]),
  ]);

  const eventMap = new Map<string, ConversationEvent>();
  for (const event of [...scopedEvents, ...globalEvents]) {
    eventMap.set(event.id, event);
  }
  const recentEvents = [...eventMap.values()];

  const terminalEvents = new Set([
    "call_completed",
    "call_ended",
    "hangup",
    "appointment_booked",
    "rejection_final",
    "transfer_failed",
  ]);

  const orderedEvents = [...recentEvents].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const activeSessions = new Map<string, { company: string; topic: string; lastEventType: string }>();

  for (const event of orderedEvents) {
    const key = event.callSid || `no-sid-${event.company}-${event.topic}`;
    activeSessions.set(key, {
      company: event.company,
      topic: event.topic,
      lastEventType: event.eventType,
    });
  }

  const currentlyDialingListIds = new Set<string>();
  for (const session of activeSessions.values()) {
    if (terminalEvents.has(session.lastEventType)) {
      continue;
    }

    for (const lead of leads) {
      const sameCompany = lead.company.trim().toLowerCase() === session.company.trim().toLowerCase();
      const sameTopic = String(lead.topic || "").trim() === String(session.topic || "").trim();
      if (!sameCompany || !sameTopic) {
        continue;
      }

      currentlyDialingListIds.add(lead.listId || "legacy");
    }
  }

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
      currentlyDialing: currentlyDialingListIds.has(list.listId),
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
