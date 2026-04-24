import { NextResponse } from "next/server";
import { sendAppointmentInvite, sendReportEmail } from "@/lib/mailer";
import { getLeadById, storeCallReport } from "@/lib/storage";
import { findUserById } from "@/lib/report-db";
import type { ReportOutcome, Topic } from "@/lib/types";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    userId?: string;
    phoneNumberId?: string;
    callSid?: string;
    leadId?: string;
    company?: string;
    contactName?: string;
    topic?: Topic;
    summary?: string;
    summaryChunk?: string;
    outcome?: ReportOutcome;
    appointmentAt?: string;
    nextCallAt?: string;
    directDial?: string;
    attempts?: number;
    recordingConsent?: boolean;
    recordingUrl?: string;
  };

  if (!payload.company || !payload.topic || !payload.summary || !payload.outcome) {
    if (payload.callSid && payload.company && payload.topic && payload.summaryChunk?.trim()) {
      const report = await storeCallReport({
        userId: payload.userId,
        phoneNumberId: payload.phoneNumberId,
        callSid: payload.callSid,
        leadId: payload.leadId,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        summaryChunk: payload.summaryChunk,
        attempts: payload.attempts,
      });

      return NextResponse.json({
        ok: true,
        transcriptUpdated: true,
        report,
      });
    }

    if (payload.callSid && payload.company && payload.topic && payload.recordingUrl) {
      const report = await storeCallReport({
        userId: payload.userId,
        phoneNumberId: payload.phoneNumberId,
        callSid: payload.callSid,
        leadId: payload.leadId,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        recordingConsent: payload.recordingConsent,
        recordingUrl: payload.recordingUrl,
        attempts: payload.attempts,
      });

      return NextResponse.json({
        ok: true,
        recordingUpdated: true,
        report,
      });
    }

    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "Unvollstaendiger Callback-Payload ohne Abschlussbericht.",
    });
  }

  const report = await storeCallReport({
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    callSid: payload.callSid,
    leadId: payload.leadId,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    summary: payload.summary,
    summaryChunk: payload.summaryChunk,
    outcome: payload.outcome,
    appointmentAt: payload.appointmentAt,
    nextCallAt: payload.nextCallAt,
    directDial: payload.directDial,
    attempts: payload.attempts,
    recordingConsent: payload.recordingConsent,
    recordingUrl: payload.recordingUrl,
  });

  const emailResult = await sendReportEmail(report);

  let inviteResult:
    | { delivered: boolean; to?: string | string[]; reason?: string; messageId?: string }
    | undefined;

  if (report.outcome === "Termin" && report.appointmentAt) {
    const lead = report.leadId
      ? await getLeadById(report.leadId, report.userId)
      : undefined;
    const user = report.userId ? await findUserById(report.userId) : null;

    inviteResult = await sendAppointmentInvite({
      report,
      attendeeEmail: lead?.email,
      organizerName: user?.realName || user?.companyName,
    });
  }

  return NextResponse.json({
    ok: true,
    report,
    emailResult,
    inviteResult,
  });
}
