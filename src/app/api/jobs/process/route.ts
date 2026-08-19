import { NextResponse } from "next/server";
import { globalJobQueue, type Job } from "@/lib/job-queue";
import { sendReportEmail, sendAppointmentInvite } from "@/lib/mailer";
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
  };
  if (!payload.report) {
    throw new Error("No report in invite job payload");
  }

  try {
    const report = payload.report;
    // Simplified invite sending without complex basis question collection
    // In production, this would look up the lead email from leadId
    const result = await sendAppointmentInvite({
      report,
      attendeeEmail: undefined, // Simplified: let mailer handle default
      organizerName: "Gloria Consultant",
      missingBasisQuestions: [],
    });

    if (!result.delivered) {
      throw new Error(`Invite delivery failed: ${result.reason}`);
    }
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  // Verify this is an internal request
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.APP_INTERNAL_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { maxJobs = 5 } = (await request.json().catch(() => ({}))) as { maxJobs?: number };

  let processed = 0;
  let failed = 0;

  // Process up to maxJobs from the queue
  for (let i = 0; i < maxJobs; i++) {
    const job = globalJobQueue.dequeue();
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

      globalJobQueue.markSuccess(job.id);
      processed++;
    } catch (error) {
      console.error(`Job ${job.id} failed:`, error);
      globalJobQueue.markFailure(job.id, error instanceof Error ? error : new Error(String(error)));
      failed++;
    }
  }

  const stats = globalJobQueue.getStats();

  return NextResponse.json({
    ok: true,
    processed,
    failed,
    queueStats: stats,
  });
}

export async function GET(): Promise<NextResponse> {
  const stats = globalJobQueue.getStats();
  const jobs = globalJobQueue.getAllJobs().slice(-20); // Last 20 jobs

  return NextResponse.json({
    stats,
    recentJobs: jobs,
  });
}
