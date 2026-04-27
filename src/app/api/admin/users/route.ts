import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { createUser, ensureMasterAdmin, listAllPhoneNumbers, listUsers } from "@/lib/report-db";

export const runtime = "nodejs";

function requireMaster(request: Request) {
  const user = getSessionUserFromRequest(request);

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  if (user.role !== "master") {
    throw new Error("FORBIDDEN");
  }

  return user;
}

export async function GET(request: Request) {
  try {
    await ensureMasterAdmin();
    requireMaster(request);
    const [users, phones] = await Promise.all([listUsers(), listAllPhoneNumbers()]);
    const phonesByUser = new Map<string, typeof phones>();
    for (const phone of phones) {
      const list = phonesByUser.get(phone.userId) || [];
      list.push(phone);
      phonesByUser.set(phone.userId, list);
    }

    return NextResponse.json({
      users: users.map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role,
        realName: user.realName,
        companyName: user.companyName,
        address: user.address,
        email: user.email,
        realPhone: user.realPhone,
        gesellschaft: user.gesellschaft,
        createdAt: user.createdAt,
        phoneNumbers: phonesByUser.get(user.id) || [],
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    return NextResponse.json({ error: "Benutzer konnten nicht geladen werden." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureMasterAdmin();
    requireMaster(request);

    const payload = (await request.json().catch(() => ({}))) as {
      username?: string;
      realName?: string;
      companyName?: string;
      address?: string;
      email?: string;
      realPhone?: string;
      gesellschaft?: string;
      password?: string;
      role?: "master" | "user";
    };

    const username = String(payload.username || "").trim();
    const realName = String(payload.realName || "").trim();
    const companyName = String(payload.companyName || "").trim();
    const password = String(payload.password || "");

    if (!username || !realName || !companyName || !password) {
      return NextResponse.json({ error: "username, realName, companyName und password sind erforderlich." }, { status: 400 });
    }

    const user = await createUser({
      username,
      realName,
      companyName,
      address: String(payload.address || "").trim(),
      email: String(payload.email || "").trim(),
      realPhone: String(payload.realPhone || "").trim(),
      gesellschaft: String(payload.gesellschaft || "").trim(),
      password,
      role: payload.role === "master" ? "master" : "user",
    });

    return NextResponse.json({
      ok: true,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        realName: user.realName,
        companyName: user.companyName,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }
    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Benutzer konnte nicht erstellt werden." },
      { status: 500 },
    );
  }
}
