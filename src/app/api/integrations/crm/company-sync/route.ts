import { NextResponse } from "next/server";
import { getLeadById, updateLeadDetails } from "@/lib/storage";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { syncCrmCompanyEvent } from "@/lib/crm-sync";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRM_FIELDS = new Set([
  "name",
  "phone",
  "email",
  "contact_person",
  "contact_birthdate",
  "website",
  "industry",
  "address",
  "street",
  "postal_code",
  "city",
  "country",
  "registry_number",
  "registry_court",
  "founded_year",
  "employee_count",
  "vat_id",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger JSON-Inhalt." }, { status: 400 });
  }
  if (
    !isRecord(payload)
    || typeof payload.leadId !== "string"
    || payload.leadId.length > 200
    || !isRecord(payload.companyUpdates)
    || typeof payload.eventId !== "string"
    || payload.eventId.length > 200
  ) {
    return NextResponse.json({ error: "Firmendaten zum Abgleich sind unvollständig." }, { status: 400 });
  }

  const companyUpdates: Record<string, string | number | null> = {};
  const textUpdates: Record<string, string> = {};
  for (const [field, value] of Object.entries(payload.companyUpdates)) {
    const numericField = field === "founded_year" || field === "employee_count";
    const maximum = field === "founded_year" ? 9999 : 2_147_483_647;
    if (
      !CRM_FIELDS.has(field)
      || (value !== null && typeof value !== "string" && !(numericField && typeof value === "number"))
      || (typeof value === "number" && (
        !Number.isSafeInteger(value)
        || value < (field === "founded_year" ? 1 : 0)
        || value > maximum
      ))
    ) {
      return NextResponse.json({ error: "Ein Firmendatenfeld ist ungültig." }, { status: 400 });
    }
    if (typeof value === "string" && value.length > 500) {
      return NextResponse.json({ error: "Ein Firmendatenfeld ist zu lang." }, { status: 400 });
    }
    companyUpdates[field] = typeof value === "string" ? value.trim() : value;
    if (typeof value === "string") textUpdates[field] = value.trim();
    else if (value === null) textUpdates[field] = "";
  }
  if (Object.keys(companyUpdates).length === 0) {
    return NextResponse.json({ error: "Es wurden keine Firmendaten zum Abgleich ausgewählt." }, { status: 400 });
  }

  const lead = await getLeadById(payload.leadId, sessionUser.id);
  if (!lead || lead.callSource !== "crm" || !Number.isSafeInteger(lead.crmCompanyId)) {
    return NextResponse.json({ error: "Der Gloria-Kontakt ist keiner CRM-Firma zugeordnet." }, { status: 404 });
  }
  if ("name" in companyUpdates && !companyUpdates.name) {
    return NextResponse.json({ error: "Der Firmenname darf nicht leer sein." }, { status: 400 });
  }

  try {
    await syncCrmCompanyEvent(sessionUser.id, {
      eventId: payload.eventId,
      companyId: lead.crmCompanyId!,
      companyUpdates,
    });
    const contactNames = textUpdates.contact_person?.split(/\s*\/\s*/).filter(Boolean);
    const localNumericUpdates: Pick<Partial<Lead>, "foundedYear" | "employeeCount"> = {};
    if ("founded_year" in companyUpdates) {
      localNumericUpdates.foundedYear = typeof companyUpdates.founded_year === "number"
        ? companyUpdates.founded_year
        : undefined;
    }
    if ("employee_count" in companyUpdates) {
      localNumericUpdates.employeeCount = typeof companyUpdates.employee_count === "number"
        ? companyUpdates.employee_count
        : undefined;
    }
    const localUpdates: Partial<Lead> = {
      ...(textUpdates.name !== undefined ? { company: textUpdates.name } : {}),
      ...(contactNames !== undefined ? {
        contactName: contactNames.join(" / "),
        contactNames,
        contactGroupNames: contactNames.length > 1
          ? contactNames.join(" / ")
          : undefined,
      } : {}),
      ...(textUpdates.phone !== undefined ? { phone: textUpdates.phone } : {}),
      ...(textUpdates.email !== undefined ? { email: textUpdates.email } : {}),
      ...(textUpdates.website !== undefined ? { website: textUpdates.website } : {}),
      ...(textUpdates.industry !== undefined ? { industry: textUpdates.industry } : {}),
      ...(textUpdates.address !== undefined ? { address: textUpdates.address } : {}),
      ...(textUpdates.contact_birthdate !== undefined ? { birthDate: textUpdates.contact_birthdate } : {}),
      ...(textUpdates.street !== undefined ? { addressStreet: textUpdates.street } : {}),
      ...(textUpdates.postal_code !== undefined ? { addressPostalCode: textUpdates.postal_code } : {}),
      ...(textUpdates.city !== undefined ? { addressCity: textUpdates.city, location: textUpdates.city } : {}),
      ...(textUpdates.country !== undefined ? { addressCountry: textUpdates.country } : {}),
      ...(textUpdates.registry_number !== undefined ? { registryNumber: textUpdates.registry_number } : {}),
      ...(textUpdates.registry_court !== undefined ? { registryCourt: textUpdates.registry_court } : {}),
      ...localNumericUpdates,
      ...(textUpdates.vat_id !== undefined ? { vatId: textUpdates.vat_id } : {}),
      crmCompanyData: { ...(lead.crmCompanyData || {}), ...companyUpdates },
    };
    const updatedLead = await updateLeadDetails(lead.id, localUpdates, sessionUser.id);
    if (!updatedLead) {
      return NextResponse.json({ error: "CRM wurde aktualisiert, aber der Gloria-Kontakt konnte nicht aktualisiert werden." }, { status: 500 });
    }
    return NextResponse.json({ ok: true, lead: updatedLead });
  } catch (error) {
    console.error("Firmendaten konnten nicht mit dem CRM abgeglichen werden:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Firmendaten konnten nicht mit dem CRM abgeglichen werden.",
    }, { status: 502 });
  }
}
