import { NextResponse } from "next/server";
import { globalJobQueue, type Job } from "@/lib/job-queue";
import { sendReportEmail } from "@/lib/mailer";
import type { CallReport } from "@/lib/types";

export const maxDuration = 300; // 5 minutes for job processing

// Gloria versendet keine Kundenmails mehr; bereits eingereihte Altjobs werden verworfen.
const DISCARDED_LEGACY_JOB_TYPES = new Set<string>(["send_invite", "extract_report"]);

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
      } else if (DISCARDED_LEGACY_JOB_TYPES.has(job.type)) {
        console.info("job.legacy_discarded", { jobId: job.id, type: job.type });
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
