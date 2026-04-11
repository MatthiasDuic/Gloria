import { NextResponse } from "next/server";
import { buildLiveAgentConfig } from "@/lib/live-agent";
import { getDashboardData } from "@/lib/storage";
import { TOPICS } from "@/lib/types";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

function normalizeTopic(value?: string | null): Topic {
  const found = TOPICS.find((topic) => topic === value);
  return found || TOPICS[0];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topic = normalizeTopic(searchParams.get("topic"));
  const data = await getDashboardData();
  const script = data.scripts.find((entry) => entry.topic === topic);

  return NextResponse.json(buildLiveAgentConfig(topic, script));
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic };
  const topic = normalizeTopic(payload.topic);
  const data = await getDashboardData();
  const script = data.scripts.find((entry) => entry.topic === topic);

  return NextResponse.json(buildLiveAgentConfig(topic, script));
}
