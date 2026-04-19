import { NextResponse } from "next/server";
import {
  listDueCallbackLeads,
  markLeadCallbackScheduled,
  storeCallReport,
} from "@/lib/storage";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";

export const runtime = "nodejs";

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();

  if (!expected) {
    return true;
  }

  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isTwilioConfigured()) {
    return NextResponse.json(
      { error: "Twilio is not configured.", processed: 0, triggered: 0 },
      { status: 400 },
    );
  }

  const dueLeads = await listDueCallbackLeads(20);
  const triggered: Array<{ leadId: string; sid: string; to: string }> = [];
  const failed: Array<{ leadId: string; reason: string }> = [];

  for (const lead of dueLeads) {
    const to = (lead.directDial || lead.phone || "").trim();

    if (!to) {
      failed.push({ leadId: lead.id, reason: "missing_phone" });
      continue;
    }

    try {
      const call = await createTwilioCall(
        {
          to,
          company: lead.company,
          contactName: lead.contactName,
          topic: lead.topic,
          leadId: lead.id,
        },
        request,
      );

      await markLeadCallbackScheduled(lead.id);
      await storeCallReport({
        callSid: call.sid,
        leadId: lead.id,
        company: lead.company,
        contactName: lead.contactName,
        topic: lead.topic,
        summary: `Automatischer Wiedervorlage-Anruf gestartet (${new Date().toISOString()}).`,
        outcome: "Kein Kontakt",
        attempts: (lead.attempts || 0) + 1,
      });

      triggered.push({ leadId: lead.id, sid: call.sid, to });
    } catch (error) {
      failed.push({
        leadId: lead.id,
        reason: error instanceof Error ? error.message : "call_start_failed",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: dueLeads.length,
    triggered: triggered.length,
    failed: failed.length,
    calls: triggered,
    errors: failed,
  });
}
