import PDFDocument from "pdfkit";

export interface AppointmentFormInput {
  title?: string;
  topic?: string;
  createdAt?: string;
  appointmentDate?: string;
  appointmentMode?: string;
  location?: string;
  advisor?: string;
  contactName?: string;
  birthDate?: string;
  phone?: string;
  email?: string;
  company?: string;
  insuranceStatus?: string;
  healthInsurance?: string;
  monthlyContribution?: string;
  heightWeight?: string;
  medication?: string;
  diagnoses?: string;
  therapy?: string;
  hospitalizations?: string;
  dentalAllergies?: string;
  notes?: string;
}

export interface AppointmentReportSource {
  company: string;
  contactName?: string;
  topic: string;
  summary: string;
  conversationDate: string;
  appointmentAt?: string;
}

function getReportSummary(summary: string) {
  const withoutTranscript = summary.split(/\n---\s*(?:GESPRAECHSPROTOKOLL|GESPRÄCHSPROTOKOLL|GESPRÄCHSVERLAUF)[^\n]*---/i, 1)[0].trim();
  return withoutTranscript.match(/(?:^|\n)Zusammenfassung:\s*\n([\s\S]*)$/i)?.[1]?.trim() || withoutTranscript;
}

function getConversationTurns(summary: string) {
  return summary
    .split("\n")
    .map((line) => line.trim().match(/^(?:-\s*)?(?:\[[^\]]+\]\s*)?(Gloria|Interessent)(?:\s*\([^)]*\))?:\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ speaker: match[1], text: match[2].trim() }));
}

export function buildAppointmentFormInputFromReport(report: AppointmentReportSource): AppointmentFormInput {
  const turns = getConversationTurns(report.summary);
  const answerAfter = (question: RegExp) => {
    const questionIndex = turns.findIndex((turn) => turn.speaker === "Gloria" && question.test(turn.text));
    if (questionIndex < 0) return undefined;

    return turns
      .slice(questionIndex + 1)
      .find((turn) => turn.speaker === "Interessent" && !/^\.*$/.test(turn.text))
      ?.text;
  };
  const height = answerAfter(/körpergröße|koerpergroesse/i);
  const weight = answerAfter(/(?:aktuelles\s+)?gewicht/i);
  const email = report.summary.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];

  return {
    title: "Kundenterminbogen",
    topic: report.topic,
    createdAt: report.conversationDate,
    appointmentDate: report.appointmentAt,
    contactName: report.contactName,
    email,
    company: report.company,
    birthDate: answerAfter(/geburtsdatum/i),
    insuranceStatus: normalizeTopic(report.topic).includes("private krankenversicherung") ? "Privat versichert" : undefined,
    healthInsurance: answerAfter(/krankenversicherer|krankenkasse/i),
    monthlyContribution: answerAfter(/aktuellen beitrag/i),
    heightWeight: [height, weight].filter(Boolean).join(" / ") || undefined,
    medication: answerAfter(/medikamente/i),
    diagnoses: answerAfter(/diagnosen/i),
    therapy: answerAfter(/psychische behandlungen/i),
    hospitalizations: answerAfter(/krankenhausaufenthalte/i),
    dentalAllergies: answerAfter(/allergien|fehlende zähne/i),
    notes: getReportSummary(report.summary),
  };
}

function normalizeTopic(value?: string) {
  return (value || "").trim().toLowerCase();
}

export function shouldIncludeHealthSection(topic?: string) {
  const normalized = normalizeTopic(topic);
  if (!normalized) return false;

  const explicitPrivateHealthPattern = /(private\s*krankenversicherung|privat(?:e|en)?\s*krankenversicherung|privatversicherung|pkv)/.test(normalized);
  const hasPrivateSignal = normalized.includes("privat") || normalized.includes("private");
  const hasHealthInsuranceSignal = /(krankenversicherung|gesundheitsversicherung|krankenkasse)/.test(normalized);

  return explicitPrivateHealthPattern || (hasPrivateSignal && hasHealthInsuranceSignal);
}

export function getAppointmentFormFilename(input: AppointmentFormInput) {
  const label = normalizeTopic(input.topic || "kundenterminbogen")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return label ? `kundenterminbogen-${label}.pdf` : "kundenterminbogen.pdf";
}

