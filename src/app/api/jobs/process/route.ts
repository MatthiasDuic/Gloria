import { NextResponse } from "next/server";
import { globalJobQueue, type Job } from "@/lib/job-queue";
import { sendReportEmail, sendAppointmentInvite } from "@/lib/mailer";
import { buildAppointmentFormInputFromReport, buildAppointmentFormPdf, getAppointmentFormFilename } from "@/lib/appointment-form";
import { listCallTranscriptEventsFromPostgres } from "@/lib/report-db";
import { appointmentConfirmationDelivery } from "@/lib/appointment-confirmation";
import { appendLeadEmailHistory, getLeadById } from "@/lib/storage";
import type { CallReport } from "@/lib/types";

export const maxDuration = 300; // 5 minutes for job processing

async function processEmailJob(job: Job): Promise<void> {
  const payload = job.payload as { report?: CallReport; reportId?: string };
  if (!payload.report) {
    throw new Error("No report in email job payload");
  }

  try {
    const result = await sendReportEmail(payload.report);
    if (!result.delivered) {
      throw new Error(`Email delivery failed: ${result.reason}`);
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function processInviteJob(job: Job): Promise<void> {
  const payload = job.payload as {
    report?: CallReport;
    attendeeEmail?: string;
    missingBasisQuestions?: string[];
  };
  if (!payload.report) {
    throw new Error("No report in invite job payload");
  }
  if (await appointmentConfirmationDelivery(payload.report.userId) === "manual") {
    console.info("appointment_confirmation.skipped", { jobId: job.id, reason: "non_master" });
    return;
  }
  if (!payload.attendeeEmail) {
    throw new Error("Kunden-E-Mail-Adresse fehlt; Terminbestätigung wurde nicht an den Kunden versendet.");
  }

  try {
    const report = payload.report;
    const transcriptEvents = report.callSid
      ? await listCallTranscriptEventsFromPostgres(report.callSid)
      : [];
    const appointmentForm = buildAppointmentFormInputFromReport({ ...report, transcriptEvents });
    const appointmentPdf = await buildAppointmentFormPdf(appointmentForm);
    if (appointmentPdf.length < 1000) {
      throw new Error("Kundenterminbogen konnte nicht erzeugt werden.");
    }
    const result = await sendAppointmentInvite({
      report,
      attendeeEmail: payload.attendeeEmail,
      organizerName: "Gloria Consultant",
      missingBasisQuestions: payload.missingBasisQuestions || [],
      appointmentPdf,
      appointmentPdfFilename: getAppointmentFormFilename(appointmentForm),
    });

    if (!result.delivered && "skipped" in result && result.skipped) {
      console.info("appointment_confirmation.skipped", { jobId: job.id, reason: "non_master" });
      return;
    }
    if (!result.delivered) {
      throw new Error(`Invite delivery failed: ${result.reason}`);
    }

    if (report.leadId && report.userId) {
      try {
        const subject = report.appointmentAt
          ? `Terminbestaetigung versendet (${report.appointmentAt})`
          : "Terminbestaetigung versendet";
        const lead = await getLeadById(report.leadId, report.userId);
        if (!lead) {
          console.error("appointment_confirmation.history_lead_missing", { jobId: job.id, leadId: report.leadId });
        } else if (!(lead.emailHistory || []).some((entry) => entry.source === "gloria" && entry.subject === subject)) {
          const updated = await appendLeadEmailHistory(report.leadId, {
            source: "gloria",
            subject,
            body: "Automatische Terminbestaetigung durch Gloria.",
            to: payload.attendeeEmail,
          }, report.userId);
          if (!updated) console.error("appointment_confirmation.history_lead_missing", { jobId: job.id, leadId: report.leadId });
        }
      } catch (error) {
        console.error("appointment_confirmation.history_failed_after_send", { jobId: job.id, error });
      }
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Verify this is an internal request
  const authHeader = request.headers.get("authorization");
  if (![process.env.APP_INTERNAL_TOKEN, process.env.CRON_SECRET].filter(Boolean).some((token) => authHeader === `Bearer ${token}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { maxJobs = 5 } = (await request.json().catch(() => ({}))) as { maxJobs?: number };

  let processed = 0;
  let failed = 0;

  // Process up to maxJobs from the queue
  for (let i = 0; i < maxJobs; i++) {
    const job = await globalJobQueue.dequeue();
    if (!job) break;

    try {
      console.log(`Processing job ${job.id} (type: ${job.type}, attempt: ${job.attempts})`);

      if (job.type === "send_email") {
        await processEmailJob(job);
      } else if (job.type === "send_invite") {
        await processInviteJob(job);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }

      await globalJobQueue.markSuccess(job.id);
      processed++;
    } catch (error) {
      console.error(`Job ${job.id} failed:`, error);
      await globalJobQueue.markFailure(job.id, error instanceof Error ? error : new Error(String(error)));
      failed++;
    }
  }

  const stats = await globalJobQueue.getStats();

  return NextResponse.json({
    ok: true,
    processed,
    failed,
    queueStats: stats,
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
