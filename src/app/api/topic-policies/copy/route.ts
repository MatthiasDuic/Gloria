import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getDashboardData } from "@/lib/storage";
import { createPersonalCampaignCopy } from "@/lib/report-db";
import { isSharedCampaignTopic } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = getSessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  const payload = await request.json().catch(() => null);
  const sourceTopic = typeof payload?.sourceTopic === "string" ? payload.sourceTopic.trim() : "";
  const topic = typeof payload?.topic === "string" ? payload.topic.trim() : "";
  if (!sourceTopic || !topic || topic.length > 120 || isSharedCampaignTopic(topic)) {
    return NextResponse.json({ error: "Bitte einen eigenen, nicht reservierten Kampagnennamen angeben." }, { status: 400 });
  }
  const data = await getDashboardData({ userId: user.id, role: user.role });
  const source = data.topicPolicies.find((policy) => policy.topic === sourceTopic);
  if (!source) return NextResponse.json({ error: "Quellkampagne nicht gefunden." }, { status: 404 });
  const copy = await createPersonalCampaignCopy(user.id, source, topic);
  if (!copy) return NextResponse.json({ error: "Dieser Kampagnenname wird bereits verwendet." }, { status: 409 });
  return NextResponse.json({ ok: true, topicPolicy: copy }, { status: 201 });
}