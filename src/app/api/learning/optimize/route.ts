import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getDashboardData, saveScript } from "@/lib/storage";
import { optimizePlaybook } from "@/lib/playbook-optimizer";
import type { Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isTopic(value: unknown): value is Topic {
  return typeof value === "string" && (TOPICS as readonly string[]).includes(value);
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const apply = url.searchParams.get("apply") === "1";
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;

  const body = (await request.json().catch(() => ({}))) as { topic?: unknown };
  if (!isTopic(body.topic)) {
    return NextResponse.json({ error: "Thema fehlt oder ungueltig." }, { status: 400 });
  }

  const data = await getDashboardData({ userId: resolvedUserId, role: "user" });
  const current = data.playbooks.find((p) => p.topic === body.topic);
  if (!current) {
    return NextResponse.json({ error: "Playbook fuer Thema nicht gefunden." }, { status: 404 });
  }
  const reports = data.reports.filter((r) => r.topic === body.topic);

  const result = await optimizePlaybook(body.topic, reports, current);

  if (!apply) {
    return NextResponse.json({ ok: true, topic: body.topic, current, optimized: result });
  }

  const saved = await saveScript(
    body.topic,
    {
      ...current,
      opener: result.opener,
      discovery: result.discovery,
      objectionHandling: result.objectionHandling,
      close: result.close,
    },
    { userId: resolvedUserId },
  );

  return NextResponse.json({ ok: true, topic: body.topic, applied: true, saved, optimized: result });
}
