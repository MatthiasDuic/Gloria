import { NextResponse } from "next/server";
import { findUserById, findUserByUsername } from "@/lib/report-db";
import {
  setCampaignListActive,
  upsertAdsCrmLeads,
  storeCallReport,
  type AdsCrmLeadInput,
} from "@/lib/storage";
import { createTwilioCall, isTwilioConfigured } from "@/lib/twilio";

export const runtime = "nodejs";

type AdsIntegrationPayload = {
  userId?: string;
  username?: string;
  listId?: string;
  listName?: string;
  mode?: "enqueue" | "start" | "call_now";
  openList?: boolean;
  activateList?: boolean;
  triggerCalls?: boolean;
  savedSearch?: {
    id?: string;
    name?: string;
    query?: string;
  };
  companies?: Array<{
    externalId?: string;
    firma?: string;
    company?: string;
    ansprechpartner?: string;
    contactName?: string;
    telefon?: string;
    phone?: string;
    durchwahl?: string;
    directDial?: string;
    email?: string;
    thema?: string;
    topic?: string;
    notiz?: string;
    note?: string;
    website?: string;
    branche?: string;
    ort?: string;
    mitarbeiterzahl?: number | string;
    triggerNow?: boolean;
  }>;
  leads?: Array<AdsCrmLeadInput & { triggerNow?: boolean }>;
};

function composeAdsNote(parts: Array<string | undefined>): string | undefined {
  const merged = parts.map((entry) => (entry || "").trim()).filter(Boolean).join("\n").trim();
  return merged || undefined;
}

function mapCompanySelectionToLeadInput(payload: AdsIntegrationPayload): Array<AdsCrmLeadInput & { triggerNow?: boolean }> {
  if (Array.isArray(payload.leads) && payload.leads.length > 0) {
    return payload.leads;
  }

  if (!Array.isArray(payload.companies)) {
    return [];
  }

  const searchNote = payload.savedSearch
    ? composeAdsNote([
        payload.savedSearch.id ? `ADS Search ID: ${payload.savedSearch.id}` : undefined,
        payload.savedSearch.name ? `ADS Search Name: ${payload.savedSearch.name}` : undefined,
        payload.savedSearch.query ? `ADS Search Query: ${payload.savedSearch.query}` : undefined,
      ])
    : undefined;

  return payload.companies.map((company) => {
    const employeeCountRaw = typeof company.mitarbeiterzahl === "number"
      ? String(company.mitarbeiterzahl)
      : (company.mitarbeiterzahl || "").trim();

    const contextNote = composeAdsNote([
      company.website ? `Website: ${company.website}` : undefined,
      company.branche ? `Branche: ${company.branche}` : undefined,
      company.ort ? `Ort: ${company.ort}` : undefined,
      employeeCountRaw ? `Mitarbeiterzahl: ${employeeCountRaw}` : undefined,
      (company.notiz || company.note || "").trim() || undefined,
      searchNote,
    ]);

    return {
      externalId: (company.externalId || "").trim() || undefined,
      company: (company.company || company.firma || "").trim(),
      contactName: (company.contactName || company.ansprechpartner || "").trim() || undefined,
      phone: (company.phone || company.telefon || "").trim() || undefined,
      directDial: (company.directDial || company.durchwahl || "").trim() || undefined,
      email: (company.email || "").trim() || undefined,
      topic: (company.topic || company.thema || "").trim() || undefined,
      note: contextNote,
      triggerNow: Boolean(company.triggerNow),
    };
  });
}

function resolveListMetadata(payload: AdsIntegrationPayload) {
  const now = new Date();
  const savedSearchId = (payload.savedSearch?.id || "").trim();
  const savedSearchName = (payload.savedSearch?.name || "").trim();
  const explicitListId = (payload.listId || "").trim();
  const explicitListName = (payload.listName || "").trim();

  const listId =
    explicitListId ||
    (savedSearchId ? `ads-search-${savedSearchId}` : `ads-selection-${now.getTime()}`);

  const listName =
    explicitListName ||
    (savedSearchName ? `ADS: ${savedSearchName}` : `ADS Auswahl ${now.toLocaleString("de-DE")}`);

  return { listId, listName };
}

function isAuthorized(request: Request): boolean {
  const expectedKey = process.env.ADS_CRM_API_KEY?.trim();
  if (!expectedKey) {
    return false;
  }

  const bearer = (request.headers.get("authorization") || "").trim();
  if (bearer.toLowerCase().startsWith("bearer ")) {
    const token = bearer.slice(7).trim();
    if (token && token === expectedKey) {
      return true;
    }
  }

  const apiKey = (request.headers.get("x-ads-api-key") || "").trim();
  return apiKey === expectedKey;
}

