import { NextResponse } from "next/server";
import {
  getLatestReportSummaryForLead,
  isCampaignListActive,
  listDueCallbackLeads,
  markLeadCallbackScheduled,
  buildLeadCallContext,
} from "@/lib/storage";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { isWithinCampaignHours } from "@/lib/campaign-schedule";
import { sendOperationalEmail } from "@/lib/mailer";
import { normalizePhoneForDial } from "@/lib/phone-utils";
import { isDueGloriaTask } from "@/lib/crm-helpers";
import { queueOutboundCall } from "@/lib/outbound-call-queue";

export const runtime = "nodejs";

const MAX_PER_RUN = 20;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function logLine(parts: Record<string, unknown>) {
  console.info(JSON.stringify({ scope: "callbacks_run", ...parts }));
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  const startedAt = Date.now();

  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1";

  if (!force && !isWithinCampaignHours()) {
    logLine({ event: "skipped", reason: "outside_business_hours" });
    return NextResponse.json({ ok: true, skipped: true, reason: "outside_business_hours" });
  }

  if (!isTelnyxConfigured()) {
    logLine({ event: "skipped", reason: "telnyx_not_configured" });
    return NextResponse.json({ error: "Telnyx is not configured.", processed: 0, triggered: 0 }, { status: 400 });
  }

  const dueLeads = await listDueCallbackLeads(MAX_PER_RUN);
  logLine({ event: "start", due: dueLeads.length });

  const triggered: Array<{ leadId: string; queueId: string; to: string; company: string }> = [];
  const failed: Array<{ leadId: string; company: string; reason: string }> = [];

  for (const lead of dueLeads) {
    const now = Date.now();
    const dueGloriaTask = (lead.tasks || [])
      .filter((task) => isDueGloriaTask(task, now))
      .sort((a, b) => Date.parse(a.dueAt || "") - Date.parse(b.dueAt || ""))[0];

    // Hard stop guard: callbacks must pause immediately after list stop and
    // continue only when list gets started again. Explicit Gloria tasks are
    // independent CRM reminders and do not require an active campaign.
    const listId = lead.listId || "legacy";
    const stillActive = await isCampaignListActive(listId, lead.userId);
    if (!stillActive && !dueGloriaTask && lead.callSource !== "manual") {
      const reason = "list_not_active";
      failed.push({ leadId: lead.id, company: lead.company, reason });
      logLine({ event: "skip_lead", leadId: lead.id, reason });
      continue;
    }

    const rawTo = (lead.directDial || lead.phone || "").trim();
    const to = normalizePhoneForDial(rawTo);

    if (!to) {
      const reason = rawTo ? "invalid_phone_format" : "missing_phone";
      failed.push({ leadId: lead.id, company: lead.company, reason });
      logLine({ event: "skip_lead", leadId: lead.id, reason });
      continue;
    }

    try {
      const rawSummary = await getLatestReportSummaryForLead(lead.id, lead.userId);
      const previousSummaryParts = [
        rawSummary ? rawSummary.replace(/\s+/g, " ").trim() : "",
        dueGloriaTask ? `Von Gloria zu erledigende Aufgabe: ${dueGloriaTask.title}` : "",
      ].filter(Boolean);
      const previousSummary = previousSummaryParts.join(" | ").slice(0, 800) || undefined;
      const queued = await queueOutboundCall({
        payload: {
          to,
          company: lead.company,
          contactName: lead.contactName,
          topic: dueGloriaTask?.topic || lead.topic,
          leadId: lead.id,
          callSource: lead.callSource || "crm",
          userId: lead.userId,
          leadNote: buildLeadCallContext(lead),
          previousSummary,
          isCallback: true,
        },
        request,
        report: {
          leadId: lead.id,
          callSource: lead.callSource || "crm",
          calledPhone: to,
          company: lead.company,
          contactName: lead.contactName,
          topic: dueGloriaTask?.topic || lead.topic,
          summary: dueGloriaTask
            ? `Automatischer Gloria-Aufgabenanruf gestartet: ${dueGloriaTask.title} (${new Date().toISOString()}).`
            : `Automatischer Wiedervorlage-Anruf gestartet (${new Date().toISOString()}).`,
          outcome: "Nicht erreicht / kein Kontakt",
          attempts: (lead.attempts || 0) + 1,
          userId: lead.userId,
        },
      });
      if (queued.status === "failed") {
        throw new Error(queued.error || "Anruf konnte nicht gestartet werden.");
      }

      await markLeadCallbackScheduled(lead.id, dueGloriaTask?.id);

      triggered.push({ leadId: lead.id, queueId: queued.queueId, to, company: lead.company });
      logLine({ event: "queued", leadId: lead.id, queueId: queued.queueId, position: queued.position, to, company: lead.company });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "call_start_failed";
      failed.push({ leadId: lead.id, company: lead.company, reason });
      logLine({ event: "dial_failed", leadId: lead.id, reason });
    }
  }

  const durationMs = Date.now() - startedAt;

  if (triggered.length > 0 || failed.length > 0) {
    const lines: string[] = [
      `Wiedervorlage-Lauf ${new Date().toISOString()}`,
      `Dauer: ${(durationMs / 1000).toFixed(1)}s`,
      `Faellig: ${dueLeads.length}`,
      `In Warteschlange: ${triggered.length}`,
      `Fehlgeschlagen: ${failed.length}`,
      "",
    ];

    if (triggered.length > 0) {
      lines.push("Zur Anruf-Warteschlange hinzugefügt:");
      for (const t of triggered) {
        lines.push(`  - ${t.company} (${t.to}) [queue=${t.queueId}]`);
      }
      lines.push("");
    }

    if (failed.length > 0) {
      lines.push("Fehler:");
      for (const f of failed) {
        lines.push(`  - ${f.company} [${f.leadId}]: ${f.reason}`);
      }
    }

    void sendOperationalEmail({
      subject: `Gloria Wiedervorlagen: ${triggered.length} eingereiht, ${failed.length} Fehler`,
      body: lines.join("\n"),
    }).catch((err) => {
      logLine({ event: "summary_mail_failed", reason: err instanceof Error ? err.message : "unknown" });
    });
  }

  logLine({ event: "done", processed: dueLeads.length, triggered: triggered.length, failed: failed.length, durationMs });

  return NextResponse.json({
    ok: true,
    processed: dueLeads.length,
    triggered: triggered.length,
    failed: failed.length,
    durationMs,
    calls: triggered,
    errors: failed,
  });
}
