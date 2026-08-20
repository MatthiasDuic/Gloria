import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveLeadCompanyName,
  buildLeadProductRecord,
  getLeadCustomerKindFormConfig,
  normalizeLeadAffiliationRole,
  normalizeLeadBirthDate,
  normalizeLeadProductDetails,
  resolveExclusiveDetailModal,
  resolveLeadCompanyValue,
} from "./crm-helpers.ts";

test("private customers auto-fill a sensible company label without requiring a firm name", () => {
  assert.equal(buildEffectiveLeadCompanyName({ customerKind: "privat", company: "", contactName: "Max Mustermann" }), "Max Mustermann");
  assert.equal(buildEffectiveLeadCompanyName({ customerKind: "privat", company: "", contactName: "" }), "Privatperson");
  assert.equal(resolveLeadCompanyValue({ customerKind: "privat", company: "", contactName: "Max Mustermann" }), "Max Mustermann");
});

test("affiliation roles fall back to a valid default when empty", () => {
  assert.equal(normalizeLeadAffiliationRole(""), "Mitarbeiter");
  assert.equal(normalizeLeadAffiliationRole("Geschäftsführer"), "Geschäftsführer");
});

test("german birth dates are normalized to ISO strings", () => {
  assert.equal(normalizeLeadBirthDate("25.08.1990"), "1990-08-25");
  assert.equal(normalizeLeadBirthDate("2024-04-03"), "2024-04-03");
});

test("customer kind form config switches the required fields between private persons and companies", () => {
  assert.deepEqual(getLeadCustomerKindFormConfig("privat"), {
    companyLabel: "Privatperson / Firma (optional)",
    companyPlaceholder: "optional – wird aus Name abgeleitet",
    requireCompany: false,
    showBirthDate: true,
  });

  assert.deepEqual(getLeadCustomerKindFormConfig("firma"), {
    companyLabel: "Firma",
    companyPlaceholder: "Musterbau GmbH",
    requireCompany: true,
    showBirthDate: false,
  });
});

test("product details get normalized defaults for insurance and energy products", () => {
  const next = normalizeLeadProductDetails([
    { category: "private Krankenversicherung", insurer: "Allianz", premium: "89,50", paymentMethod: "monatlich" },
    { category: "Strom und Gas", energyType: "Strom" },
  ]);

  assert.equal(next?.length, 2);
  assert.equal(next?.[0].label, "private Krankenversicherung");
  assert.equal(next?.[0].paymentMethod, "monatlich");
  assert.equal(next?.[1].energyType, "Strom");
  assert.ok(next?.[0].id.startsWith("product-"));

  const record = buildLeadProductRecord({ category: "betriebliche Krankenversicherung" });
  assert.equal(record.category, "betriebliche Krankenversicherung");
  assert.equal(record.paymentMethod, "monatlich");
});

test("detail modals stay exclusive so a lead detail cannot overlap a report detail", () => {
  const leadState = resolveExclusiveDetailModal({ lead: { id: "lead-1" } });
  assert.deepEqual(leadState, { lead: { id: "lead-1" }, report: null });

  const reportState = resolveExclusiveDetailModal({ report: { id: "report-1" } });
  assert.deepEqual(reportState, { lead: null, report: { id: "report-1" } });
});