async function resolveUser(payload: AdsIntegrationPayload) {
  const requestedUserId = (payload.userId || "").trim();
  const requestedUsername = (payload.username || "").trim();
  const envDefaultUserId = (process.env.ADS_CRM_DEFAULT_USER_ID || "").trim();
  const envDefaultUsername = (process.env.ADS_CRM_DEFAULT_USERNAME || "").trim();

  if (requestedUserId) {
    const user = await findUserById(requestedUserId);
    if (!user) {
      throw new Error("USER_NOT_FOUND_BY_ID");
    }
    return user;
  }

  if (requestedUsername) {
    const user = await findUserByUsername(requestedUsername);
    if (!user) {
      throw new Error("USER_NOT_FOUND_BY_USERNAME");
    }
    return user;
  }

  if (envDefaultUserId) {
    const user = await findUserById(envDefaultUserId);
    if (!user) {
      throw new Error("DEFAULT_USER_NOT_FOUND_BY_ID");
    }
    return user;
  }

  if (envDefaultUsername) {
    const user = await findUserByUsername(envDefaultUsername);
    if (!user) {
      throw new Error("DEFAULT_USER_NOT_FOUND_BY_USERNAME");
    }
    return user;
  }

  return null;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    integration: "ads-crm",
    endpoints: {
      upsertLeads: "POST /api/integrations/ads/leads",
    },
    requiredHeaders: ["Authorization: Bearer <ADS_CRM_API_KEY>"],
    optionalHeaders: ["x-ads-api-key: <ADS_CRM_API_KEY>"],
    payloadShape: {
      userId: "optional string",
      username: "optional string",
      listId: "optional string",
      listName: "optional string",
      mode: "optional enum: enqueue | start | call_now",
      activateList: "optional boolean",
      openList: "optional boolean",
      triggerCalls: "optional boolean",
      savedSearch: {
        id: "optional string",
        name: "optional string",
        query: "optional string",
      },
      companies: [
        {
          externalId: "optional string",
          firma: "optional string",
          company: "optional string",
          ansprechpartner: "optional string",
          telefon: "optional string",
          durchwahl: "optional string",
          email: "optional string",
          thema: "optional string",
          notiz: "optional string",
          branche: "optional string",
          ort: "optional string",
          website: "optional string",
          mitarbeiterzahl: "optional number|string",
          triggerNow: "optional boolean",
        },
      ],
      leads: [
        {
          externalId: "optional string",
          company: "required string",
          contactName: "optional string",
          phone: "optional string",
          directDial: "optional string",
          email: "optional string",
          topic: "optional string",
          note: "optional string",
          nextCallAt: "optional ISO timestamp",
          triggerNow: "optional boolean",
        },
      ],
    },
  });
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => ({}))) as AdsIntegrationPayload;
  const inputLeads = mapCompanySelectionToLeadInput(payload);
  const mode = payload.mode || "enqueue";
  const listMeta = resolveListMetadata(payload);

  if (inputLeads.length === 0) {
    return NextResponse.json({ error: "Keine Firmen uebergeben (leads/companies leer)." }, { status: 400 });
  }

  let resolvedUser: Awaited<ReturnType<typeof resolveUser>>;
  try {
    resolvedUser = await resolveUser(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "USER_RESOLUTION_FAILED";
    return NextResponse.json({ error: `Benutzerauflösung fehlgeschlagen (${message}).` }, { status: 400 });
  }

  const upsertResult = await upsertAdsCrmLeads(inputLeads, {
    userId: resolvedUser?.id,
    listId: listMeta.listId,
    listName: listMeta.listName,
  });

  const callResults: Array<{
    leadId: string;
    company: string;
    started: boolean;
    callSid?: string;
    reason?: string;
  }> = [];

  const shouldAttemptCalls =
    mode === "call_now" ||
    Boolean(payload.triggerCalls) ||
    inputLeads.some((lead) => lead.triggerNow);

  const shouldActivateList =
    mode === "start" ||
    mode === "call_now" ||
    Boolean(payload.activateList) ||
    Boolean(payload.openList);

  if (shouldActivateList) {
    await setCampaignListActive(listMeta.listId, true, resolvedUser?.id);
  }

  if (shouldAttemptCalls && !isTwilioConfigured()) {
    return NextResponse.json({
      ok: true,
      warning: "Leads wurden gespeichert, aber Twilio ist nicht konfiguriert.",
      created: upsertResult.created,
      updated: upsertResult.updated,
      total: upsertResult.total,
      mode,
      listId: listMeta.listId,
      listName: listMeta.listName,
      callResults: [],
      user: resolvedUser
        ? { id: resolvedUser.id, username: resolvedUser.username }
        : null,
    });
  }

  if (shouldAttemptCalls) {
    for (const lead of upsertResult.leads) {
      const original = inputLeads.find((entry) => {
        const tagged = (lead.note || "").includes(`[ADS_ID:${(entry.externalId || "").trim()}]`);
        return tagged || (entry.company || "").trim().toLowerCase() === lead.company.trim().toLowerCase();
      });

      const triggerNow = Boolean(payload.triggerCalls) || Boolean(original?.triggerNow);
      if (!triggerNow) {
        continue;
      }

      const to = (lead.directDial || lead.phone || "").trim();
      if (!to) {
        callResults.push({
          leadId: lead.id,
          company: lead.company,
          started: false,
          reason: "missing_phone",
        });
        continue;
      }

      try {
        const call = await createTwilioCall(
          {
            to,
            company: lead.company,
            contactName: lead.contactName,
            crmContext: lead.note,
            topic: lead.topic,
            leadId: lead.id,
            userId: resolvedUser?.id,
            ownerRealName: resolvedUser?.realName,
            ownerCompanyName: resolvedUser?.companyName,
            ownerGesellschaft: resolvedUser?.gesellschaft,
          },
          request,
        );

        await storeCallReport({
          userId: resolvedUser?.id,
          callSid: call.sid,
          leadId: lead.id,
          company: lead.company,
          contactName: lead.contactName,
          topic: lead.topic,
          summary: `ADS-CRM Anruf gestartet (${new Date().toISOString()}).`,
          outcome: "Kein Kontakt",
          attempts: Math.max(1, lead.attempts),
        });

        callResults.push({
          leadId: lead.id,
          company: lead.company,
          started: true,
          callSid: call.sid,
        });
      } catch (error) {
        callResults.push({
          leadId: lead.id,
          company: lead.company,
          started: false,
          reason: error instanceof Error ? error.message : "call_start_failed",
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    created: upsertResult.created,
    updated: upsertResult.updated,
    total: upsertResult.total,
    mode,
    listId: listMeta.listId,
    listName: listMeta.listName,
    callResults,
    user: resolvedUser
      ? { id: resolvedUser.id, username: resolvedUser.username }
      : null,
  });
}
