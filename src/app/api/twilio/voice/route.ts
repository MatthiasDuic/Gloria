import { NextResponse } from "next/server";
import twilio from "twilio";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { getDashboardData } from "@/lib/storage";
import { getAppBaseUrl } from "@/lib/twilio";

export const runtime = "nodejs";

function getContext(request: Request) {
  const url = new URL(request.url);

  return {
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Ihr Unternehmen",
    contactName: url.searchParams.get("contactName") || "",
    topic: url.searchParams.get("topic") || "betriebliche Krankenversicherung",
  };
}

function buildPitch(topic: string) {
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

function buildAudioUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const url = new URL("/api/twilio/audio", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

async function renderVoiceResponse(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const context = getContext(request);
  const response = new twilio.twiml.VoiceResponse();
  const dashboardData = await getDashboardData();
  const activeScript = dashboardData.scripts.find((entry) => entry.topic === context.topic);
  const gather = response.gather({
    input: ["speech", "dtmf"],
    numDigits: 1,
    action: `${baseUrl}/api/twilio/voice/process?step=intro&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`,
    method: "POST",
    language: "de-DE",
    speechTimeout: "auto",
    hints: "zuständig, richtige Ansprechperson, worum geht es, ja bitte, einen Moment",
  });

  const openingText = context.contactName
    ? `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel. Spreche ich mit ${context.contactName}, oder könnten Sie mich bitte kurz dorthin verbinden?`
    : `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel. ${buildPitch(context.topic)} Bin ich dafür direkt bei der richtigen Ansprechperson?`;

  if (isElevenLabsConfigured()) {
    gather.play(
      buildAudioUrl(baseUrl, {
        step: "intro",
        topic: context.topic,
        contactName: context.contactName,
      }),
    );
  } else {
    gather.say({ voice: "alice", language: "de-DE" }, openingText);
  }

  response.redirect(
    { method: "POST" },
    `${baseUrl}/api/twilio/voice/process?step=intro&fallback=1&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`,
  );

  return new NextResponse(response.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  return await renderVoiceResponse(request);
}

export async function POST(request: Request) {
  return await renderVoiceResponse(request);
}
