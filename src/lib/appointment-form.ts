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
  transcriptEvents?: Array<{
    speaker: "Gloria" | "Interessent";
    text: string;
  }>;
}

function getReportSummary(summary: string) {
  const withoutTranscript = summary.split(/\n---\s*(?:GESPRAECHSPROTOKOLL|GESPRÄCHSPROTOKOLL|GESPRÄCHSVERLAUF)[^\n]*---/i, 1)[0].trim();
  return withoutTranscript.match(/(?:^|\n)Zusammenfassung:\s*\n([\s\S]*)$/i)?.[1]?.trim() || withoutTranscript;
}

function getConversationTurns(report: AppointmentReportSource) {
  if (report.transcriptEvents?.length) {
    return report.transcriptEvents.map((event) => ({ speaker: event.speaker, text: event.text.trim() }));
  }
  return report.summary
    .split("\n")
    .map((line) => line.trim().match(/^(?:-\s*)?(?:\[[^\]]+\]\s*)?(Gloria|Interessent)(?:\s*\([^)]*\))?:\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ speaker: match[1], text: match[2].trim() }));
}

export function buildAppointmentFormInputFromReport(report: AppointmentReportSource): AppointmentFormInput {
  const turns = getConversationTurns(report);
  const answerAfter = (question: RegExp, answerPattern?: RegExp) => {
    for (let questionIndex = turns.length - 1; questionIndex >= 0; questionIndex -= 1) {
      const turn = turns[questionIndex];
      if (turn.speaker !== "Gloria" || !question.test(turn.text)) continue;
      const answer = turns
        .slice(questionIndex + 1)
        .find((candidate) => candidate.speaker === "Interessent" && !/^\.*$/.test(candidate.text))
        ?.text;
      if (answer && (!answerPattern || answerPattern.test(answer))) return answer;
    }
    return undefined;
  };
  const height = answerAfter(/körpergröße|koerpergroesse/i);
  const weight = answerAfter(/(?:aktuelles\s+)?gewicht/i, /(?:\d{2,3}|[a-zäöüß-]+)\s*(?:kg|kilo|kilogramm)\b/i);
  const transcriptText = turns.map((turn) => turn.text).join("\n");
  const email = transcriptText.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0]
    || report.summary.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  const dental = answerAfter(/zähne|zahnersatz/i);
  const allergyDetail = answerAfter(/welche allergie liegt|welche allergien/i, /^(?!\s*(?:ja|nein)\b).+/i);
  const allergy = allergyDetail || answerAfter(/allergien|allergisch/i);
  const dentalAllergies = [
    dental && `Zähne/Zahnersatz: ${dental}`,
    allergy && `Allergien: ${allergy}`,
  ].filter(Boolean).join("; ") || undefined;

  return {
    title: "Kundenterminbogen",
    topic: report.topic,
    createdAt: report.conversationDate,
    appointmentDate: report.appointmentAt,
    appointmentMode: report.summary.match(/Durchführung:\s*([^\n.]+)/i)?.[1]?.trim(),
    contactName: report.contactName,
    email,
    company: report.company,
    birthDate: answerAfter(/geburtsdatum/i),
    insuranceStatus: answerAfter(/privat\s+oder\s+gesetzlich|versicherungsstatus/i),
    healthInsurance: answerAfter(/krankenversicherer|krankenkasse/i),
    monthlyContribution: answerAfter(/aktuellen beitrag/i),
    heightWeight: [height, weight].filter(Boolean).join(" / ") || undefined,
    medication: answerAfter(/medikamente/i),
    diagnoses: answerAfter(/diagnosen/i),
    therapy: answerAfter(/psychische behandlungen/i),
    hospitalizations: answerAfter(/krankenhausaufenthalte/i),
    dentalAllergies,
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
  const contactName = (input.contactName || "ANSPRECHPARTNER")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

  return `KTB_${contactName || "ANSPRECHPARTNER"}.pdf`;
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

function formatAppointmentDate(value?: string) {
  if (!value) return "nicht angegeben";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date).replace(",", ",");
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

    const ink = "#172338";
    const muted = "#5d6d7f";
    const line = "#cfd8e3";
    const blue = "#1d4f91";
    const blueSoft = "#eaf2fb";
    const left = 48;
    const contentWidth = 499;
    const columnGap = 20;
    const columnWidth = (contentWidth - columnGap) / 2;
    const now = input.createdAt ? new Date(input.createdAt) : new Date();
    const createdAt = formatGermanDate(now.toISOString());

    const label = (text: string, x: number, y: number) => {
      doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5).text(text.toUpperCase(), x, y, {
        width: columnWidth,
        characterSpacing: 0.4,
      });
    };
    const field = (fieldLabel: string, value: string, x: number, y: number, width = columnWidth, height = 44) => {
      label(fieldLabel, x, y + 7);
      doc.fillColor(ink).font("Helvetica-Bold").fontSize(10.5).text(value, x, y + 18, { width, height: height - 21 });
      doc.strokeColor(line).lineWidth(0.7).moveTo(x, y + height).lineTo(x + width, y + height).stroke();
    };
    const section = (title: string, y: number) => {
      doc.fillColor(blue).font("Helvetica-Bold").fontSize(9).text(title.toUpperCase(), left, y, {
        characterSpacing: 0.7,
      });
      doc.strokeColor(line).lineWidth(0.7).moveTo(left, y + 16).lineTo(left + contentWidth, y + 16).stroke();
      return y + 18;
    };

    doc.fillColor(blue).font("Helvetica-Bold").fontSize(10).text("AGENTUR DUIC", left, 50, { characterSpacing: 1.1 });
    doc.fillColor(ink).font("Times-Roman").fontSize(25).text(input.title || "Kundenterminbogen", left, 66);
    doc.fillColor("#bd8a25").font("Helvetica-Bold").fontSize(8).text("INTERNE ARBEITSUNTERLAGE", 394, 51, { width: 153, align: "right" });
    doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(`Erstellt durch Gloria\n${createdAt}`, 394, 64, { width: 153, align: "right", lineGap: 2 });
    doc.strokeColor(blue).lineWidth(2.2).moveTo(left, 105).lineTo(left + contentWidth, 105).stroke();

    const bannerY = 126;
    const bannerHeight = 54;
    doc.fillColor(blueSoft).rect(left, bannerY, columnWidth, bannerHeight).fill();
    doc.fillColor(blueSoft).rect(left + columnWidth + 1, bannerY, columnWidth, bannerHeight).fill();
    doc.strokeColor(line).lineWidth(0.7).rect(left, bannerY, contentWidth, bannerHeight).stroke();
    label("Termin", left + 12, bannerY + 9);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(11.5).text(formatAppointmentDate(input.appointmentDate), left + 12, bannerY + 23, { width: columnWidth - 20 });
    label("Durchführung", left + columnWidth + 13, bannerY + 9);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(11.5).text(formatValue(input.appointmentMode), left + columnWidth + 13, bannerY + 23, { width: columnWidth - 20 });

    let y = section("Termindetails", 204);
    field("Ort des Termins", formatValue(input.location), left, y);
    field("Berater", formatValue(input.advisor), left + columnWidth + columnGap, y);
    y += 54;
    label("Terminart", left, y + 7);
    const appointmentModes = ["Beim Kunden vor Ort", "In unserem Büro", "Microsoft Teams"];
    let choiceX = left;
    for (const mode of appointmentModes) {
      const selected = mode === input.appointmentMode;
      const choiceWidth = mode === "Beim Kunden vor Ort" ? 119 : mode === "In unserem Büro" ? 101 : 94;
      doc.fillColor(selected ? blueSoft : "#ffffff").rect(choiceX, y + 20, choiceWidth, 20).fill();
      doc.strokeColor(selected ? blue : line).lineWidth(0.7).rect(choiceX, y + 20, choiceWidth, 20).stroke();
      doc.fillColor(selected ? blue : ink).font(selected ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(mode, choiceX + 6, y + 26, { width: choiceWidth - 12, align: "center" });
      choiceX += choiceWidth + 7;
    }
    doc.strokeColor(line).lineWidth(0.7).moveTo(left, y + 49).lineTo(left + contentWidth, y + 49).stroke();

    y = section("Ansprechpartner", y + 74);
    field("Name", formatValue(input.contactName), left, y);
    field("Geburtsdatum", input.birthDate ? formatGermanDate(input.birthDate) : "nicht angegeben", left + columnWidth + columnGap, y);
    y += 44;
    field("Telefonnummer", formatValue(input.phone), left, y);
    field("E-Mail-Adresse", formatValue(input.email), left + columnWidth + columnGap, y);
    y += 44;
    field("Firma / Unternehmen", formatValue(input.company), left, y, contentWidth);

    y = section("Versicherungsstatus", y + 59);
    field("Aktueller Versicherungsstatus", formatValue(input.insuranceStatus), left, y);
    field("Derzeitiger Krankenversicherer", formatValue(input.healthInsurance), left + columnWidth + columnGap, y);
    y += 44;
    field("Aktueller Beitrag", formatValue(input.monthlyContribution), left, y);

    if (shouldIncludeHealthSection(input.topic)) {
      y = section("Gesundheitsangaben", y + 59);
      const healthFields = [
        ["Körpergröße / Gewicht", formatValue(input.heightWeight)],
        ["Regelmäßige Medikamente", formatValue(input.medication)],
        ["Bestehende Erkrankungen", formatValue(input.diagnoses)],
        ["Psychische Behandlungen, letzte 10 Jahre", formatValue(input.therapy)],
        ["KH-Aufenthalte, letzte 10 Jahre", formatValue(input.hospitalizations)],
        ["Fehlende Zähne / Allergien", formatValue(input.dentalAllergies)],
      ];
      healthFields.forEach(([fieldLabel, value], index) => {
        field(fieldLabel, value, left + (index % 2) * (columnWidth + columnGap), y + Math.floor(index / 2) * 44);
      });
      y += 132;
    }

    y = section("Notizen für den Termin", y + 18);
    doc.fillColor(ink).font("Helvetica").fontSize(9.5).text(formatValue(input.notes), left, y + 8, { width: contentWidth, height: 58, lineGap: 2 });
    doc.strokeColor(line).lineWidth(0.7).moveTo(left, y + 66).lineTo(left + contentWidth, y + 66).stroke();
    doc.strokeColor(line).lineWidth(0.7).moveTo(left, 790).lineTo(left + contentWidth, 790).stroke();
    doc.fillColor(muted).font("Helvetica").fontSize(7.5).text("Kundenterminbogen | Agentur Duic | Interne Arbeitsunterlage", left, 798, { width: contentWidth });

    doc.end();
  });
}
