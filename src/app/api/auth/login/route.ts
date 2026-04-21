import { NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";
import { findUserByUsername, verifyUserPassword, ensureMasterAdmin } from "@/lib/report-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };

  const username = String(payload.username || "").trim();
  const password = String(payload.password || "");

  if (!username || !password) {
    return NextResponse.json({ error: "Benutzername und Passwort sind erforderlich." }, { status: 400 });
  }

  await ensureMasterAdmin();
  const user = await findUserByUsername(username);

  if (!user || !verifyUserPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: "Ungültige Zugangsdaten." }, { status: 401 });
  }

  const token = createSessionToken({
    id: user.id,
    username: user.username,
    role: user.role,
    realName: user.realName,
    companyName: user.companyName,
  });

  const response = NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      realName: user.realName,
      companyName: user.companyName,
    },
  });

  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 60 * 60 * 12,
  });

  return response;
}
