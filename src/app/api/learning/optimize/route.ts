import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getDashboardData, saveScript } from "@/lib/storage";
import { optimizeTopicPolicy } from "@/lib/topic-policy-optimizer";
import type { Topic } from "@/lib/types";
import { isSharedCampaignTopic } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isTopic(value: unknown): value is Topic {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 120;
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
  if (isSharedCampaignTopic(body.topic) && sessionUser.role !== "master") {
    return NextResponse.json({ error: "Gemeinsame Kampagnen kann nur der Master bearbeiten." }, { status: 403 });
  }

  const data = await getDashboardData({ userId: resolvedUserId, role: "user" });
  const current = data.topicPolicies.find((p) => p.topic === body.topic);
  if (!current) {
    return NextResponse.json({ error: "Topic Policy fuer Thema nicht gefunden." }, { status: 404 });
  }
  const reports = data.reports.filter((r) => r.topic === body.topic);

  const result = await optimizeTopicPolicy(body.topic, reports, current);

  if (!apply) {
    return NextResponse.json({ ok: true, topic: body.topic, current, optimized: result });
  }

  const saved = await saveScript(
    body.topic,
    {
      topic: body.topic,
      topicSummary: result.topicSummary,
      behavior: result.behavior,
      conversationGuardrails: result.conversationGuardrails,
      requiredQuestions: result.requiredQuestions,
    },
    { userId: isSharedCampaignTopic(body.topic) ? undefined : resolvedUserId },
  );

  return NextResponse.json({ ok: true, topic: body.topic, applied: true, saved, optimized: result });
}
