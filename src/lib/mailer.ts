import nodemailer from "nodemailer";
import type { CallReport } from "./types";

const fallbackRecipient = "Matthias.duic@agentur-duic-sprockhoevel.de";

function getTransporter() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
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
    `Gespräch am: ${report.conversationDate}`,
    `Wählversuche: ${report.attempts}`,
    `Termin: ${report.appointmentAt || "-"}`,
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
}

export function buildAppointmentIcs(options: AppointmentInviteOptions): string | null {
  const { report, attendeeEmail, organizerEmail, organizerName, durationMinutes } =
    options;

  if (!report.appointmentAt) return null;

  const start = new Date(report.appointmentAt);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start.getTime() + (durationMinutes ?? 30) * 60 * 1000);
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

export async function sendAppointmentInvite(options: AppointmentInviteOptions) {
  const { report, attendeeEmail } = options;
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
    organizerEmail,
    organizerName,
  });

  if (!ics) {
    return { delivered: false, reason: "Kein gueltiger Termin im Report." };
  }

  const recipients = [brokerEmail, attendeeEmail].filter(
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

  const body = [
    `Hallo ${report.contactName || ""},`,
    "",
    `vielen Dank fuer das Gespraech mit Gloria. Ihr Termin wurde bestaetigt:`,
    "",
    `Thema: ${report.topic}`,
    `Firma: ${report.company}`,
    `Zeitpunkt: ${when}`,
    "",
    "Die Kalendereinladung ist als .ics-Datei angehaengt.",
    "",
    "Freundliche Gruesse",
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
    ],
  });

  return {
    delivered: true,
    to: recipients,
    messageId: info.messageId,
  };
}

