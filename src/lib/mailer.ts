import nodemailer from "nodemailer";
import type { CallReport } from "./types";

const fallbackRecipient = "Matthias.duic@agentur-duic-sprockhoevel.de";

export async function sendReportEmail(report: CallReport) {
  const to = process.env.REPORT_TO_EMAIL || fallbackRecipient;

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return {
      delivered: false,
      to,
      reason: "SMTP nicht konfiguriert – Report wurde nur lokal gespeichert.",
    };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

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
