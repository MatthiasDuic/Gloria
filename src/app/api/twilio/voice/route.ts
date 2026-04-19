import { NextResponse } from "next/server";
import twilio from "twilio";
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

async function renderVoiceResponse(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const context = getContext(request);
  const response = new twilio.twiml.VoiceResponse();
  // Gather silently first – let the person on the other end speak before Gloria introduces herself.
  // Gloria will respond only after hearing the first utterance from the receptionist or decision-maker.
  response.gather({
    input: ["speech", "dtmf"],
    numDigits: 1,
    action: `${baseUrl}/api/twilio/voice/process?step=intro&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`,
    method: "POST",
    language: "de-DE",
    speechTimeout: "1",
    timeout: 2,
    actionOnEmptyResult: true,
    hints: "zuständig, richtige Ansprechperson, worum geht es, ja bitte, einen Moment",
  });

  // Fallback if nobody speaks at all within the timeout.
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
