import { NextResponse } from "next/server";
import { sendAppointmentInvite, sendReportEmail } from "@/lib/mailer";
import { getLeadById, storeCallReport } from "@/lib/storage";
import {
  appendCallTranscriptEventToPostgres,
  findUserById,
  listCallTranscriptEventsFromPostgres,
  type TranscriptEvent,
} from "@/lib/report-db";
import type { ReportOutcome, Topic } from "@/lib/types";

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
    const transcriptEvents = report.callSid
      ? await listCallTranscriptEventsFromPostgres(report.callSid)
      : [];
    const missingBasisQuestions = collectMissingBasisQuestions(transcriptEvents);

    inviteResult = await sendAppointmentInvite({
      report,
      attendeeEmail: lead?.email,
      organizerName: user?.realName || user?.companyName,
      missingBasisQuestions,
    });
  }

  return NextResponse.json({
    ok: true,
    report,
    emailResult,
    inviteResult,
  });
}
