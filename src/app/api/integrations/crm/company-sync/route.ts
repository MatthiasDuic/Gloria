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
  "street",
  "postal_code",
  "city",
  "country",
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

  const companyUpdates: Record<string, string | null> = {};
  for (const [field, value] of Object.entries(payload.companyUpdates)) {
    if (!CRM_FIELDS.has(field) || (value !== null && typeof value !== "string")) {
      return NextResponse.json({ error: "Ein Firmendatenfeld ist ungültig." }, { status: 400 });
    }
    if (typeof value === "string" && value.length > 500) {
      return NextResponse.json({ error: "Ein Firmendatenfeld ist zu lang." }, { status: 400 });
    }
    companyUpdates[field] = typeof value === "string" ? value.trim() : null;
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
    const localUpdates: Partial<Lead> = {
      ...(companyUpdates.name !== undefined ? { company: companyUpdates.name || "" } : {}),
      ...(companyUpdates.contact_person !== undefined ? { contactName: companyUpdates.contact_person || "" } : {}),
      ...(companyUpdates.phone !== undefined ? { phone: companyUpdates.phone || "" } : {}),
      ...(companyUpdates.email !== undefined ? { email: companyUpdates.email || "" } : {}),
      ...(companyUpdates.street !== undefined ? { addressStreet: companyUpdates.street || "" } : {}),
      ...(companyUpdates.postal_code !== undefined ? { addressPostalCode: companyUpdates.postal_code || "" } : {}),
      ...(companyUpdates.city !== undefined ? { addressCity: companyUpdates.city || "", location: companyUpdates.city || "" } : {}),
      ...(companyUpdates.country !== undefined ? { addressCountry: companyUpdates.country || "" } : {}),
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
