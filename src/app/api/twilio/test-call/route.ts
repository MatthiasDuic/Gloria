import { NextResponse } from "next/server";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";
import type { Topic } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    to?: string;
    company?: string;
    contactName?: string;
    topic?: Topic;
    leadId?: string;
  };

  if (!payload.to || !payload.company || !payload.topic) {
    return NextResponse.json(
      { error: "to, company und topic sind für den Twilio-Testanruf erforderlich." },
      { status: 400 },
    );
  }

  if (!isTwilioConfigured()) {
    return NextResponse.json(
      {
        error:
          "Twilio ist noch nicht vollständig konfiguriert. Bitte setze TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN und TWILIO_PHONE_NUMBER in .env.local.",
      },
      { status: 400 },
    );
  }

  try {
    const call = await createTwilioCall({
      to: payload.to,
      company: payload.company,
      contactName: payload.contactName,
      topic: payload.topic,
      leadId: payload.leadId,
    });

    return NextResponse.json({
      ok: true,
      sid: call.sid,
      status: call.status,
      to: call.to,
      from: call.from,
      message: "Twilio-Testanruf wurde gestartet.",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Twilio-Testanruf konnte nicht gestartet werden.",
      },
      { status: 500 },
    );
  }
}
