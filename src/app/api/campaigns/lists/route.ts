import { NextResponse } from "next/server";
import {
  deleteCampaignList,
  getCampaignListsSummary,
  isCampaignListActive,
  pullNextLeadForCampaignList,
  setCampaignListActive,
  storeCallReport,
} from "@/lib/storage";
import { createTelnyxCall, isTelnyxConfigured } from "@/lib/telnyx";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { acquireCampaignCallLock, bindCampaignCallLock, releaseCampaignCallLockByToken } from "@/lib/report-db";
import { normalizePhoneForDial } from "@/lib/phone-utils";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    const lists = await getCampaignListsSummary(sessionUser.id);
    return NextResponse.json({ lists });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Listen konnten nicht geladen werden." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
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

    if (!isTelnyxConfigured()) {
      return NextResponse.json(
        { error: "Telnyx ist nicht vollstaendig konfiguriert." },
        { status: 400 },
      );
    }

    const active = await isCampaignListActive(listId, sessionUser.id);

    if (!active) {
      return NextResponse.json({ ok: true, action, listId, skipped: true, reason: "list_not_active" });
    }

    const lockToken = `campaign-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const lockAcquired = await acquireCampaignCallLock({ userId: sessionUser.id, leadId: listId, lockToken });
    if (!lockAcquired) {
      const lists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({ ok: true, action, listId, skipped: true, reason: "active_call", lists });
    }

    const lead = await pullNextLeadForCampaignList(listId, sessionUser.id);

    if (!lead) {
      await releaseCampaignCallLockByToken(lockToken);
      await setCampaignListActive(listId, false, sessionUser.id);
      const lists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({ ok: true, action, listId, completed: true, lists });
    }

    const rawTo = (lead.directDial || lead.phone || "").trim();
    const to = normalizePhoneForDial(rawTo);

    if (!to) {
      await releaseCampaignCallLockByToken(lockToken);
      const lists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({
        ok: true,
        action,
        listId,
        skipped: true,
        reason: rawTo ? "invalid_phone_format" : "missing_phone",
        lists,
      });
    }

    // Hard stop guard: if user pressed "Stop" while this request was already in
    // flight, do not start another call.
    const stillActive = await isCampaignListActive(listId, sessionUser.id);
    if (!stillActive) {
      const lists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({
        ok: true,
        action,
        listId,
        skipped: true,
        reason: "list_not_active",
        lists,
      });
    }

    try {
      const call = await createTelnyxCall(
        {
          to,
          company: lead.company,
          contactName: lead.contactName,
          leadNote: lead.note,
          topic: lead.topic,
          leadId: lead.id,
          userId: lead.userId || sessionUser.id,
          ownerRealName: sessionUser.realName,
          ownerCompanyName: sessionUser.companyName,
          ownerGesellschaft: sessionUser.gesellschaft,
        },
        request,
      );
      await bindCampaignCallLock(lockToken, call.sid);

      await storeCallReport({
        callSid: call.sid,
        leadId: lead.id,
        company: lead.company,
        contactName: lead.contactName,
        topic: lead.topic,
        summary: `Kampagnenanruf gestartet (${new Date().toISOString()}).`,
        outcome: "Nicht erreicht / kein Kontakt",
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
      await releaseCampaignCallLockByToken(lockToken);
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
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Listenaktion fehlgeschlagen." },
      { status: 500 },
    );
  }
}
