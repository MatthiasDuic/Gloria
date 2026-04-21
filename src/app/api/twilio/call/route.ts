import { NextResponse } from "next/server";
import { getTelephonyRuntimeSnapshot } from "@/lib/telephony-runtime";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { findPhoneNumberById } from "@/lib/report-db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    to?: string;
    company?: string;
    contactName?: string;
    topic?: Topic;
    leadId?: string;
    phoneNumberId?: string;
    from?: string;
  };

  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  if (!payload.to || !payload.company || !payload.topic) {
    return NextResponse.json(
      { error: "to, company und topic sind für den Anruf erforderlich." },
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
    let selectedFrom = payload.from;
    if (payload.phoneNumberId) {
      const assignedPhone = await findPhoneNumberById(payload.phoneNumberId);
      if (!assignedPhone) {
        return NextResponse.json({ error: "Rufnummer nicht gefunden." }, { status: 404 });
      }

      if (sessionUser.role !== "master" && assignedPhone.userId !== sessionUser.id) {
        return NextResponse.json({ error: "Keine Berechtigung für diese Rufnummer." }, { status: 403 });
      }

      selectedFrom = assignedPhone.phoneNumber;
    }

    const call = await createTwilioCall(
      {
        to: payload.to,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        leadId: payload.leadId,
        from: selectedFrom,
        userId: sessionUser.id,
        phoneNumberId: payload.phoneNumberId,
        ownerRealName: sessionUser.realName,
        ownerCompanyName: sessionUser.companyName,
        isTestCall: true,
      },
      request,
    );

    const runtimeSnapshot = getTelephonyRuntimeSnapshot();

    return NextResponse.json({
      ok: true,
      sid: call.sid,
      status: call.status,
      to: call.to,
      from: call.from,
      message: "Anruf wurde gestartet.",
      preinit: {
        openAiReady: runtimeSnapshot.openAiReady,
        openAiRealtimeReady: runtimeSnapshot.openAiRealtimeReady,
        elevenLabsWarm: runtimeSnapshot.elevenLabsWarm,
        scriptsReady: runtimeSnapshot.scriptsReady,
        lastRealtimeError: runtimeSnapshot.lastRealtimeError,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Anruf konnte nicht gestartet werden.";
    const status = message.startsWith("RUNTIME_NOT_READY:") ? 503 : 500;

    return NextResponse.json(
      {
        error: message.replace(/^RUNTIME_NOT_READY:\s*/, ""),
      },
      { status },
    );
  }
}
