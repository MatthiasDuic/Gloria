import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { deleteUser, ensureMasterAdmin, updateUser } from "@/lib/report-db";

export const runtime = "nodejs";

function requireMaster(request: Request) {
  const user = getSessionUserFromRequest(request);

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  if (user.role !== "master") {
    throw new Error("FORBIDDEN");
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await ensureMasterAdmin();
    requireMaster(request);

    const { userId } = await context.params;
    const payload = (await request.json().catch(() => ({}))) as {
      username?: string;
      realName?: string;
      companyName?: string;
      address?: string;
      email?: string;
      realPhone?: string;
      password?: string;
      role?: "master" | "user";
    };

    await updateUser(userId, {
      username: payload.username,
      realName: payload.realName,
      companyName: payload.companyName,
      address: payload.address,
      email: payload.email,
      realPhone: payload.realPhone,
      password: payload.password,
      role: payload.role,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Benutzer konnte nicht aktualisiert werden." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await ensureMasterAdmin();
    requireMaster(request);

    const { userId } = await context.params;
    await deleteUser(userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Benutzer konnte nicht gelöscht werden." },
      { status: 500 },
    );
  }
}
