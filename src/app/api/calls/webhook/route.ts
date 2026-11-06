import { NextResponse } from "next/server";
import { sendReportEmail } from "@/lib/mailer";
import { getDashboardData, getLeadById, storeCallReport, updateLeadDetails } from "@/lib/storage";
import {
  appendCallTranscriptEventToPostgres,
  appendCallTranscriptEventsToPostgres,
  listCallTranscriptEventsFromPostgres,
  releaseCampaignCallLock,
  type TranscriptEvent,
} from "@/lib/report-db";
import { globalJobQueue } from "@/lib/job-queue";
import { APPOINTMENT_EMAIL_PATTERN } from "@/lib/appointment-confirmation";
import { buildReportTranscriptFallback } from "@/lib/transcript-utils";
import { syncCrmCompanyEvent } from "@/lib/crm-sync";
import { isDoNotCallRequest, suppressPhoneNumber } from "@/lib/call-safety";
import type { ReportOutcome, Topic } from "@/lib/types";

export const maxDuration = 60;

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

type TranscriptSpeakerEntry = Pick<TranscriptEvent, "speaker" | "text">;

function normalizePotentialEmail(raw: string): string {
  return normalizeText(raw)
    .replace(/\s*\b(klammeraffe|at|aett?)\b\s*/g, "@")
    .replace(/\s*\b(punkt|dot)\b\s*/g, ".")
    .replace(/\s*\b(bindestrich|minus|dash)\b\s*/g, "-")
    .replace(/\s*\b(unterstrich|underscore)\b\s*/g, "_")
    .replace(/[<>()[\],;:"']/g, " ")
    .replace(/\s+([@._+-])\s+/g, "$1")
    .replace(/\s*@\s*/g, "@")
    .replace(/\b(?:[a-z0-9]\s+)+[a-z0-9]\b/g, (letters) => letters.replace(/\s+/g, ""));
}

function inferAttendeeEmailFromTranscript(events: TranscriptSpeakerEntry[]): string | undefined {
  const emailRegex = APPOINTMENT_EMAIL_PATTERN;

  // 1) Bevorzugt: Antwort auf konkrete E-Mail-Frage von Gloria.
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.speaker !== "Gloria") continue;
    if (!/e-?mail|mailadresse|terminbestaetigung/i.test(normalizeText(event.text || ""))) continue;

    const userParts: string[] = [];
    for (let lookahead = index + 1; lookahead < events.length; lookahead += 1) {
      const candidate = events[lookahead];
      if (candidate.speaker === "Gloria") break;
      if (candidate.speaker === "Interessent" && candidate.text?.trim()) {
        userParts.push(candidate.text.trim());
      }
      if (userParts.length >= 4) break;
    }

    if (userParts.length > 0) {
      const answer = userParts.join(" ");
      const directMatch = answer.match(emailRegex);
      if (directMatch?.[0]) return directMatch[0].toLowerCase();
      const normalized = normalizePotentialEmail(answer);
      const match = normalized.match(emailRegex);
      if (match?.[0]) return match[0].toLowerCase();
    }
  }

  // 2) Fallback: irgendeine Nutzer-Aussage mit direktem @.
  for (const event of events) {
    if (event.speaker !== "Interessent") continue;
    const match = (event.text || "").match(emailRegex);
    if (match?.[0]) return match[0].toLowerCase();
  }

  return undefined;
}

function buildFinalSummary(summary: string, transcript: IncomingTranscriptEntry[] | undefined, confirmationEmail?: string): string {
  const emailLine = confirmationEmail ? `E-Mail für die Terminbestätigung: ${confirmationEmail}` : "";
  const transcriptFallback = buildReportTranscriptFallback(transcript);
  return [summary, emailLine, transcriptFallback].filter(Boolean).join("\n\n");
}

