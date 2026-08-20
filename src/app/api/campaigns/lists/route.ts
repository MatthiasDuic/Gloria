import { NextResponse } from "next/server";
import {
  addLeadTask,
  appendLeadEmailHistory,
  completeLeadTask,
  deleteCampaignList,
  getCampaignListsSummary,
  isCampaignListActive,
  pullNextLeadForCampaignList,
  setCampaignListActive,
  storeCallReport,
  updateLeadDetails,
} from "@/lib/storage";
import type { Lead } from "@/lib/types";
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
      action?: "start" | "stop" | "run" | "delete" | "update_note" | "update_lead_details" | "add_outlook_email" | "add_lead_task" | "complete_lead_task";
      listId?: string;
      leadId?: string;
      note?: string;
      taskId?: string;
      task?: {
        title?: string;
        dueAt?: string;
      };
      updates?: Partial<Lead>;
      email?: {
        subject?: string;
        body?: string;
        to?: string;
        sentAt?: string;
      };
    };

    const action = payload.action;
    const listId = String(payload.listId || "").trim();
    const leadId = String(payload.leadId || "").trim();

    if (action === "update_note") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const updatedLead = await updateLeadDetails(
        leadId,
        { note: String(payload.note || "").trim() || undefined },
        sessionUser.id,
      );
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "update_lead_details") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const updates = payload.updates || {};
      const updatedLead = await updateLeadDetails(leadId, updates, sessionUser.id);
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "add_outlook_email") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const subject = String(payload.email?.subject || "").trim();
      if (!subject) {
        return NextResponse.json({ error: "Betreff ist erforderlich." }, { status: 400 });
      }
      const updatedLead = await appendLeadEmailHistory(
        leadId,
        {
          source: "outlook",
          subject,
          body: String(payload.email?.body || "").trim() || undefined,
          to: String(payload.email?.to || "").trim() || undefined,
          sentAt: String(payload.email?.sentAt || "").trim() || undefined,
        },
        sessionUser.id,
      );
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "add_lead_task") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const title = String(payload.task?.title || "").trim();
      if (!title) {
        return NextResponse.json({ error: "Aufgabentitel ist erforderlich." }, { status: 400 });
      }
      const updatedLead = await addLeadTask(
        leadId,
        {
          title,
          dueAt: String(payload.task?.dueAt || "").trim() || undefined,
        },
        sessionUser.id,
      );
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "complete_lead_task") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const taskId = String(payload.taskId || "").trim();
      if (!taskId) {
        return NextResponse.json({ error: "taskId ist erforderlich." }, { status: 400 });
      }
      const updatedLead = await completeLeadTask(leadId, taskId, sessionUser.id);
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

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
