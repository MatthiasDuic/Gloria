import { NextResponse } from "next/server";
import { applyLearningSuggestion, getLearningResponse } from "@/lib/learning";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;

  const learning = await getLearningResponse({
    userId: resolvedUserId,
    role: "user",
  });
  return NextResponse.json(learning);
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;

  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic };

  if (!payload.topic) {
    return NextResponse.json({ error: "Thema fehlt." }, { status: 400 });
  }

  const result = await applyLearningSuggestion(payload.topic, {
    userId: resolvedUserId,
    role: "user",
  });
  return NextResponse.json({ ok: true, ...result });
}
