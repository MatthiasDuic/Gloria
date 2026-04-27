import { NextResponse } from "next/server";
import {
  deleteCampaignList,
  getCampaignListsSummary,
  isCampaignListActive,
  pullNextLeadForCampaignList,
  setCampaignListActive,
  storeCallReport,
} from "@/lib/storage";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const lists = await getCampaignListsSummary(sessionUser.id);
  return NextResponse.json({ lists });
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as {
    action?: "start" | "stop" | "run" | "delete";
    listId?: string;
  };

  const action = payload.action;
  const listId = String(payload.listId || "").trim();

  if (!action || !listId) {
    return NextResponse.json({ error: "action und listId sind erforderlich." }, { status: 400 });
  }

  if (action === "start") {
    await setCampaignListActive(listId, true, sessionUser.id);
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ ok: true, action, listId, lists });
  }

  if (action === "stop") {
    await setCampaignListActive(listId, false, sessionUser.id);
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ ok: true, action, listId, lists });
  }

  if (action === "delete") {
    const result = await deleteCampaignList(listId, sessionUser.id);
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ ok: true, action, listId, removedLeads: result.removedLeads, lists });
  }

  if (!isTwilioConfigured()) {
    return NextResponse.json(
      { error: "Twilio ist nicht vollständig konfiguriert." },
      { status: 400 },
    );
  }

  const active = await isCampaignListActive(listId, sessionUser.id);

  if (!active) {
    return NextResponse.json({ ok: true, action, listId, skipped: true, reason: "list_not_active" });
  }

  const lead = await pullNextLeadForCampaignList(listId, sessionUser.id);

  if (!lead) {
    await setCampaignListActive(listId, false, sessionUser.id);
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ ok: true, action, listId, completed: true, lists });
  }

  const to = (lead.directDial || lead.phone || "").trim();

  if (!to) {
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ ok: true, action, listId, skipped: true, reason: "missing_phone", lists });
  }

  try {
    const call = await createTwilioCall(
      {
        to,
        company: lead.company,
        contactName: lead.contactName,
        topic: lead.topic,
        leadId: lead.id,
        userId: sessionUser.id,
        ownerRealName: sessionUser.realName,
        ownerCompanyName: sessionUser.companyName,
        ownerGesellschaft: sessionUser.gesellschaft,
      },
      request,
    );

    await storeCallReport({
      callSid: call.sid,
      leadId: lead.id,
      company: lead.company,
      contactName: lead.contactName,
      topic: lead.topic,
      summary: `Kampagnenanruf gestartet (${new Date().toISOString()}).`,
      outcome: "Kein Kontakt",
      attempts: lead.attempts,
      userId: sessionUser.id,
    });

    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({
      ok: true,
      action,
      listId,
      dialed: true,
      call: {
        sid: call.sid,
        to,
        company: lead.company,
      },
      lists,
    });
  } catch (error) {
    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json(
      {
        ok: false,
        action,
        listId,
        error: error instanceof Error ? error.message : "Anruf konnte nicht gestartet werden.",
        lists,
      },
      { status: 500 },
    );
  }
}
