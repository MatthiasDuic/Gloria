import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEffectiveLeadCompanyName,
  normalizeLeadAffiliationRole,
  normalizeLeadBirthDate,
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
