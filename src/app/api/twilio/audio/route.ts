import { NextResponse } from "next/server";
import { generateElevenLabsPreview, isElevenLabsConfigured } from "@/lib/elevenlabs";
import type { Topic } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function buildTopicPitch(topic: Topic) {
  if (topic === "betriebliche Altersvorsorge") {
    return "Es geht um eine kurze Einordnung, wie die betriebliche Altersvorsorge für Mitarbeitende verständlich und attraktiv aufgestellt werden kann.";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Es geht um einen kompakten Abgleich, ob Preis und Leistung Ihrer gewerblichen Absicherung noch sauber zusammenpassen.";
  }

  if (topic === "private Krankenversicherung") {
    return "Es geht um die Frage, wie sich Krankenversicherungsbeiträge im Alter planbarer und stabiler aufstellen lassen.";
  }

  if (topic === "Energie") {
    return "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich mit möglichem Einsparpotenzial.";
  }

  return "Es geht um einen kurzen Überblick, wie Unternehmen mit der betrieblichen Krankenversicherung Fachkräfte besser binden können.";
}

function buildAudioText(params: URLSearchParams) {
  const directText = params.get("text");

  if (directText?.trim()) {
    return directText.trim();
  }

  const step = params.get("step") || "intro";
  const topic = (params.get("topic") || "betriebliche Krankenversicherung") as Topic;
  const contactName = params.get("contactName") || "";
  const consent = params.get("consent") === "yes";
  const variant = params.get("variant") || "neutral";

  if (step === "intro") {
    return `Guten Tag${contactName ? ` ${contactName}` : ""}, hier ist Gloria im Auftrag von Matthias Duic. ${buildTopicPitch(topic)} Bin ich dafür direkt bei der richtigen Ansprechperson, oder wer wäre bei Ihnen dafür zuständig?`;
  }

  if (step === "consent-retry") {
    return "Danke. Ich habe Sie akustisch gerade nicht ganz verstanden. Ist eine kurze Aufzeichnung für Schulung und Qualität in Ordnung? Sie können einfach ja oder nein sagen.";
  }

  if (step === "appointment") {
    return `${consent ? "Vielen Dank, ich notiere die Zustimmung." : "Natürlich, dann ohne Aufzeichnung."} ${buildTopicPitch(topic)} Passt dafür eher ein kurzer Termin mit Herrn Duic, oder soll ich eine Wiedervorlage notieren?`;
  }

  if (step === "final") {
    if (variant === "success") {
      return "Perfekt, dann ist ein kurzer Termin vorgemerkt. Herr Duic meldet sich mit der Bestätigung. Vielen Dank für Ihre Zeit.";
    }

    if (variant === "callback") {
      return "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.";
    }

    if (variant === "rejection") {
      return "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.";
    }

    return "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.";
  }

  return `Guten Tag${contactName ? ` ${contactName}` : ""}. Hier ist Gloria, die digitale Vertriebsassistentin im Auftrag von Herrn Matthias Duic. ${buildTopicPitch(topic)} Bevor wir starten: Darf ich dieses Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Sagen Sie bitte ja oder nein.`;
}

export async function GET(request: Request) {
  if (!isElevenLabsConfigured()) {
    return NextResponse.json(
      { error: "ElevenLabs ist für Telefonie noch nicht konfiguriert." },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(request.url);
  const text = buildAudioText(searchParams);
  const voiceResult = await generateElevenLabsPreview(text);

  if (voiceResult.provider !== "elevenlabs" || !voiceResult.audioBase64) {
    return NextResponse.json(
      {
        error: voiceResult.error || "ElevenLabs konnte kein Telefon-Audio erzeugen.",
      },
      { status: 502 },
    );
  }

  const audioBuffer = Buffer.from(voiceResult.audioBase64, "base64");

  return new NextResponse(audioBuffer, {
    headers: {
      "Content-Type": voiceResult.audioMimeType || "audio/mpeg",
      "Cache-Control": "no-store, max-age=0",
      "Content-Length": String(audioBuffer.length),
    },
  });
}
