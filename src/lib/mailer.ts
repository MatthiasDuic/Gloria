import nodemailer from "nodemailer";
import { APPOINTMENT_EMAIL_PATTERN, appointmentConfirmationDelivery } from "./appointment-confirmation";
import { shouldGenerateAppointmentPdf, type CallReport } from "./types";

const fallbackRecipient = "Matthias.duic@agentur-duic-sprockhoevel.de";

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT muss eine gültige Portnummer zwischen 1 und 65535 sein.");
  }
  const secure = port === 465;

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendReportEmail(report: CallReport) {
  const to = process.env.REPORT_TO_EMAIL || fallbackRecipient;
  const transporter = getTransporter();

  if (!transporter) {
    return {
      delivered: false,
      to,
      reason: "SMTP nicht konfiguriert – Report wurde nur lokal gespeichert.",
    };
  }

  const lines = [
    `Firma: ${report.company}`,
    `Ansprechpartner: ${report.contactName || "-"}`,
    `Thema: ${report.topic}`,
    `Ergebnis: ${report.outcome}`,
    ...(report.resultDetail && report.resultDetail !== report.outcome ? [`Was ist passiert: ${report.resultDetail}`] : []),
    `Gespräch am: ${report.conversationDate}`,
    `Wählversuche: ${report.attempts}`,
    `Termin: ${report.appointmentAt || "-"}`,
    `Terminart: ${report.appointmentMode || "-"}`,
    `Wiedervorlage: ${report.nextCallAt || "-"}`,
    `Aufnahme zugestimmt: ${report.recordingConsent ? "Ja" : "Nein"}`,
    `Aufnahme-Link: ${report.recordingUrl || "-"}`,
    "",
    "Zusammenfassung:",
    report.summary,
  ];

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || "Gloria <no-reply@example.com>",
    to,
    subject: `Gloria Report – ${report.company} – ${report.outcome}`,
    text: lines.join("\n"),
  });

  return {
    delivered: true,
    to,
    messageId: info.messageId,
  };
}

function formatIcsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcs(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export interface AppointmentInviteOptions {
  report: CallReport;
  attendeeEmail?: string;
  organizerEmail?: string;
  organizerName?: string;
  durationMinutes?: number;
  missingBasisQuestions?: string[];
  appointmentPdf?: Buffer;
  appointmentPdfFilename?: string;
}

export function buildAppointmentIcs(options: AppointmentInviteOptions): string | null {
  const { report, attendeeEmail, organizerEmail, organizerName, durationMinutes } =
    options;

  if (!report.appointmentAt) return null;

  const start = new Date(report.appointmentAt);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start.getTime() + (durationMinutes ?? 90) * 60 * 1000);
  const uid = `${report.id || report.callSid || Date.now()}@gloria-ki-assistent`;
  const now = new Date();

  const summary = escapeIcs(
    `Termin: ${report.company} (${report.topic})`,
  );
  const description = escapeIcs(
    [
      `Thema: ${report.topic}`,
      `Firma: ${report.company}`,
      `Ansprechpartner: ${report.contactName || "-"}`,
      `Terminart: ${report.appointmentMode || "-"}`,
      "",
      "Gespraechsnotiz (Gloria):",
      report.summary || "-",
    ].join("\n"),
  );

  const organizer = organizerEmail
    ? `ORGANIZER;CN=${escapeIcs(organizerName || "Gloria")}:mailto:${organizerEmail}`
    : undefined;
  const attendee = attendeeEmail
    ? `ATTENDEE;CN=${escapeIcs(report.contactName || attendeeEmail)};RSVP=TRUE:mailto:${attendeeEmail}`
    : undefined;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Gloria KI Assistent//DE",
    "METHOD:REQUEST",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    organizer,
    attendee,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);

  return lines.join("\r\n");
}

export async function sendOperationalEmail(options: {
  subject: string;
  body: string;
  to?: string;
}): Promise<{ delivered: boolean; messageId?: string; reason?: string }> {
  const transporter = getTransporter();
  const to = options.to || process.env.REPORT_TO_EMAIL || fallbackRecipient;

  if (!transporter) {
    return { delivered: false, reason: "SMTP nicht konfiguriert." };
  }

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || "Gloria <no-reply@example.com>",
    to,
    subject: options.subject,
    text: options.body,
  });

  return { delivered: true, messageId: info.messageId };
}

