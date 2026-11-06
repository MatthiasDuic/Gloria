import nodemailer from "nodemailer";
import type { CallReport } from "./types";

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
