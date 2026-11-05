import { NextResponse } from "next/server";
import {
  addLeadTask,
  addLeadNote,
  appendLeadEmailHistory,
  buildLeadCallContext,
  completeLeadTask,
  createCampaignRunFromFirmList,
  deleteCampaignList,
  deleteFirmList,
  deleteLeads,
  getDashboardData,
  getCampaignListsSummary,
  getFirmListsSummary,
  isCampaignListActive,
  pullNextLeadForCampaignList,
  setCampaignListActive,
  updateLeadDetails,
} from "@/lib/storage";
import type { Lead } from "@/lib/types";
import { TOPICS } from "@/lib/types";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { acquireCampaignCallLock, releaseCampaignCallLockByToken } from "@/lib/report-db";
import { normalizePhoneForDial } from "@/lib/phone-utils";
import { queueOutboundCall } from "@/lib/outbound-call-queue";
import { describeCampaignSchedule, isWithinCampaignHours } from "@/lib/campaign-schedule";
import { syncCrmCompanyEvent } from "@/lib/crm-sync";
import { CampaignContactSelectionError, type CampaignContactSelection } from "@/lib/crm-helpers";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    const [lists, firmLists] = await Promise.all([
      getCampaignListsSummary(sessionUser.id),
      getFirmListsSummary(sessionUser.id),
    ]);
    return NextResponse.json({ lists, firmLists });
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
      action?: "start" | "stop" | "run" | "delete" | "delete_firm_list" | "delete_lead" | "delete_leads" | "update_note" | "add_lead_note" | "convert_to_customer" | "update_lead_details" | "add_outlook_email" | "add_lead_task" | "complete_lead_task";
      listId?: string;
      topic?: string;
      contactSelections?: unknown;
      leadId?: string;
      leadIds?: string[];
      note?: string;
      noteId?: string;
      taskId?: string;
      task?: {
        title?: string;
        topic?: string;
        dueAt?: string;
        assignee?: "user" | "gloria";
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

    if (action === "delete_lead" || action === "delete_leads") {
      const leadIds = action === "delete_leads"
        ? (payload.leadIds || []).map((id) => String(id || "").trim()).filter(Boolean)
        : [leadId];
      if (leadIds.length === 0) {
        return NextResponse.json({ error: "leadId(s) ist/sind erforderlich." }, { status: 400 });
      }
      const result = await deleteLeads(leadIds, sessionUser.id);
      return NextResponse.json({ ok: true, action, removed: result.removed });
    }

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

    if (action === "add_lead_note") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const text = String(payload.note || "").trim();
      if (!text) {
        return NextResponse.json({ error: "Notiztext ist erforderlich." }, { status: 400 });
      }
      if (payload.noteId !== undefined && (typeof payload.noteId !== "string" || payload.noteId.length > 200)) {
        return NextResponse.json({ error: "Notizkennung ist ungültig." }, { status: 400 });
      }
      const updatedLead = await addLeadNote(leadId, text, sessionUser.id, payload.noteId);
      if (!updatedLead) {
        return NextResponse.json({ error: "Lead nicht gefunden." }, { status: 404 });
      }
      if (updatedLead.callSource === "crm" && updatedLead.crmCompanyId) {
        const note = payload.noteId
          ? updatedLead.notes?.find((entry) => entry.id === payload.noteId)
          : updatedLead.notes?.[0];
        if (!note) {
          return NextResponse.json({ error: "Notiz wurde gespeichert, aber die CRM-Übertragung konnte nicht vorbereitet werden." }, { status: 500 });
        }
        try {
          await syncCrmCompanyEvent(sessionUser.id, {
            eventId: `gloria-note-${note.id}`,
            companyId: updatedLead.crmCompanyId,
            note: { text: note.text },
          });
        } catch (error) {
          console.error("Gloria-Notiz konnte nicht an die Firmendatenbank übertragen werden:", error);
          return NextResponse.json({
            error: `Notiz wurde in Gloria gespeichert, aber nicht an die Firmendatenbank übertragen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`,
          }, { status: 502 });
        }
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "convert_to_customer") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      if (payload.updates?.customerKind !== "privat" && payload.updates?.customerKind !== "firma") {
        return NextResponse.json({ error: "Bitte Privat- oder Firmenkunde auswählen." }, { status: 400 });
      }
      const updates = {
        ...payload.updates,
        lifecycle: "customer" as const,
      };
      if (sessionUser.role !== "master") {
        delete updates.customerOwner;
      }
      const updatedLead = await updateLeadDetails(leadId, updates, sessionUser.id);
      if (!updatedLead) {
        return NextResponse.json({ error: "Interessent nicht gefunden." }, { status: 404 });
      }
      return NextResponse.json({ ok: true, action, lead: updatedLead });
    }

    if (action === "update_lead_details") {
      if (!leadId) {
        return NextResponse.json({ error: "leadId ist erforderlich." }, { status: 400 });
      }
      const updates = { ...(payload.updates || {}) };
      if (updates.status !== undefined && !["neu", "angerufen", "termin", "absage", "wiedervorlage"].includes(updates.status)) {
        return NextResponse.json({ error: "Ungültiger Kontaktstatus." }, { status: 400 });
      }
      if (updates.nextCallAt && !Number.isFinite(Date.parse(updates.nextCallAt))) {
        return NextResponse.json({ error: "Ungültiger Wiedervorlagezeitpunkt." }, { status: 400 });
      }
      if (sessionUser.role !== "master") {
        // Normal users cannot change owner assignment or core pipeline metrics.
        delete updates.customerOwner;
        delete updates.crmPipeline;
      }
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
      const topic = String(payload.task?.topic || "").trim();
      const assignee = payload.task?.assignee === "gloria" ? "gloria" : "user";
      const dueAt = String(payload.task?.dueAt || "").trim() || undefined;
      if (!title) {
        return NextResponse.json({ error: "Aufgabentitel ist erforderlich." }, { status: 400 });
      }
      if (!topic) {
        return NextResponse.json({ error: "Thema für Gloria ist erforderlich." }, { status: 400 });
      }
      if (assignee === "gloria" && (!dueAt || !Number.isFinite(Date.parse(dueAt)))) {
        return NextResponse.json({ error: "Für automatische Gloria-Anrufe ist ein gültiger Fälligkeitszeitpunkt erforderlich." }, { status: 400 });
      }
      const updatedLead = await addLeadTask(
        leadId,
        {
          title,
          topic,
          dueAt,
          assignee,
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

    if (action === "delete_firm_list") {
      const firmLists = await getFirmListsSummary(sessionUser.id);
      if (!firmLists.some((entry) => entry.listId === listId)) {
        return NextResponse.json({ error: "Firmenliste nicht gefunden." }, { status: 404 });
      }
      const linkedCampaigns = await getCampaignListsSummary(sessionUser.id);
      if (linkedCampaigns.some((entry) => entry.sourceListId === listId && (entry.active || entry.currentlyDialing))) {
        return NextResponse.json(
          { error: "Bitte stoppen Sie zuerst alle Kampagnenläufe dieser Firmenliste und warten Sie, bis laufende Anrufe beendet sind." },
          { status: 409 },
        );
      }
      const result = await deleteFirmList(listId, sessionUser.id);
      const [lists, nextFirmLists] = await Promise.all([
        getCampaignListsSummary(sessionUser.id),
        getFirmListsSummary(sessionUser.id),
      ]);
      return NextResponse.json({ ok: true, action, listId, removedLeads: result.removedLeads, lists, firmLists: nextFirmLists });
    }

    if (action === "start") {
      const selectedTopic = String(payload.topic || "").trim();
      if (listId.startsWith("crm-search-") && !selectedTopic) {
        return NextResponse.json({ error: "Bitte vor dem Start eine Kampagne auswählen." }, { status: 400 });
      }
      let campaignListId = listId;
      if (selectedTopic) {
        const dashboard = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
        const allowedTopics = new Set([
          ...TOPICS,
          ...dashboard.topicPolicies.map((policy) => policy.topic),
        ]);
        if (!allowedTopics.has(selectedTopic)) {
          return NextResponse.json({ error: "Die ausgewählte Kampagne ist nicht verfügbar." }, { status: 400 });
        }
      }
      if (listId.startsWith("crm-search-")) {
        const contactSelections: CampaignContactSelection[] = [];
        if (payload.contactSelections !== undefined) {
          if (!Array.isArray(payload.contactSelections)) {
            return NextResponse.json({ error: "Ungültige Ansprechpartnerauswahl." }, { status: 400 });
          }
          for (const selection of payload.contactSelections) {
            if (!selection || typeof selection !== "object"
              || typeof selection.leadId !== "string"
              || !Array.isArray(selection.contactNames)
              || selection.contactNames.some((name: unknown) => typeof name !== "string")) {
              return NextResponse.json({ error: "Ungültige Ansprechpartnerauswahl." }, { status: 400 });
            }
            contactSelections.push({ leadId: selection.leadId, contactNames: selection.contactNames });
          }
        }
        const run = await createCampaignRunFromFirmList(listId, selectedTopic, sessionUser.id, contactSelections);
        campaignListId = run.listId;
      }
      await setCampaignListActive(campaignListId, true, sessionUser.id);
      const [lists, firmLists] = await Promise.all([
        getCampaignListsSummary(sessionUser.id),
        getFirmListsSummary(sessionUser.id),
      ]);
      return NextResponse.json({ ok: true, action, listId: campaignListId, sourceListId: listId, lists, firmLists });
    }

    if (action === "stop") {
      await setCampaignListActive(listId, false, sessionUser.id);
      const [lists, firmLists] = await Promise.all([
        getCampaignListsSummary(sessionUser.id),
        getFirmListsSummary(sessionUser.id),
      ]);
      return NextResponse.json({ ok: true, action, listId, lists, firmLists });
    }

    if (action === "delete") {
      const lists = await getCampaignListsSummary(sessionUser.id);
      const campaign = lists.find((entry) => entry.listId === listId);
      if (!campaign) {
        return NextResponse.json({ error: "Kampagne nicht gefunden." }, { status: 404 });
      }
      if (campaign.active || campaign.currentlyDialing) {
        return NextResponse.json(
          { error: "Bitte stoppen Sie die Kampagne und warten Sie, bis der laufende Anruf beendet ist." },
          { status: 409 },
        );
      }
      const result = await deleteCampaignList(listId, sessionUser.id);
      const remainingLists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({ ok: true, action, listId, removedLeads: result.removedLeads, lists: remainingLists });
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

    if (!isWithinCampaignHours()) {
      return NextResponse.json({
        ok: true,
        action,
        listId,
        skipped: true,
        reason: "outside_business_hours",
        schedule: describeCampaignSchedule(),
      });
    }

    const lockToken = `campaign-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const lockAcquired = await acquireCampaignCallLock({
      userId: sessionUser.id,
      leadId: listId,
      lockToken,
      ttlMs: 24 * 60 * 60 * 1000,
    });
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
      await releaseCampaignCallLockByToken(lockToken);
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
      const queued = await queueOutboundCall({
        payload: {
          to,
          company: lead.company,
          contactName: lead.contactName,
          leadNote: buildLeadCallContext(lead),
          topic: lead.topic,
          leadId: lead.id,
          userId: lead.userId || sessionUser.id,
          ownerRealName: sessionUser.realName,
          ownerCompanyName: sessionUser.companyName,
          ownerGesellschaft: sessionUser.gesellschaft,
        },
        request,
        campaignLockToken: lockToken,
        reservedCampaignLead: true,
        report: {
          leadId: lead.id,
          company: lead.company,
          contactName: lead.contactName,
          topic: lead.topic,
          summary: `Kampagnenanruf gestartet (${new Date().toISOString()}).`,
          outcome: "Nicht erreicht / kein Kontakt",
          attempts: lead.attempts,
          userId: sessionUser.id,
        },
      });

      const lists = await getCampaignListsSummary(sessionUser.id);
      return NextResponse.json({
        ok: queued.status !== "failed",
        action,
        listId,
        queued: queued.status === "queued" || queued.status === "starting",
        dialed: queued.status === "active" || queued.status === "completed",
        queueStatus: queued.status,
        queueId: queued.queueId,
        position: queued.position,
        ...(queued.error ? { error: queued.error } : {}),
        call: {
          to,
          company: lead.company,
        },
        lists,
      }, { status: queued.status === "failed" ? 502 : 200 });
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
      { status: error instanceof CampaignContactSelectionError ? 400 : 500 },
    );
  }
}
