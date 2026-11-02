import type { Lead } from "./types";

export const CRM_ENRICHMENT_FIELDS = [
  { key: "phone", label: "Telefonnummer" },
  { key: "email", label: "E-Mail" },
  { key: "website", label: "Website" },
  { key: "industry", label: "Branche" },
  { key: "contact_person", label: "Ansprechpartner" },
  { key: "address", label: "Adresse" },
  { key: "street", label: "Straße" },
  { key: "postal_code", label: "Postleitzahl" },
  { key: "city", label: "Ort" },
  { key: "country", label: "Land" },
  { key: "registry_number", label: "Handelsregisternummer" },
  { key: "registry_court", label: "Registergericht" },
  { key: "founded_year", label: "Gründungsjahr" },
  { key: "employee_count", label: "Mitarbeiterzahl" },
  { key: "vat_id", label: "Umsatzsteuer-ID" },
] as const;

export type CrmEnrichmentField = (typeof CRM_ENRICHMENT_FIELDS)[number]["key"];
export type MissingCrmField = { key: CrmEnrichmentField; label: string };

function isFilled(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" && Number.isFinite(value);
}

function hasContactPerson(lead: Lead, companyData: Record<string, unknown>): boolean {
  if (isFilled(companyData.contact_person)) return true;
  if (lead.contactNames?.some((name) => name.trim())) return true;
  const contactName = (lead.contactName || "").trim();
  if (contactName && !/^empfang$/i.test(contactName)) return true;
  if (!Array.isArray(companyData.contactPersons)) return false;
  return companyData.contactPersons.some((person) =>
    Boolean(person && typeof person === "object" && isFilled((person as Record<string, unknown>).name)),
  );
}

export function getMissingCrmFields(lead: Lead): MissingCrmField[] {
  const data = lead.crmCompanyData || {};
  const values: Record<CrmEnrichmentField, unknown> = {
    phone: data.phone || lead.phone || lead.directDial,
    email: data.email || lead.email,
    website: data.website || lead.website,
    industry: data.industry || lead.industry,
    contact_person: hasContactPerson(lead, data) ? "present" : "",
    address: data.address || lead.address,
    street: data.street || lead.addressStreet,
    postal_code: data.postal_code || lead.addressPostalCode,
    city: data.city || lead.addressCity || lead.location,
    country: data.country || lead.addressCountry,
    registry_number: data.registry_number || lead.registryNumber,
    registry_court: data.registry_court || lead.registryCourt,
    founded_year: data.founded_year ?? lead.foundedYear,
    employee_count: data.employee_count ?? lead.employeeCount,
    vat_id: data.vat_id || lead.vatId,
  };
  return CRM_ENRICHMENT_FIELDS.filter(({ key }) => !isFilled(values[key]))
    .map(({ key, label }) => ({ key, label }));
}
