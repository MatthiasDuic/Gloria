import { NextResponse } from "next/server";
import { generateElevenLabsPreview, isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildSystemPrompt, buildVoicePreview } from "@/lib/gloria";
import { getDashboardData } from "@/lib/storage";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export const dynamic = "force-dynamic";

async function buildVoicePayload(request: Request, topic?: Topic) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    throw new Error("Nicht angemeldet.");
  }

  const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
  const script = data.scripts.find((entry) => entry.topic === topic) || data.scripts[0];
  const preview = buildVoicePreview(script);
  const voiceResult = await generateElevenLabsPreview(preview);

  return {
    preview,
    systemPrompt: buildSystemPrompt(script),
    provider: voiceResult.provider,
    elevenLabsConfigured: isElevenLabsConfigured(),
    audioBase64: voiceResult.audioBase64,
    audioMimeType: voiceResult.audioMimeType,
    message:
      voiceResult.provider === "elevenlabs"
        ? "ElevenLabs-Stimme erfolgreich geladen."
        : voiceResult.error || "Browser-Stimme wird als Fallback verwendet.",
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topic = searchParams.get("topic") as Topic | null;
  try {
    return NextResponse.json(await buildVoicePayload(request, topic || undefined));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Vorschau fehlgeschlagen." }, { status: 401 });
  }
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic };
  try {
    return NextResponse.json(await buildVoicePayload(request, payload.topic));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Vorschau fehlgeschlagen." }, { status: 401 });
  }
}
