import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import {
  getDefaultElevenLabsVoiceId,
  listElevenLabsVoices,
  type ElevenLabsVoiceOption,
} from "@/lib/elevenlabs";
import { ensureMasterAdmin, findUserById } from "@/lib/report-db";

export const runtime = "nodejs";

function dedupeVoices(voices: ElevenLabsVoiceOption[]): ElevenLabsVoiceOption[] {
  const seen = new Set<string>();
  const out: ElevenLabsVoiceOption[] = [];
  for (const voice of voices) {
    if (!voice.id || seen.has(voice.id)) {
      continue;
    }
    seen.add(voice.id);
    out.push(voice);
  }
  return out;
}

export async function GET(request: Request) {
  try {
    await ensureMasterAdmin();
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    const userRecord = await findUserById(sessionUser.id);
    const selectedVoiceId = userRecord?.selectedVoiceId || getDefaultElevenLabsVoiceId();

    const voices = await listElevenLabsVoices();
    const fallback = getDefaultElevenLabsVoiceId();

    const merged = dedupeVoices([
      ...voices,
      ...(fallback
        ? [
            {
              id: fallback,
              name: "Standard-Stimme",
              category: "default",
            },
          ]
        : []),
      ...(selectedVoiceId && selectedVoiceId !== fallback
        ? [
            {
              id: selectedVoiceId,
              name: "Ausgewählte Benutzerstimme",
              category: "user",
            },
          ]
        : []),
    ]);

    return NextResponse.json({
      voices: merged,
      selectedVoiceId,
      defaultVoiceId: fallback,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stimmen konnten nicht geladen werden." },
      { status: 500 },
    );
  }
}
