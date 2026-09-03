import assert from "node:assert/strict";
import test from "node:test";
import { buildAppointmentFormPdf, shouldIncludeHealthSection } from "./appointment-form";

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
