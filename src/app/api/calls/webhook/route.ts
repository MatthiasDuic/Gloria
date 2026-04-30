import { NextResponse } from "next/server";
import { sendAppointmentInvite, sendReportEmail } from "@/lib/mailer";
import { getLeadById, storeCallReport } from "@/lib/storage";
import { appendCallTranscriptEventToPostgres, findUserById } from "@/lib/report-db";
import type { ReportOutcome, Topic } from "@/lib/types";

type IncomingTranscriptEntry = {
  role?: "user" | "assistant";
  speaker?: string;
  text?: string;
  at?: number;
  latencyMs?: number;
};

async function persistTranscriptArray(
  entries: IncomingTranscriptEntry[] | undefined,
  callSid: string | undefined,
  userId: string | undefined,
) {
  if (!Array.isArray(entries) || entries.length === 0 || !callSid) return;
  for (const entry of entries) {
    const text = (entry.text || "").trim();
    if (!text) continue;
    const speaker: "Gloria" | "Interessent" =
      entry.speaker === "Gloria" || entry.role === "assistant" ? "Gloria" : "Interessent";
    await appendCallTranscriptEventToPostgres({
      callSid,
      userId,
      speaker,
      text,
      latencyMs:
        speaker === "Gloria" && typeof entry.latencyMs === "number"
          ? entry.latencyMs
          : undefined,
      spokenAt: typeof entry.at === "number" ? entry.at : undefined,
    });
  }
}

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
    transcript?: IncomingTranscriptEntry[];
  };

  // Persistiere das vollständige Wort-für-Wort-Protokoll IMMER, sobald es vom
  // Worker mitkommt – unabhängig davon, ob der Anrufer der Aufnahme zugestimmt
  // hat. Damit ist das Gespräch im Report-Detail auswertbar, auch ohne Audio.
  await persistTranscriptArray(payload.transcript, payload.callSid, payload.userId);

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