// Gloria versendet selbst keine Mails; die genannte Adresse wird für den manuellen Versand beim Lead hinterlegt.
async function rememberConfirmationEmail(report: Awaited<ReturnType<typeof storeCallReport>>, confirmationEmail?: string) {
  if (!confirmationEmail || !report.leadId || !report.userId) return;
  try {
    const lead = await getLeadById(report.leadId, report.userId);
    if (lead && !lead.email?.trim()) {
      await updateLeadDetails(lead.id, { email: confirmationEmail }, report.userId);
    }
  } catch (error) {
    console.error("appointment_confirmation.lead_email_update_failed", { reportId: report.id, error });
  }
}

type IncomingTranscriptEntry = {
  role?: "user" | "assistant";
  speaker?: string;
  text?: string;
  at?: number;
  latencyMs?: number;
  phase?: string;
};

async function persistTranscriptArray(
  entries: IncomingTranscriptEntry[] | undefined,
  callSid: string | undefined,
  userId: string | undefined,
) {
  if (!Array.isArray(entries) || entries.length === 0 || !callSid) {
    return { inputCount: Array.isArray(entries) ? entries.length : 0, normalizedCount: 0, persisted: true, events: [] as TranscriptEvent[] };
  }
  const transcriptEvents = entries.flatMap((entry) => {
    const text = (entry.text || "").trim();
    if (!text) return [];
    const speaker: "Gloria" | "Interessent" =
      entry.speaker === "Gloria" || entry.role === "assistant" ? "Gloria" : "Interessent";
    return [{
      callSid,
      userId,
      speaker,
      text,
      phase: entry.phase,
      latencyMs:
        speaker === "Gloria" && typeof entry.latencyMs === "number"
          ? entry.latencyMs
          : undefined,
      spokenAt: typeof entry.at === "number" ? entry.at : undefined,
    }];
  });
  let persisted = false;
  let attempts = 0;
  for (attempts = 1; attempts <= 3; attempts += 1) {
    persisted = await appendCallTranscriptEventsToPostgres(transcriptEvents);
    if (persisted) break;
    await new Promise((resolve) => setTimeout(resolve, attempts * 200));
  }
  return {
    inputCount: entries.length,
    normalizedCount: transcriptEvents.length,
    persisted,
    attempts,
    events: transcriptEvents,
  };
}

