import { NextResponse } from "next/server";
import { sendAppointmentInvite, sendReportEmail } from "@/lib/mailer";
import { getDashboardData, getLeadById, storeCallReport } from "@/lib/storage";
import {
  appendCallTranscriptEventToPostgres,
  findUserById,
  listCallTranscriptEventsFromPostgres,
  releaseCampaignCallLock,
  type TranscriptEvent,
} from "@/lib/report-db";
import type { ReportOutcome, Topic } from "@/lib/types";

export const maxDuration = 60;

const BASIS_FIELD_RULES: Array<{
  key:
    | "birthDate"
    | "height"
    | "weight"
    | "insurer"
    | "monthlyPremium"
    | "diagnoses"
    | "medication"
    | "hospitalStays"
    | "psychTreatment"
    | "teeth"
    | "allergies";
  question: string;
  promptPatterns: RegExp[];
  answerPatterns?: RegExp[];
}> = [
  {
    key: "birthDate",
    question: "Geburtsdatum",
    promptPatterns: [/geburtsdatum|geboren/i],
    answerPatterns: [/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/i],
  },
  {
    key: "height",
    question: "Koerpergroesse (cm)",
    promptPatterns: [/k[oö]rpergr[oö][sß]e|groesse|gr[oö][sß]e/i],
    answerPatterns: [/\b(1\d{2}|2\d{2})\s*(cm|zentimeter)\b/i],
  },
  {
    key: "weight",
    question: "Gewicht (kg)",
    promptPatterns: [/\bgewicht\b/i],
    answerPatterns: [/\b\d{2,3}\s*(kg|kilo)\b/i],
  },
  {
    key: "insurer",
    question: "Aktueller Krankenversicherer",
    promptPatterns: [/versicherer|krankenkasse|krankenversicherung/i],
    answerPatterns: [
      /\b(aok|tk|techniker|barmer|dak|ikk|hkk|bkk|debeka|allianz|signal\s*iduna|huk|axa|generali|ottonova|uniqa|hansemerkur|deutsche\s*krankenversicherung)\b/i,
      /\bbei\s+(der|dem)\s+[a-zA-ZäöüÄÖÜß\-]+/i,
    ],
  },
  {
    key: "monthlyPremium",
    question: "Monatsbeitrag",
    promptPatterns: [/monatsbeitrag|beitrag/i],
    answerPatterns: [/\b\d{2,5}\s*(euro|eur)\b|\b\d{2,5}\b/i],
  },
  {
    key: "diagnoses",
    question: "Laufende Diagnosen/Behandlungen",
    promptPatterns: [/diagnosen|behandlungen|erkrankungen/i],
  },
  {
    key: "medication",
    question: "Regelmaessige Medikamente",
    promptPatterns: [/medikamente|medikation/i],
  },
  {
    key: "hospitalStays",
    question: "Stationaere Aufenthalte (letzte 5 Jahre)",
    promptPatterns: [/station[aä]r|krankenhausaufenthalt|aufenthalte/i],
  },
  {
    key: "psychTreatment",
    question: "Psychische Behandlungen (letzte 10 Jahre)",
    promptPatterns: [/psychisch|psychotherapie|psycholog/i],
  },
  {
    key: "teeth",
    question: "Zaehne/Zahnersatz",
    promptPatterns: [/z[aä]hne|zahnersatz/i],
  },
  {
    key: "allergies",
    question: "Allergien",
    promptPatterns: [/allergien?|allergisch/i],
  },
];

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

function isRefusalAnswer(rawText: string): boolean {
  const text = normalizeText(rawText);
  return /weiss\s*nicht|keine\s*angabe|moechte\s*ich\s*nicht|will\s*ich\s*nicht|sp[aä]ter|u[eu]berspring|keine\s*zeit/.test(text);
}

function hasMeaningfulAnswer(rawText: string, answerPatterns?: RegExp[]): boolean {
  const text = rawText.trim();
  if (!text || isRefusalAnswer(text)) {
    return false;
  }
  if (answerPatterns && answerPatterns.length > 0) {
    return answerPatterns.some((pattern) => pattern.test(text));
  }
  return text.length >= 2;
}

function collectMissingBasisQuestions(events: TranscriptEvent[]): string[] {
  if (!events.length) {
    return BASIS_FIELD_RULES.map((rule) => rule.question);
  }

  const basisOptOut = events.some((event) => {
    if (event.speaker !== "Gloria") return false;
    const text = normalizeText(event.text || "");
    return /terminbestaetigungsmail|in ruhe beantworten|per mail beantworten|fragen.*mail/.test(text);
  });
  if (basisOptOut) {
    return BASIS_FIELD_RULES.map((rule) => rule.question);
  }

  const asked = new Set<string>();
  const answered = new Set<string>();

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.speaker !== "Gloria") continue;
    const gloriaText = event.text || "";

    for (const rule of BASIS_FIELD_RULES) {
      if (!rule.promptPatterns.some((pattern) => pattern.test(gloriaText))) {
        continue;
      }

      asked.add(rule.key);
      let nextUserReply = "";
      for (let lookahead = index + 1; lookahead < events.length; lookahead += 1) {
        const candidate = events[lookahead];
        if (candidate.speaker === "Gloria") {
          break;
        }
        if (candidate.speaker === "Interessent" && candidate.text?.trim()) {
          nextUserReply = candidate.text.trim();
          break;
        }
      }

      if (hasMeaningfulAnswer(nextUserReply, rule.answerPatterns)) {
        answered.add(rule.key);
      }
    }
  }

  const missing = BASIS_FIELD_RULES.filter((rule) => asked.has(rule.key) && !answered.has(rule.key)).map(
    (rule) => rule.question,
  );

  // Falls gar keine Basisfrage gestellt wurde (z. B. frueh beendet), trotzdem
  // komplette Fragenliste in die Mail aufnehmen.
  if (asked.size === 0) {
    return BASIS_FIELD_RULES.map((rule) => rule.question);
  }

  return missing;
}

