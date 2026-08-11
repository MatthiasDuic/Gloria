import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import {
  getDefaultDeepgramVoiceId,
  getProjectVoicePresets,
  type DeepgramVoiceOption,
} from "@/lib/deepgram-tts";
import { ensureMasterAdmin, findUserById } from "@/lib/report-db";

export const runtime = "nodejs";

function dedupeVoices(voices: DeepgramVoiceOption[]): DeepgramVoiceOption[] {
  const seen = new Set<string>();
  const out: DeepgramVoiceOption[] = [];
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
    const fallback = getDefaultDeepgramVoiceId();
    const selectedVoiceId = userRecord?.selectedVoiceId || fallback;

    const voices = dedupeVoices([
      ...(fallback ? [{ id: fallback, name: "Gloria Standard (Helios)", category: "default" }] : []),
      ...getProjectVoicePresets(),
      ...(selectedVoiceId && selectedVoiceId !== fallback
        ? [{ id: selectedVoiceId, name: "Ausgewählte Benutzerstimme", category: "user" }]
        : []),
    ]);

    return NextResponse.json({
      voices,
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