function formatValue(value?: string) {
  return value && value.trim() ? value.trim() : "nicht angegeben";
}

function formatGermanDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export async function buildAppointmentFormPdf(input: AppointmentFormInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: {
        Title: input.title || "Kundenterminbogen",
        Author: "Gloria KI-Assistent",
        Subject: "Kundenterminbogen",
      },
    });

    const chunks: Buffer[] = [];

    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", (error) => reject(error));

    const now = input.createdAt ? new Date(input.createdAt) : new Date();
    const appointmentDate = input.appointmentDate ? new Date(input.appointmentDate) : null;

    doc.fillColor("#172338").fontSize(22).text(input.title || "Kundenterminbogen", { align: "left" });
    doc.moveDown(0.3);
    doc.fillColor("#4b5563").fontSize(10).text(`Erstellt: ${new Intl.DateTimeFormat("de-DE", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(now)}`);

    doc.moveDown(0.8);
    doc.lineWidth(2).strokeColor("#1d4f91").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.8);

    const infoRows = [
      ["Termin", appointmentDate ? formatGermanDate(appointmentDate.toISOString()) : "nicht angegeben"],
      ["Durchführung", formatValue(input.appointmentMode)],
      ["Ort", formatValue(input.location)],
      ["Berater", formatValue(input.advisor)],
    ];

    doc.fillColor("#172338").fontSize(12).text("Termindetails", { underline: true });
    doc.moveDown(0.3);
    infoRows.forEach(([label, value]) => {
      doc.fillColor("#6b7280").fontSize(9).text(String(label), { continued: true });
      doc.fillColor("#172338").fontSize(11).text(`: ${String(value)}`);
    });

    doc.moveDown(1);
    doc.fillColor("#172338").fontSize(12).text("Ansprechpartner", { underline: true });
    doc.moveDown(0.3);
    [
      ["Name", formatValue(input.contactName)],
      ["Geburtsdatum", input.birthDate ? formatGermanDate(input.birthDate) : "nicht angegeben"],
      ["Telefonnummer", formatValue(input.phone)],
      ["E-Mail-Adresse", formatValue(input.email)],
      ["Firma / Unternehmen", formatValue(input.company)],
    ].forEach(([label, value]) => {
      doc.fillColor("#6b7280").fontSize(9).text(String(label), { continued: true });
      doc.fillColor("#172338").fontSize(11).text(`: ${String(value)}`);
    });

    doc.moveDown(1);
    doc.fillColor("#172338").fontSize(12).text("Versicherungsstatus", { underline: true });
    doc.moveDown(0.3);
    [
      ["Aktueller Versicherungsstatus", formatValue(input.insuranceStatus)],
      ["Derzeitiger Krankenversicherer", formatValue(input.healthInsurance)],
      ["Aktueller Beitrag", formatValue(input.monthlyContribution)],
    ].forEach(([label, value]) => {
      doc.fillColor("#6b7280").fontSize(9).text(String(label), { continued: true });
      doc.fillColor("#172338").fontSize(11).text(`: ${String(value)}`);
    });

    if (shouldIncludeHealthSection(input.topic)) {
      doc.moveDown(1);
      doc.fillColor("#172338").fontSize(12).text("Gesundheitsangaben", { underline: true });
      doc.moveDown(0.3);
      [
        ["Körpergröße / Gewicht", formatValue(input.heightWeight)],
        ["Regelmäßige Medikamente", formatValue(input.medication)],
        ["Bestehende Erkrankungen", formatValue(input.diagnoses)],
        ["Psychische Behandlungen, letzte 10 Jahre", formatValue(input.therapy)],
        ["KH-Aufenthalte, letzte 10 Jahre", formatValue(input.hospitalizations)],
        ["Fehlende Zähne / Allergien", formatValue(input.dentalAllergies)],
      ].forEach(([label, value]) => {
        doc.fillColor("#6b7280").fontSize(9).text(String(label), { continued: true });
        doc.fillColor("#172338").fontSize(11).text(`: ${String(value)}`);
      });
    }

    doc.moveDown(1);
    doc.fillColor("#172338").fontSize(12).text("Notizen für den Termin", { underline: true });
    doc.moveDown(0.3);
    doc.fillColor("#172338").fontSize(10.5).text(formatValue(input.notes), { align: "left", width: 490 });

    doc.end();
  });
}
