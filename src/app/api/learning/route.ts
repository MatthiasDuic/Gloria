import { NextResponse } from "next/server";
import { applyLearningSuggestion, getLearningResponse } from "@/lib/learning";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const learning = await getLearningResponse();
  return NextResponse.json(learning);
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic };

  if (!payload.topic) {
    return NextResponse.json({ error: "Thema fehlt." }, { status: 400 });
  }

  const result = await applyLearningSuggestion(payload.topic);
  return NextResponse.json({ ok: true, ...result });
}
