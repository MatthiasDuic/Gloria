import { NextResponse } from "next/server";
import { saveScript } from "@/lib/storage";
import type { ScriptConfig } from "@/lib/types";

export async function POST(request: Request) {
  const payload = (await request.json()) as Partial<ScriptConfig> & { topic?: ScriptConfig["topic"] };

  if (!payload.topic) {
    return NextResponse.json({ error: "Thema fehlt." }, { status: 400 });
  }

  try {
    const result = await saveScript(payload.topic, payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Skript konnte nicht gespeichert werden.",
      },
      { status: 500 },
    );
  }
}
