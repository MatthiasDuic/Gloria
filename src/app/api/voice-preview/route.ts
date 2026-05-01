import { NextResponse } from "next/server";
import { generateElevenLabsPreview, isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildSystemPrompt, buildVoicePreview } from "@/lib/gloria";
import { getDashboardData } from "@/lib/storage";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { findUserById } from "@/lib/report-db";

export const dynamic = "force-dynamic";

async function buildVoicePayload(request: Request, topic?: Topic, voiceId?: string) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    throw new Error("Nicht angemeldet.");
  }

  const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
  const script = data.playbooks.find((entry) => entry.topic === topic) || data.playbooks[0];
  const preview = buildVoicePreview(script);
  const latestUser = await findUserById(sessionUser.id);
  const resolvedVoiceId = String(voiceId || latestUser?.selectedVoiceId || "").trim() || undefined;
  const voiceResult = await generateElevenLabsPreview(preview, resolvedVoiceId);

  return {
    preview,
    systemPrompt: buildSystemPrompt(script),
    provider: voiceResult.provider,
    elevenLabsConfigured: isElevenLabsConfigured(),
    audioBase64: voiceResult.audioBase64,
    audioMimeType: voiceResult.audioMimeType,
    voiceId: resolvedVoiceId,
    message:
      voiceResult.provider === "elevenlabs"
        ? "ElevenLabs-Stimme erfolgreich geladen."
        : voiceResult.error || "Browser-Stimme wird als Fallback verwendet.",
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topic = searchParams.get("topic") as Topic | null;
  const voiceId = searchParams.get("voiceId") || undefined;
  try {
    return NextResponse.json(await buildVoicePayload(request, topic || undefined, voiceId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Vorschau fehlgeschlagen." }, { status: 401 });
  }
}

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { topic?: Topic; voiceId?: string };
  try {
    return NextResponse.json(await buildVoicePayload(request, payload.topic, payload.voiceId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Vorschau fehlgeschlagen." }, { status: 401 });
  }
}