async function syncCrmCallReport(report: Awaited<ReturnType<typeof storeCallReport>>) {
  if (!report.userId || !report.leadId) return;
  const lead = await getLeadById(report.leadId, report.userId);
  if (!lead || lead.callSource !== "crm" || !lead.crmCompanyId) return;

  const summary = report.summary.split(/\n---\s*GESPRAECHSPROTOKOLL\b/i)[0].trim();
  const noteText = [
    `Gloria-Gespräch am ${report.conversationDate}`,
    `Ergebnis: ${report.resultDetail && report.resultDetail !== report.outcome ? `${report.outcome} (${report.resultDetail})` : report.outcome}`,
    `Thema: ${report.topic}`,
    report.contactName ? `Ansprechpartner: ${report.contactName}` : "",
    summary,
  ].filter(Boolean).join("\n");
  const appointment = report.outcome === "Termin" && report.appointmentAt
    ? {
      scheduledAt: report.appointmentAt,
      title: `Gloria-Beratungstermin – ${report.topic}`,
      description: `Im Gloria-Gespräch vereinbarter Termin. Thema: ${report.topic}${report.appointmentMode ? `; Modus: ${report.appointmentMode}` : ""}.`,
      contactPerson: report.contactName,
    }
    : undefined;

  try {
    await syncCrmCompanyEvent(report.userId, {
      eventId: `gloria-call-${report.id}`,
      companyId: lead.crmCompanyId,
      note: { text: noteText.slice(0, 9_500) },
      appointment,
    });
  } catch (error) {
    console.error("Gloria call result could not be synchronized with CRM:", {
      reportId: report.id,
      companyId: lead.crmCompanyId,
      error,
    });
    throw error;
  }
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    userId?: string;
    phoneNumberId?: string;
    callSid?: string;
    leadId?: string;
    callSource?: "crm" | "manual";
    company?: string;
    contactName?: string;
    topic?: Topic;
    summary?: string;
    summaryChunk?: string;
    outcome?: ReportOutcome;
    appointmentAt?: string;
    appointmentMode?: string;
    calledPhone?: string;
    nextCallAt?: string;
    directDial?: string;
    attempts?: number;
    recordingConsent?: boolean;
    recordingUrl?: string;
    transcript?: IncomingTranscriptEntry[];
    conversationOccurred?: boolean;
    callDisposition?: string;
    resultDetail?: string;
    followUpPlanned?: boolean;
    followUpAt?: string;
  };

  const internalToken = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!internalToken) return NextResponse.json({ error: "Internal authentication is not configured" }, { status: 503 });
  if (internalToken) {
    const provided = request.headers.get("x-gloria-internal-token");
    if (provided !== internalToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  payload.recordingConsent = false;
  payload.recordingUrl = undefined;
  if (payload.userId && payload.calledPhone && Array.isArray(payload.transcript)
    && payload.transcript.some((entry) => (entry.role === "user" || entry.speaker === "Interessent") && isDoNotCallRequest(entry.text || ""))) {
    await suppressPhoneNumber(payload.userId, payload.calledPhone);
  }

  // Transcript always persisted regardless of recording consent (for report detail).
  if (payload.callSource !== undefined && payload.callSource !== "crm" && payload.callSource !== "manual") {
    return NextResponse.json({ error: "Ungültiger Anrufbereich." }, { status: 400 });
  }
  const transcriptPersist = await persistTranscriptArray(payload.transcript, payload.callSid, payload.userId);
  if (!transcriptPersist.persisted && transcriptPersist.normalizedCount > 0) {
    console.warn("transcript.persist_failed", {
      callSid: payload.callSid,
      inputCount: transcriptPersist.inputCount,
      normalizedCount: transcriptPersist.normalizedCount,
      attempts: transcriptPersist.attempts,
    });
  }

  if (!payload.company || !payload.topic || !payload.summary || !payload.outcome) {
    // Recovery path for incomplete finalize payloads: if leadId/callSid is present,
    // derive missing context (company/topic/userId) from lead or existing report.
    if (payload.summary && payload.outcome && (payload.leadId || payload.callSid)) {
      const dashboard = payload.userId
        ? await getDashboardData({ userId: payload.userId, role: "user" })
        : await getDashboardData();
      const existingByCallSid = payload.callSid
        ? dashboard.reports.find((entry) => entry.callSid === payload.callSid)
        : undefined;
      const recoveredUserId = payload.userId || existingByCallSid?.userId;
      const lead = payload.leadId ? await getLeadById(payload.leadId, recoveredUserId) : undefined;

      const recoveredCompany =
        payload.company || existingByCallSid?.company || lead?.company;
      const recoveredTopic =
        payload.topic || existingByCallSid?.topic || lead?.topic;
      const finalUserId = recoveredUserId || lead?.userId;
      const recoveredContactName =
        payload.contactName || existingByCallSid?.contactName || lead?.contactName;

      if (recoveredCompany && recoveredTopic) {
        const confirmationEmail = payload.outcome === "Termin"
          ? inferAttendeeEmailFromTranscript(transcriptPersist.events)
          : undefined;
        const finalSummary = buildFinalSummary(payload.summary, payload.transcript, confirmationEmail);
        const report = await storeCallReport({
          callSource: payload.callSource,
          userId: finalUserId,
          phoneNumberId: payload.phoneNumberId || existingByCallSid?.phoneNumberId,
          callSid: payload.callSid,
          leadId: payload.leadId || existingByCallSid?.leadId,
          company: recoveredCompany,
          contactName: recoveredContactName,
          topic: recoveredTopic,
          summary: finalSummary,
          summaryChunk: payload.summaryChunk,
          outcome: payload.outcome,
          appointmentAt: payload.appointmentAt,
          appointmentMode: payload.appointmentMode,
          calledPhone: payload.calledPhone,
          nextCallAt: payload.nextCallAt,
          callDisposition: payload.callDisposition,
          resultDetail: payload.resultDetail,
          directDial: payload.directDial,
          attempts: payload.attempts,
          recordingConsent: payload.recordingConsent,
          recordingUrl: payload.recordingUrl,
        });

        await syncCrmCallReport(report);
        await rememberConfirmationEmail(report, confirmationEmail);
        return NextResponse.json({
          ok: true,
          recoveredFinalizePayload: true,
          report,
        });
      }
    }

    if (payload.callSid && payload.company && payload.topic && payload.summaryChunk?.trim()) {
      const report = await storeCallReport({
        callSource: payload.callSource,
        userId: payload.userId,
        phoneNumberId: payload.phoneNumberId,
        callSid: payload.callSid,
        leadId: payload.leadId,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        summaryChunk: payload.summaryChunk,
        outcome: payload.outcome,
        appointmentAt: payload.appointmentAt,
        appointmentMode: payload.appointmentMode,
        calledPhone: payload.calledPhone,
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
        callSource: payload.callSource,
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

    // Telnyx liefert bei recording-events vereinzelt kein client_state.
    // Dann fehlt company/topic im Payload, obwohl ein Platzhalter-Report
    // mit callSid schon existiert. In diesem Fall das Recording per callSid
    // an den bestehenden Report anhängen.
    if (payload.callSid && payload.recordingUrl) {
      const dashboard = payload.userId
        ? await getDashboardData({ userId: payload.userId, role: "user" })
        : await getDashboardData();
      const existing = dashboard.reports.find((entry) => entry.callSid === payload.callSid);

      if (existing) {
        const report = await storeCallReport({
          callSource: payload.callSource,
          userId: payload.userId || existing.userId,
          phoneNumberId: payload.phoneNumberId || existing.phoneNumberId,
          callSid: payload.callSid,
          leadId: payload.leadId || existing.leadId,
          company: existing.company,
          contactName: payload.contactName || existing.contactName,
          topic: existing.topic,
          recordingConsent: payload.recordingConsent ?? existing.recordingConsent,
          recordingUrl: payload.recordingUrl,
          attempts: payload.attempts,
        });

        return NextResponse.json({
          ok: true,
          recordingUpdated: true,
          recoveredByCallSid: true,
          report,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "Unvollstaendiger Callback-Payload ohne Abschlussbericht.",
    });
  }

  const confirmationEmail = payload.outcome === "Termin" && payload.appointmentAt
    ? inferAttendeeEmailFromTranscript(transcriptPersist.events)
    : undefined;
  const finalSummary = buildFinalSummary(payload.summary, payload.transcript, confirmationEmail);
  const report = await storeCallReport({
    callSource: payload.callSource,
    userId: payload.userId,
    phoneNumberId: payload.phoneNumberId,
    callSid: payload.callSid,
    leadId: payload.leadId,
    company: payload.company,
    contactName: payload.contactName,
    topic: payload.topic,
    summary: finalSummary,
    summaryChunk: payload.summaryChunk,
    outcome: payload.outcome,
    appointmentAt: payload.appointmentAt,
    appointmentMode: payload.appointmentMode,
    calledPhone: payload.calledPhone,
    nextCallAt: payload.nextCallAt,
    callDisposition: payload.callDisposition,
    resultDetail: payload.resultDetail,
    directDial: payload.directDial,
    attempts: payload.attempts,
    recordingConsent: payload.recordingConsent,
    recordingUrl: payload.recordingUrl,
  });
  await syncCrmCallReport(report);
  await rememberConfirmationEmail(report, confirmationEmail);

  let emailResult: Awaited<ReturnType<typeof sendReportEmail>>;
  // Enqueue email job asynchronously instead of blocking
  {
    const jobId = await globalJobQueue.enqueue("send_email", report.callSid || "unknown", {
      reportId: report.id,
      report,
    });
    emailResult = {
      delivered: false,
      to: process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
      reason: `Email queued for delivery (jobId: ${jobId})`,
    };
  }

  return NextResponse.json({
    ok: true,
    report,
    emailResult,
    confirmationEmail,
    transcript: {
      persisted: transcriptPersist.persisted,
      events: transcriptPersist.normalizedCount,
      attempts: transcriptPersist.attempts,
    },
  });
}