function normalizePotentialEmail(raw: string): string {
  return normalizeText(raw)
    .replace(/\b(klammeraffe|at|aett?)\b/g, "@")
    .replace(/\b(punkt|dot)\b/g, ".")
    .replace(/\b(bindestrich|minus|dash)\b/g, "-")
    .replace(/\b(unterstrich|underscore)\b/g, "_")
    .replace(/[<>()[\],;:"']/g, "")
    .replace(/\s+/g, "")
    .replace(/\.+/g, ".")
    .replace(/@+/g, "@");
}

function inferAttendeeEmailFromTranscript(events: TranscriptEvent[]): string | undefined {
  const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

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
      const normalized = normalizePotentialEmail(userParts.join(" "));
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
    conversationOccurred?: boolean;
    callDisposition?: string;
    followUpPlanned?: boolean;
    followUpAt?: string;
  };

  if (payload.callSid) {
    await releaseCampaignCallLock(payload.callSid);
  }

  const internalToken = process.env.APP_INTERNAL_TOKEN?.trim();
  if (internalToken) {
    const provided = request.headers.get("x-gloria-internal-token");
    if (provided !== internalToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // Transcript always persisted regardless of recording consent (for report detail).
  await persistTranscriptArray(payload.transcript, payload.callSid, payload.userId);

  if (!payload.company || !payload.topic || !payload.summary || !payload.outcome) {
    // Recovery path for incomplete finalize payloads: if leadId/callSid is present,
    // derive missing context (company/topic/userId) from lead or existing report.
    if (payload.summary && payload.outcome && (payload.leadId || payload.callSid)) {
      const dashboard = await getDashboardData();
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
        const report = await storeCallReport({
          userId: finalUserId,
          phoneNumberId: payload.phoneNumberId || existingByCallSid?.phoneNumberId,
          callSid: payload.callSid,
          leadId: payload.leadId || existingByCallSid?.leadId,
          company: recoveredCompany,
          contactName: recoveredContactName,
          topic: recoveredTopic,
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

        return NextResponse.json({
          ok: true,
          recoveredFinalizePayload: true,
          report,
        });
      }
    }

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

    // Telnyx liefert bei recording-events vereinzelt kein client_state.
    // Dann fehlt company/topic im Payload, obwohl ein Platzhalter-Report
    // mit callSid schon existiert. In diesem Fall das Recording per callSid
    // an den bestehenden Report anhängen.
    if (payload.callSid && payload.recordingUrl) {
      const dashboard = await getDashboardData();
      const existing = dashboard.reports.find((entry) => entry.callSid === payload.callSid);

      if (existing) {
        const report = await storeCallReport({
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

  let emailResult: Awaited<ReturnType<typeof sendReportEmail>>;
  try {
    emailResult = await sendReportEmail(report);
  } catch (error) {
    console.error("Report email delivery failed", error);
    emailResult = {
      delivered: false,
      to: process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
      reason: "Report gespeichert, aber E-Mail-Versand fehlgeschlagen.",
    };
  }

  let inviteResult:
    | { delivered: boolean; to?: string | string[]; reason?: string; messageId?: string }
    | undefined;

  if (report.outcome === "Termin" && report.appointmentAt) {
    const lead = report.leadId
      ? await getLeadById(report.leadId, report.userId)
      : undefined;
    const user = report.userId ? await findUserById(report.userId) : null;
    const transcriptEvents = report.callSid
      ? await listCallTranscriptEventsFromPostgres(report.callSid)
      : [];
    const missingBasisQuestions = collectMissingBasisQuestions(transcriptEvents);
    const transcriptEmail = inferAttendeeEmailFromTranscript(transcriptEvents);

    try {
      inviteResult = await sendAppointmentInvite({
        report,
        attendeeEmail: lead?.email || transcriptEmail,
        organizerName: user?.realName || user?.companyName,
        missingBasisQuestions,
      });
    } catch (error) {
      console.error("Appointment invite delivery failed", error);
      inviteResult = {
        delivered: false,
        reason: "Termin gespeichert, aber die Kalendereinladung konnte nicht versendet werden.",
      };
    }
  }

  return NextResponse.json({
    ok: true,
    report,
    emailResult,
    inviteResult,
  });
}
