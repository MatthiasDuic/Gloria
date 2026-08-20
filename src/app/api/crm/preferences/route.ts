import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { findUserById, updateUserCrmUiPreferences } from "@/lib/report-db";
import type { CrmUiPreferences } from "@/lib/types";

export const runtime = "nodejs";

function sanitizePreferences(input: unknown): CrmUiPreferences {
  if (!input || typeof input !== "object") {
    return {};
  }

  const row = input as Record<string, unknown>;
  return {
    crmTab: row.crmTab === "customers" || row.crmTab === "pipeline" || row.crmTab === "callbacks" ? row.crmTab : undefined,
    crmDetailTab:
      row.crmDetailTab === "stammdaten"
      || row.crmDetailTab === "pipeline"
      || row.crmDetailTab === "historie"
      || row.crmDetailTab === "kommunikation"
      || row.crmDetailTab === "termine"
      || row.crmDetailTab === "aufgaben"
        ? row.crmDetailTab
        : undefined,
    crmSearch: typeof row.crmSearch === "string" ? row.crmSearch : undefined,
    crmTypeFilter: row.crmTypeFilter === "BarmeniaGothaer" || row.crmTypeFilter === "Agentur-Duic" || row.crmTypeFilter === "" ? row.crmTypeFilter : undefined,
    crmCustomerKindFilter: row.crmCustomerKindFilter === "privat" || row.crmCustomerKindFilter === "firma" || row.crmCustomerKindFilter === "" ? row.crmCustomerKindFilter : undefined,
  };
}

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const user = await findUserById(sessionUser.id);
  if (!user) {
    return NextResponse.json({ error: "Benutzer nicht gefunden." }, { status: 404 });
  }

  return NextResponse.json({ preferences: user.crmUiPreferences || {} });
}

export async function PUT(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as { preferences?: unknown };
  const preferences = sanitizePreferences(payload.preferences);

  await updateUserCrmUiPreferences(sessionUser.id, preferences);

  return NextResponse.json({ ok: true, preferences });
}
