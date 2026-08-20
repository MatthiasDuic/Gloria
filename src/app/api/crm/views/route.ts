import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { findUserById, updateUserCrmSavedViews } from "@/lib/report-db";
import type { CrmSavedView } from "@/lib/types";

export const runtime = "nodejs";

function sanitizeSavedViews(input: unknown): CrmSavedView[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const search = typeof row.search === "string" ? row.search : "";
      const owner = row.owner === "BarmeniaGothaer" || row.owner === "Agentur-Duic" ? row.owner : "";
      const customerKind = row.customerKind === "privat" || row.customerKind === "firma" ? row.customerKind : "";
      const productFilter = typeof row.productFilter === "string" ? row.productFilter : "";
      const createdAt = typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString();

      if (!id || !name) return null;

      return {
        id,
        name,
        search,
        owner,
        customerKind,
        productFilter,
        createdAt,
      } as CrmSavedView;
    })
    .filter((entry): entry is CrmSavedView => Boolean(entry))
    .slice(0, 20);
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

  return NextResponse.json({ views: user.crmSavedViews || [] });
}

export async function PUT(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as { views?: unknown };
  const views = sanitizeSavedViews(payload.views);

  await updateUserCrmSavedViews(sessionUser.id, views);

  return NextResponse.json({ ok: true, views });
}
