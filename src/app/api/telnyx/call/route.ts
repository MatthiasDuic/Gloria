import { NextResponse } from "next/server";
import { getTelephonyRuntimeSnapshot } from "@/lib/telephony-runtime";
import { isTelnyxConfigured, TelnyxApiError } from "@/lib/telnyx";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { canUserAccessTopic, findPhoneNumberById, findUserById } from "@/lib/report-db";
import { queueOutboundCall } from "@/lib/outbound-call-queue";

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

  if (!isTelnyxConfigured()) {
    return NextResponse.json(
      {
        error: "Telnyx ist nicht vollstaendig konfiguriert. Bitte TELNYX_API_KEY, TELNYX_CONNECTION_ID und TELNYX_PHONE_NUMBER setzen.",
      },
      { status: 400 },
    );
  }

  try {
    const latestUser = await findUserById(sessionUser.id);
    if (!latestUser) {
      return NextResponse.json({ error: "Benutzer nicht gefunden." }, { status: 404 });
    }

    const allowed = await canUserAccessTopic(sessionUser.id, payload.topic);
    if (!allowed) {
      return NextResponse.json({ error: "Dieses Thema ist für Ihren Benutzer nicht freigegeben." }, { status: 403 });
    }

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

    const callPayload = {
      to: payload.to,
      company: payload.company,
      contactName: payload.contactName,
      topic: payload.topic,
      callSource: "manual" as const,
      from: selectedFrom,
      userId: sessionUser.id,
      phoneNumberId: payload.phoneNumberId,
      ownerRealName: sessionUser.realName,
      ownerCompanyName: sessionUser.companyName,
      ownerGesellschaft: sessionUser.gesellschaft,
      voiceId: latestUser.selectedVoiceId,
      isTestCall: true,
    };

    const queued = await queueOutboundCall({
      payload: callPayload,
      request,
      report: {
        callSource: "manual",
        userId: sessionUser.id,
        phoneNumberId: payload.phoneNumberId,
        company: payload.company,
        contactName: payload.contactName,
        topic: payload.topic,
        calledPhone: payload.to,
        summaryChunk: "Manueller Einzelanruf gestartet.",
      },
    });

    const runtimeSnapshot = getTelephonyRuntimeSnapshot();

    return NextResponse.json({
      ok: queued.status !== "failed",
      queueId: queued.queueId,
      sid: queued.callSid,
      status: queued.status,
      position: queued.position,
      to: callPayload.to,
      from: callPayload.from,
      message: queued.status === "active" || queued.status === "completed"
        ? "Anruf wurde gestartet."
        : queued.status === "failed"
          ? "Anruf konnte nicht gestartet werden."
          : queued.status === "starting"
            ? "Anruf wird gerade aufgebaut."
            : `Anruf wurde angenommen und wartet auf einen freien Platz (Position ${queued.position}).`,
      ...(queued.error ? { error: queued.error } : {}),
      preinit: {
        openAiReady: runtimeSnapshot.openAiReady,
        elevenLabsWarm: runtimeSnapshot.elevenLabsWarm,
        scriptsReady: runtimeSnapshot.scriptsReady,
      },
    }, { status: queued.status === "failed" ? 502 : 200 });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Anruf konnte nicht gestartet werden.";
    const status =
      message.startsWith("RUNTIME_NOT_READY:")
        ? 503
        : error instanceof TelnyxApiError
          ? error.status
          : 500;

    return NextResponse.json(
      {
        error: message.replace(/^RUNTIME_NOT_READY:\s*/, ""),
      },
      { status },
    );
  }
}
