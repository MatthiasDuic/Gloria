import assert from "node:assert/strict";
import test from "node:test";
import { buildAppointmentFormInputFromReport, buildAppointmentFormPdf, getAppointmentFormFilename, shouldIncludeHealthSection } from "./appointment-form";

test("getAppointmentFormFilename uses the KTB contact naming convention", () => {
  assert.equal(getAppointmentFormFilename({ contactName: "Herr Neumann" }), "KTB_Herr_Neumann.pdf");
  assert.equal(getAppointmentFormFilename({ contactName: "Jörg Müller" }), "KTB_Jorg_Muller.pdf");
  assert.equal(getAppointmentFormFilename({}), "KTB_ANSPRECHPARTNER.pdf");
});

test("buildAppointmentFormInputFromReport extracts appointment preparation data", () => {
  const input = buildAppointmentFormInputFromReport({
    company: "Musterbau GmbH",
    contactName: "Herr Neumann",
    topic: "private Krankenversicherung",
    conversationDate: "2026-09-03T07:55:59.830Z",
    appointmentAt: "2026-09-10T16:30:00.000Z",
    summary: `Zusammenfassung:\nNur diese Zusammenfassung soll in die Notizen.\n\n--- GESPRAECHSPROTOKOLL (inkl. Reaktionszeit pro Gloria-Antwort) ---\n- [09:51:09] Gloria: Nennen Sie mir kurz Ihren aktuellen Beitrag.\n- [09:51:18] Interessent: Circa 690 Euro.\n- [09:54:20] Gloria: Ihr Geburtsdatum?\n- [09:54:26] Interessent: 2. Mai 87.\n- [09:54:27] Gloria: Ihre Körpergröße?\n- [09:54:34] Interessent: Ein Meter achtundachtzig.\n- [09:54:35] Gloria: Ihr aktuelles Gewicht?\n- [09:54:41] Interessent: 96 Kilogramm.\n- [09:54:41] Gloria: Bei welchem Krankenversicherer sind Sie aktuell versichert?\n- [09:54:48] Interessent: Allianz.\n- [09:54:56] Gloria: Nehmen Sie regelmäßig Medikamente ein?\n- [09:55:03] Interessent: Nein.\n- [09:55:26] Gloria: Bestehen bekannte Allergien?\n- [09:55:30] Interessent: Nein.\n- [09:55:42] Interessent: muster@muster.de`,
  });

  assert.equal(input.appointmentDate, "2026-09-10T16:30:00.000Z");
  assert.equal(input.email, "muster@muster.de");
  assert.equal(input.birthDate, "2. Mai 87.");
  assert.equal(input.healthInsurance, "Allianz.");
  assert.equal(input.monthlyContribution, "Circa 690 Euro.");
  assert.equal(input.heightWeight, "Ein Meter achtundachtzig. / 96 Kilogramm.");
  assert.equal(input.medication, "Nein.");
  assert.equal(input.dentalAllergies, "Nein.");
  assert.equal(input.notes, "Nur diese Zusammenfassung soll in die Notizen.");
});

test("buildAppointmentFormPdf creates a valid PDF document", async () => {
  const pdf = await buildAppointmentFormPdf({
    title: "Kundenterminbogen",
    topic: "private Krankenversicherung",
    createdAt: "2026-09-03T10:42:00.000Z",
    appointmentDate: "2026-09-10T15:30:00.000Z",
    appointmentMode: "Beim Kunden vor Ort",
    location: "Musterstraße 12, 45525 Musterstadt",
    advisor: "Herr Matthias Duic",
    contactName: "Max Mustermann",
    birthDate: "1982-05-15",
    phone: "+49 170 1234567",
    email: "max.mustermann@beispiel.de",
    company: "Muster GmbH",
    insuranceStatus: "Privat versichert",
    healthInsurance: "Beispiel Versicherung",
    monthlyContribution: "980 EUR",
    heightWeight: "182 cm / 84 kg",
    medication: "Keine Angaben",
    diagnoses: "Keine Angaben",
    therapy: "Keine Angaben",
    hospitalizations: "Keine Angaben",
    dentalAllergies: "Keine Angaben",
    notes: "Gesundheitsangaben werden beim Termin bei Bedarf ergänzt.",
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 1000);
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal(shouldIncludeHealthSection("private Krankenversicherung"), true);
});

test("buildAppointmentFormPdf hides health questions for commercial and retirement topics", async () => {
  const pdf = await buildAppointmentFormPdf({
    title: "Kundenterminbogen",
    topic: "betriebliche Altersvorsorge",
    createdAt: "2026-09-03T10:42:00.000Z",
    appointmentDate: "2026-09-10T15:30:00.000Z",
    appointmentMode: "Beim Kunden vor Ort",
    location: "Musterstraße 12, 45525 Musterstadt",
    advisor: "Herr Matthias Duic",
    contactName: "Max Mustermann",
    company: "Muster GmbH",
    notes: "Thema erfordert keine Gesundheitsdaten.",
  });

  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(shouldIncludeHealthSection("betriebliche Altersvorsorge"), false);
  assert.equal(shouldIncludeHealthSection("gewerbliche Versicherungen"), false);
});

test("shouldIncludeHealthSection recognizes common PKV topic variants", () => {
  assert.equal(shouldIncludeHealthSection("PKV"), true);
  assert.equal(shouldIncludeHealthSection("Privatversicherung"), true);
  assert.equal(shouldIncludeHealthSection("private Krankenversicherung / Zusatzversicherung"), true);
  assert.equal(shouldIncludeHealthSection("gesetzliche Krankenversicherung"), false);
});
