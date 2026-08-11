import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import {
  createPhoneNumber,
  deletePhoneNumber,
  ensureMasterAdmin,
  listAllPhoneNumbers,
  listPhoneNumbersByUser,
  updatePhoneNumber,
} from "@/lib/report-db";

export const runtime = "nodejs";

const BLOCKED_OUTBOUND_NUMBERS = new Set(["+18446290030"]);

function normalizePhoneNumber(value?: string): string {
  return String(value || "").replace(/[\s()-]/g, "").trim();
}

function isBlockedOutboundNumber(value?: string): boolean {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return false;
  for (const blocked of BLOCKED_OUTBOUND_NUMBERS) {
    if (normalizePhoneNumber(blocked) === normalized) {
      return true;
    }
  }
  return false;
}

export async function GET(request: Request) {
  try {
    await ensureMasterAdmin();
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    if (sessionUser.role === "master") {
      const phoneNumbers = await listAllPhoneNumbers();
      return NextResponse.json({ phoneNumbers });
    }

    const phoneNumbers = await listPhoneNumbersByUser(sessionUser.id);
    return NextResponse.json({ phoneNumbers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rufnummern konnten nicht geladen werden." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensureMasterAdmin();
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    if (sessionUser.role !== "master") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    const payload = (await request.json().catch(() => ({}))) as {
      userId?: string;
      phoneNumber?: string;
      label?: string;
      active?: boolean;
    };

    const userId = String(payload.userId || "").trim();
    const phoneNumber = String(payload.phoneNumber || "").trim();
    const label = String(payload.label || "").trim();

    if (!userId || !phoneNumber || !label) {
      return NextResponse.json({ error: "userId, phoneNumber und label sind erforderlich." }, { status: 400 });
    }

    if (isBlockedOutboundNumber(phoneNumber)) {
      return NextResponse.json(
        { error: "Diese Rufnummer ist gesperrt und darf nicht für Telefonie verwendet werden." },
        { status: 400 },
      );
    }

    const created = await createPhoneNumber({
      userId,
      phoneNumber,
      label,
      active: payload.active !== false,
    });

    return NextResponse.json({ ok: true, phoneNumber: created });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rufnummer konnte nicht erstellt werden." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    await ensureMasterAdmin();
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    const payload = (await request.json().catch(() => ({}))) as {
      id?: string;
      phoneNumber?: string;
      label?: string;
      active?: boolean;
    };

    const id = String(payload.id || "").trim();

    if (!id) {
      return NextResponse.json({ error: "id ist erforderlich." }, { status: 400 });
    }

    if (payload.phoneNumber !== undefined && isBlockedOutboundNumber(payload.phoneNumber)) {
      return NextResponse.json(
        { error: "Diese Rufnummer ist gesperrt und darf nicht für Telefonie verwendet werden." },
        { status: 400 },
      );
    }

    if (sessionUser.role !== "master") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    await updatePhoneNumber(id, {
      phoneNumber: payload.phoneNumber,
      label: payload.label,
      active: payload.active,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rufnummer konnte nicht aktualisiert werden." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    await ensureMasterAdmin();
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    if (sessionUser.role !== "master") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    const url = new URL(request.url);
    const id = String(url.searchParams.get("id") || "").trim();

    if (!id) {
      return NextResponse.json({ error: "id ist erforderlich." }, { status: 400 });
    }

    await deletePhoneNumber(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Rufnummer konnte nicht gelöscht werden." },
      { status: 500 },
    );
  }
}
