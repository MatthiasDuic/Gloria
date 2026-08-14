import { NextResponse } from "next/server";
import { generateElevenLabsPreview, isElevenLabsConfigured } from "@/lib/elevenlabs-tts";
import { buildSystemPrompt, buildVoicePreview } from "@/lib/gloria";
import { getDashboardData } from "@/lib/storage";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { findUserById } from "@/lib/report-db";

export const dynamic = "force-dynamic";

/**
 * Optimizes sentence boundaries for TTS: detects sentence endings,
 * avoids splitting on abbreviations (z.B., Hr., Dr., etc.)
 * and normalizes whitespace for natural speech.
 */
function optimizeForTTS(text: string): string {
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;

    // Check for sentence boundaries: period/exclamation/question + sufficient context
    if (/[.!?]/.test(ch) && current.length >= 8) {
      // Avoid splitting on abbreviations: "z.B.", "Hr.", "Dr.", etc.
      const tail = current.slice(-3).toLowerCase();
      const isAbbrev =
        /\b(z|b|hr|fr|dr|st|ca|bzw|usw|inkl|ggf|evtl|nr|tel|app)\.$/i.test(current) ||
        /\b\d+\.$/.test(current) || // Ordinal numbers: "30.", "12."
        tail.endsWith(" z.") ||
        tail.endsWith(" b.");

      if (!isAbbrev) {
        // Valid sentence end: trim and add
        sentences.push(current.trim());
        current = "";
      }
    }
  }

  // Add remaining text as final sentence
  if (current.trim().length > 0) {
    sentences.push(current.trim());
  }

  // Join sentences with proper spacing for natural TTS pacing
  return sentences.join(" ");
}

async function generateLLMVoicePreview(systemPrompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4.1";

  // Mock customer input to generate natural Gloria response
  const mockCustomerInput = "Guten Tag, worum geht es?";

  const messages = [
    {
      role: "system" as const,
      content: systemPrompt,
    },
    {
      role: "user" as const,
      content: mockCustomerInput,
    },
  ];

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_tokens: 150,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI error: ${error.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  let reply = data.choices?.[0]?.message?.content?.trim() || "";

  // Try to extract reply if it's JSON (might be wrapped in JSON response)
  try {
    const parsed = JSON.parse(reply);
    reply = parsed.reply || reply;
  } catch {
    // Not JSON, use as-is
  }

  // Optimize for TTS: clean sentence boundaries, avoid bad splits on abbreviations
  reply = optimizeForTTS(reply);

  return reply.slice(0, 300); // Limit length for TTS
}

async function buildVoicePayload(request: Request, topic?: Topic, voiceId?: string) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    throw new Error("Nicht angemeldet.");
  }

  const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
  const script = data.topicPolicies.find((entry) => entry.topic === topic) || data.topicPolicies[0];
  if (!script) throw new Error("Keine Topic Policy für die Stimmvorschau verfügbar.");
  const systemPrompt = buildSystemPrompt(script);
  
  // Generate LLM response with full system prompt for realistic preview
  let preview: string;
  try {
    preview = await generateLLMVoicePreview(systemPrompt);
  } catch {
    // Fallback to static preview on LLM error, but still optimize for TTS
    const staticPreview = buildVoicePreview(script);
    preview = optimizeForTTS(staticPreview);
  }

  const latestUser = await findUserById(sessionUser.id);
  const resolvedVoiceId = String(voiceId || latestUser?.selectedVoiceId || "").trim() || undefined;
  const voiceResult = await generateElevenLabsPreview(preview, resolvedVoiceId);

  return {
    preview,
    systemPrompt,
    provider: voiceResult.provider,
    elevenLabsConfigured: isElevenLabsConfigured(),
    audioBase64: voiceResult.audioBase64,
    audioMimeType: voiceResult.audioMimeType,
    voiceId: resolvedVoiceId,
    message:
      voiceResult.audioBase64
        ? "ElevenLabs-Stimme geladen (LLM-generiert)."
        : voiceResult.error || "ElevenLabs-Audio konnte nicht geladen werden.",
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
