import { NextResponse } from "next/server";
import { generateElevenLabsPreview, isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildSystemPrompt, buildVoicePreview } from "@/lib/gloria";
import { getDashboardData } from "@/lib/storage";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";

async function buildVoicePayload(topic?: Topic) {
  const data = await getDashboardData();
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
  return NextResponse.json(await buildVoicePayload(topic || undefined));
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic };
  return NextResponse.json(await buildVoicePayload(payload.topic));
}
