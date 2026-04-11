import { NextResponse } from "next/server";
import { generateAdaptiveReply } from "@/lib/live-agent";
import { getDashboardData } from "@/lib/storage";
import { TOPICS } from "@/lib/types";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

function normalizeTopic(value?: string | null): Topic {
  const found = TOPICS.find((topic) => topic === value);
  return found || TOPICS[0];
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    topic?: Topic;
    prospectMessage?: string;
    transcript?: string;
  };

  if (!payload.prospectMessage?.trim()) {
    return NextResponse.json({ error: "prospectMessage fehlt." }, { status: 400 });
  }

  const topic = normalizeTopic(payload.topic);
  const data = await getDashboardData();
  const script = data.scripts.find((entry) => entry.topic === topic);
  const result = await generateAdaptiveReply({
    topic,
    prospectMessage: payload.prospectMessage,
    transcript: payload.transcript,
    script,
  });

  return NextResponse.json({ ok: true, ...result });
}
