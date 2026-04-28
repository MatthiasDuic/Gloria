import { NextResponse } from "next/server";
import {
  getLatestReportSummaryForLead,
  listDueCallbackLeads,
  markLeadCallbackScheduled,
  storeCallReport,
} from "@/lib/storage";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";
import { isWithinCampaignHours } from "@/lib/campaign-schedule";
import { sendOperationalEmail } from "@/lib/mailer";

export const runtime = "nodejs";

const DIAL_SPACING_MS = 30_000;
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

  if (!isTwilioConfigured()) {
    logLine({ event: "skipped", reason: "twilio_not_configured" });
    return NextResponse.json({ error: "Twilio is not configured.", processed: 0, triggered: 0 }, { status: 400 });
  }

  const dueLeads = await listDueCallbackLeads(MAX_PER_RUN);
  logLine({ event: "start", due: dueLeads.length });

  const triggered: Array<{ leadId: string; sid: string; to: string; company: string }> = [];
  const failed: Array<{ leadId: string; company: string; reason: string }> = [];

  for (let idx = 0; idx < dueLeads.length; idx++) {
    const lead = dueLeads[idx];
    const to = (lead.directDial || lead.phone || "").trim();

    if (!to) {
      failed.push({ leadId: lead.id, company: lead.company, reason: "missing_phone" });
      logLine({ event: "skip_lead", leadId: lead.id, reason: "missing_phone" });
      continue;
    }

    try {
      const rawSummary = await getLatestReportSummaryForLead(lead.id, lead.userId);
      const previousSummary = rawSummary
        ? rawSummary.replace(/\s+/g, " ").trim().slice(0, 800)
        : undefined;
      const call = await createTwilioCall(
        {
          to,
          company: lead.company,
          contactName: lead.contactName,
          topic: lead.topic,
          leadId: lead.id,
          userId: lead.userId,
          previousSummary,
          isCallback: true,
        },
        request,
      );

      await markLeadCallbackScheduled(lead.id);
      await storeCallReport({
        callSid: call.sid,
        leadId: lead.id,
        company: lead.company,
        contactName: lead.contactName,
        topic: lead.topic,
        summary: `Automatischer Wiedervorlage-Anruf gestartet (${new Date().toISOString()}).`,
        outcome: "Kein Kontakt",
        attempts: (lead.attempts || 0) + 1,
        userId: lead.userId,
      });

      triggered.push({ leadId: lead.id, sid: call.sid, to, company: lead.company });
      logLine({ event: "dialed", leadId: lead.id, sid: call.sid, to, company: lead.company });

      if (idx < dueLeads.length - 1) {
        await sleep(DIAL_SPACING_MS);
      }
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
      `Gestartet: ${triggered.length}`,
      `Fehlgeschlagen: ${failed.length}`,
      "",
    ];

    if (triggered.length > 0) {
      lines.push("Erfolgreich gestartete Anrufe:");
      for (const t of triggered) {
        lines.push(`  - ${t.company} (${t.to}) [sid=${t.sid}]`);
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
      subject: `Gloria Wiedervorlage-Lauf: ${triggered.length} Anrufe, ${failed.length} Fehler`,
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
