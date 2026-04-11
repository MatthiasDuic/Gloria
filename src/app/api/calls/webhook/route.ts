import { NextResponse } from "next/server";
import { sendReportEmail } from "@/lib/mailer";
import { storeCallReport } from "@/lib/storage";
import type { ReportOutcome, Topic } from "@/lib/types";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    leadId?: string;
    company?: string;
    contactName?: string;
    topic?: Topic;
    summary?: string;
    outcome?: ReportOutcome;
    appointmentAt?: string;
    nextCallAt?: string;
    attempts?: number;
    recordingConsent?: boolean;
    recordingUrl?: string;
  };

  if (!payload.company || !payload.topic || !payload.summary || !payload.outcome) {
    return NextResponse.json(
      { error: "company, topic, summary und outcome sind erforderlich." },
      { status: 400 },
    );
  }

  const report = await storeCallReport({
    leadId: payload.leadId,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    summary: payload.summary,
    outcome: payload.outcome,
    appointmentAt: payload.appointmentAt,
    nextCallAt: payload.nextCallAt,
    attempts: payload.attempts,
    recordingConsent: payload.recordingConsent,
    recordingUrl: payload.recordingUrl,
  });

  const emailResult = await sendReportEmail(report);

  return NextResponse.json({
    ok: true,
    report,
    emailResult,
  });
}
