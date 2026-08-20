import type { LeadProductDetail } from "./types";

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

export function buildLeadProductRecord(input: Partial<LeadProductDetail> & { category: string; label?: string }): LeadProductDetail {
  const category = String(input.category || "").trim() || "Sonstige";
  const label = String(input.label || category).trim() || category;
  return {
    id: input.id || `product-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    label,
    insurer: input.insurer?.trim() || undefined,
    contractNumber: input.contractNumber?.trim() || undefined,
    premium: input.premium?.trim() || undefined,
    paymentMethod: input.paymentMethod?.trim() || "monatlich",
    productType: input.productType?.trim() || undefined,
    energyType: input.energyType?.trim() || undefined,
    startDate: input.startDate?.trim() || undefined,
    endDate: input.endDate?.trim() || undefined,
    notes: input.notes?.trim() || undefined,
    documentName: input.documentName?.trim() || undefined,
    documentUrl: input.documentUrl?.trim() || undefined,
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

export function normalizeLeadProductDetails(input: unknown): LeadProductDetail[] | undefined {
  const source = Array.isArray(input) ? input : [];
  const next = source
    .map((entry) => {
      if (typeof entry === "string") {
        return buildLeadProductRecord({ category: entry, label: entry });
      }
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const product = entry as Partial<LeadProductDetail> & { category?: string; label?: string };
      const category = String(product.category || product.label || "").trim();
      if (!category) {
        return null;
      }
      return buildLeadProductRecord({
        ...product,
        category,
        label: product.label || category,
      });
    })
    .filter((entry): entry is LeadProductDetail => Boolean(entry));

  return next.length ? next : undefined;
}

export function getLeadCustomerKindFormConfig(customerKind: "privat" | "firma") {
  if (customerKind === "privat") {
    return {
      companyLabel: "Privatperson / Firma (optional)",
      companyPlaceholder: "optional – wird aus Name abgeleitet",
      requireCompany: false,
      showBirthDate: true,
    };
  }

  return {
    companyLabel: "Firma",
    companyPlaceholder: "Musterbau GmbH",
    requireCompany: true,
    showBirthDate: false,
  };
}

export function resolveExclusiveDetailModal<TLead = unknown, TReport = unknown>(options: {
  lead?: TLead | null;
  report?: TReport | null;
}): { lead: TLead | null; report: TReport | null } {
  if (options.lead !== undefined) {
    return { lead: options.lead ?? null, report: null };
  }

  if (options.report !== undefined) {
    return { lead: null, report: options.report ?? null };
  }

  return { lead: null, report: null };
}
