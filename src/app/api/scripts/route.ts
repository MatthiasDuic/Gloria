import { NextResponse } from "next/server";
import { saveScript } from "@/lib/storage";
import type { ScriptConfig } from "@/lib/types";

export async function POST(request: Request) {
  const payload = (await request.json()) as Partial<ScriptConfig> & { topic?: ScriptConfig["topic"] };

  if (!payload.topic) {
    return NextResponse.json({ error: "Thema fehlt." }, { status: 400 });
  }

  const updated = await saveScript(payload.topic, payload);

  return NextResponse.json({ ok: true, script: updated });
}
