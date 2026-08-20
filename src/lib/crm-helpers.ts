export type LeadAffiliationRole =
  | "Mitarbeiter"
  | "Geschäftsführer"
  | "Inhaber"
  | "Vorstand"
  | "Beirat"
  | "Kontakt"
  | "Sonstige";

export interface LeadAffiliation {
  id: string;
  companyId?: string;
  companyName: string;
  role: LeadAffiliationRole | string;
  createdAt: string;
}

export interface LeadPersonData {
  customerKind?: "privat" | "firma";
  company?: string;
  contactName?: string;
  birthDate?: string;
  affiliations?: LeadAffiliation[];
}

export function buildEffectiveLeadCompanyName(lead: LeadPersonData): string {
  const trimmedCompany = (lead.company || "").trim();
  if (lead.customerKind === "privat") {
    const trimmedContact = (lead.contactName || "").trim();
    if (trimmedCompany) return trimmedCompany;
    if (trimmedContact) return trimmedContact;
    return "Privatperson";
  }

  return trimmedCompany || "Neue Firma";
}

export function resolveLeadCompanyValue(lead: LeadPersonData): string {
  if (lead.customerKind === "privat") {
    return buildEffectiveLeadCompanyName(lead);
  }
  return (lead.company || "").trim() || "Neue Firma";
}

export function normalizeLeadAffiliationRole(rawRole?: string): LeadAffiliationRole | string {
  const cleaned = (rawRole || "").trim();
  if (!cleaned) return "Mitarbeiter";

  const lower = cleaned.toLowerCase();
  if (lower.includes("geschaeftsfuehrer") || lower.includes("geschäftsführer") || lower.includes("ceo") || lower.includes("leiter")) {
    return "Geschäftsführer";
  }
  if (lower.includes("inhaber") || lower.includes("eigentuemer") || lower.includes("owner")) {
    return "Inhaber";
  }
  if (lower.includes("vorstand")) return "Vorstand";
  if (lower.includes("beirat")) return "Beirat";
  if (lower.includes("kontakt")) return "Kontakt";
  if (lower.includes("mitarbeiter")) return "Mitarbeiter";
  return cleaned;
}

export function normalizeLeadBirthDate(rawValue?: string): string | undefined {
  const value = (rawValue || "").trim();
  if (!value) return undefined;

  const isoMatch = /^\d{4}-\d{2}-\d{2}$/.exec(value);
  if (isoMatch) return value;

  const germanMatch = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(value);
  if (germanMatch) {
    const [, day, month, yearRaw] = germanMatch;
    const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  return value;
}