export async function sendAppointmentInvite(options: AppointmentInviteOptions) {
  const { report, attendeeEmail } = options;
  if (await appointmentConfirmationDelivery(report.userId) === "manual") {
    return { delivered: false, skipped: true, reason: "Terminbestätigungen werden für diesen Benutzer nicht automatisch versendet." };
  }
  const customerEmail = attendeeEmail?.trim();
  if (!customerEmail || customerEmail.match(APPOINTMENT_EMAIL_PATTERN)?.[0] !== customerEmail) {
    return { delivered: false, reason: "Eine gültige Kunden-E-Mail-Adresse für die Terminbestätigung fehlt." };
  }
  const brokerEmail = process.env.REPORT_TO_EMAIL || fallbackRecipient;
  const organizerEmail =
    options.organizerEmail || process.env.SMTP_FROM_ADDRESS || brokerEmail;
  const organizerName = options.organizerName || "Agentur Duic";

  const transporter = getTransporter();
  if (!transporter) {
    return { delivered: false, reason: "SMTP nicht konfiguriert." };
  }

  const ics = buildAppointmentIcs({
    ...options,
    attendeeEmail: customerEmail,
    organizerEmail,
    organizerName,
  });

  if (!ics) {
    return { delivered: false, reason: "Kein gueltiger Termin im Report." };
  }
  const includePdf = shouldGenerateAppointmentPdf(report.topic);
  if (includePdf && (!options.appointmentPdf || options.appointmentPdf.length < 1000)) {
    return { delivered: false, reason: "Kundenterminbogen fehlt oder ist unvollständig." };
  }

  const recipients = [brokerEmail, customerEmail].filter(
    (entry): entry is string => Boolean(entry && entry.includes("@")),
  );

  if (recipients.length === 0) {
    return { delivered: false, reason: "Keine gueltige Empfaengeradresse." };
  }

  const start = new Date(report.appointmentAt || Date.now());
  const when = new Intl.DateTimeFormat("de-DE", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(start);

  const missingQuestions = (options.missingBasisQuestions || []).filter(
    (entry) => typeof entry === "string" && entry.trim().length > 0,
  );
  const needsQuestionBlock = missingQuestions.length > 0;
  const questionBlock = needsQuestionBlock
    ? [
        "",
        "Bitte beantworten Sie diese Punkte noch kurz per E-Mail:",
        ...missingQuestions.map((q, idx) => `${idx + 1}. ${q}`),
      ]
    : [];

  const body = [
    `Hallo ${report.contactName || ""},`,
    "",
    `vielen Dank für das Gespräch mit Gloria. Ihr Termin wurde bestätigt:`,
    "",
    `Thema: ${report.topic}`,
    `Firma: ${report.company}`,
    `Zeitpunkt: ${when}`,
    ...(report.appointmentMode ? [`Terminart: ${report.appointmentMode}`] : []),
    ...questionBlock,
    "",
    includePdf ? "Die Kalendereinladung und der Kundenterminbogen sind angehängt." : "Die Kalendereinladung ist angehängt.",
    "",
    "Freundliche Grüße",
    organizerName,
  ].join("\n");

  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || `${organizerName} <${organizerEmail}>`,
    to: recipients.join(", "),
    subject: `Terminbestaetigung – ${report.company} – ${when}`,
    text: body,
    icalEvent: {
      method: "REQUEST",
      content: ics,
      filename: "termin.ics",
    },
    attachments: [
      {
        filename: "termin.ics",
        content: ics,
        contentType: "text/calendar; method=REQUEST; charset=UTF-8",
      },
      ...(includePdf ? [{
        filename: options.appointmentPdfFilename || "Kundenterminbogen.pdf",
        content: options.appointmentPdf,
        contentType: "application/pdf",
      }] : []),
    ],
  });

  const customerAccepted = Array.isArray(info.accepted) && info.accepted.some((entry) => {
    const address = typeof entry === "string" ? entry : entry.address;
    return address.toLowerCase() === customerEmail.toLowerCase();
  });
  if (!customerAccepted) {
    return { delivered: false, reason: "Die Kunden-E-Mail-Adresse wurde vom Mailserver nicht bestätigt." };
  }

  return {
    delivered: true,
    to: recipients,
    messageId: info.messageId,
  };
}
