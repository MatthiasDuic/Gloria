import { NextResponse } from "next/server";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";
import type { Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { canUserAccessTopic, findPhoneNumberById, findUserById } from "@/lib/report-db";
import { describePreflightFailure, runPreflight } from "@/lib/preflight";
import { log } from "@/lib/log";

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
    skipPreflight?: boolean;
  };

  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

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

  // Preflight: OpenAI + ElevenLabs + Twilio müssen alle erreichbar sein,
  // bevor der Call ausgelöst wird. Spart Wählgebühren und verhindert,
  // dass Gloria mitten im Gespräch verstummt, weil ein Dienst offline ist.
  if (!payload.skipPreflight) {
    const preflight = await runPreflight({ timeoutMs: 3000 });
    log.info("testcall.preflight", {
      ok: preflight.ok,
      durationMs: preflight.durationMs,
      checks: preflight.checks.map((c) => ({
        service: c.service,
        ok: c.ok,
        latencyMs: c.latencyMs,
        status: c.status,
      })),
    });
    if (!preflight.ok) {
      const reason = describePreflightFailure(preflight);
      log.warn("testcall.preflight_blocked", { reason });
      return NextResponse.json(
        {
          error: `Verbindung nicht stabil, Anruf wurde nicht ausgelöst. ${reason}`,
          preflight,
        },
        { status: 503 },
      );
    }
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
        ownerGesellschaft: sessionUser.gesellschaft,
        voiceId: latestUser.selectedVoiceId,
        isTestCall: true,
      },
      request,
    );

    return NextResponse.json({
      ok: true,
      sid: call.sid,
      status: call.status,
      to: call.to,
      from: call.from,
      message: "Twilio-Testanruf wurde gestartet.",
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Twilio-Testanruf konnte nicht gestartet werden.";
    const status = message.startsWith("RUNTIME_NOT_READY:") ? 503 : 500;

    return NextResponse.json(
      {
        error: message.replace(/^RUNTIME_NOT_READY:\s*/, ""),
      },
      { status },
    );
  }
}
