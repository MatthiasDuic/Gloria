import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { findUserByCrmUserId } from "@/lib/report-db";
import { importLeadsFromCrm, type CrmCompanyImport } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasValidToken(request: Request, expectedToken: string): boolean {
  const provided = request.headers.get("x-gloria-integration-token") || "";
  const expected = Buffer.from(expectedToken, "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function POST(request: Request) {
  const expectedToken = process.env.GLORIA_CRM_INTEGRATION_TOKEN?.trim();
  if (!expectedToken) {
    return NextResponse.json({ error: "CRM-Integration ist in Gloria nicht konfiguriert." }, { status: 503 });
  }
  if (!hasValidToken(request, expectedToken)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger JSON-Inhalt." }, { status: 400 });
  }

  if (
    !isRecord(payload) ||
    typeof payload.crmUserId !== "string" ||
    !payload.crmUserId.trim() ||
    payload.crmUserId.length > 160 ||
    typeof payload.listId !== "string" ||
    !payload.listId.trim() ||
    payload.listId.length > 160 ||
    typeof payload.listName !== "string" ||
    !payload.listName.trim() ||
    !Array.isArray(payload.companies) ||
    payload.companies.length === 0 ||
    payload.companies.length > 100
  ) {
    return NextResponse.json({ error: "Kampagnendaten sind unvollständig oder ungültig." }, { status: 400 });
  }

  const companies: CrmCompanyImport[] = [];
  for (const company of payload.companies) {
    if (
      !isRecord(company) ||
      !Number.isSafeInteger(company.crmCompanyId) ||
      Number(company.crmCompanyId) <= 0 ||
      typeof company.company !== "string" ||
      !company.company.trim() ||
      typeof company.phone !== "string" ||
      !isRecord(company.crmCompanyData)
    ) {
      return NextResponse.json({ error: "Ein Firmendatensatz ist ungültig." }, { status: 400 });
    }

    companies.push({
      crmCompanyId: Number(company.crmCompanyId),
      company: company.company.trim(),
      phone: company.phone,
      email: typeof company.email === "string" ? company.email : undefined,
      contactName: typeof company.contactName === "string" ? company.contactName : undefined,
      topic: typeof company.topic === "string" ? company.topic : undefined,
      crmCompanyData: company.crmCompanyData,
    });
  }

  try {
    const pairedUser = await findUserByCrmUserId(payload.crmUserId.trim());
    if (!pairedUser) {
      return NextResponse.json({ error: "Kein zu diesem CRM-Benutzer gepaartes Gloria-Konto gefunden." }, { status: 403 });
    }
    const result = await importLeadsFromCrm(companies, {
      listId: payload.listId,
      listName: payload.listName.trim(),
      userId: pairedUser.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("CRM integration import failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CRM-Daten konnten nicht importiert werden." },
      { status: 500 },
    );
  }
}
