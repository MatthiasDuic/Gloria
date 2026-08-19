import { NextResponse } from "next/server";
import {
  isCampaignListActive,
  listActiveCampaignLists,
  pullNextLeadForCampaignList,
  setCampaignListActive,
  storeCallReport,
} from "@/lib/storage";
import { createTelnyxCall, isTelnyxConfigured } from "@/lib/telnyx";
import {
  describeCampaignSchedule,
  isWithinCampaignHours,
} from "@/lib/campaign-schedule";
import { acquireCampaignCallLock, bindCampaignCallLock, findUserById, releaseCampaignCallLockByToken } from "@/lib/report-db";
import { normalizePhoneForDial } from "@/lib/phone-utils";

export const runtime = "nodejs";

// Mindestabstand zwischen zwei Anrufen eines Users (ms). Verhindert, dass der
// Cron parallel dialt, waehrend der vorherige Call noch laeuft.
const PER_USER_COOLDOWN_MS = 120_000;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

type DialResult =
  | { userId: string; listId: string; dialed: true; sid: string; to: string }
  | { userId: string; listId: string; dialed: false; reason: string };

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isWithinCampaignHours()) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "outside_business_hours",
      schedule: describeCampaignSchedule(),
    });
  }

  if (!isTelnyxConfigured()) {
    return NextResponse.json(
      { error: "Telnyx is not configured." },
      { status: 400 },
    );
  }

  const activeLists = await listActiveCampaignLists();

  if (activeLists.length === 0) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_active_lists" });
  }

  const now = Date.now();
  const perUserRun: Map<string, DialResult> = new Map();
  const results: DialResult[] = [];

  // Gruppiere nach User und waehle pro User genau eine Liste mit offenen Leads.
  const byUser = new Map<string, typeof activeLists>();
  for (const list of activeLists) {
    const key = list.userId || "__global__";
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(list);
  }

  for (const [userKey, lists] of byUser) {
    // Cooldown-Check: wenn irgendeine Liste dieses Users juengst gedialt wurde -> skip
    const recentlyDialed = lists.some((l) => {
      if (!l.lastRunAt) return false;
      const ts = Date.parse(l.lastRunAt);
      return !Number.isNaN(ts) && now - ts < PER_USER_COOLDOWN_MS;
    });

    if (recentlyDialed) {
      results.push({
        userId: userKey,
        listId: lists[0].listId,
        dialed: false,
        reason: "cooldown",
      });
      continue;
    }

    const userId = userKey === "__global__" ? undefined : userKey;
    const lockToken = `campaign-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = userId ? await findUserById(userId) : null;

    // Versuche die Listen in Reihenfolge, bis eine einen Lead liefert.
    let dialed = false;

    for (const list of lists) {
      if (userId) {
        const acquired = await acquireCampaignCallLock({ userId, leadId: list.listId, lockToken });
        if (!acquired) {
          results.push({ userId: userKey, listId: list.listId, dialed: false, reason: "active_call" });
          break;
        }
      }
      const lead = await pullNextLeadForCampaignList(list.listId, userId);

      if (!lead) {
        if (userId) await releaseCampaignCallLockByToken(lockToken);
        // Keine offenen Leads mehr -> Liste deaktivieren (done).
        await setCampaignListActive(list.listId, false, userId);
        continue;
      }

      const rawTo = (lead.directDial || lead.phone || "").trim();
      const to = normalizePhoneForDial(rawTo);
      if (!to) {
        if (userId) await releaseCampaignCallLockByToken(lockToken);
        results.push({
          userId: userKey,
          listId: list.listId,
          dialed: false,
          reason: rawTo ? "invalid_phone_format" : "missing_phone",
        });
        continue;
      }

      // Hard stop guard: if list got stopped while this cron run is still
      // processing, do not start another call for it.
      const stillActive = await isCampaignListActive(list.listId, userId);
      if (!stillActive) {
        if (userId) await releaseCampaignCallLockByToken(lockToken);
        results.push({
          userId: userKey,
          listId: list.listId,
          dialed: false,
          reason: "list_not_active",
        });
        continue;
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
            userId: lead.userId || userId,
            ownerRealName: user?.realName,
            ownerCompanyName: user?.companyName,
            ownerGesellschaft: user?.gesellschaft,
          },
          request,
        );
        if (userId) await bindCampaignCallLock(lockToken, call.sid);

        await storeCallReport({
          callSid: call.sid,
          leadId: lead.id,
          company: lead.company,
          contactName: lead.contactName,
          topic: lead.topic,
          summary: `Automatischer Kampagnenanruf gestartet (${new Date().toISOString()}).`,
          outcome: "Nicht erreicht / kein Kontakt",
          attempts: lead.attempts,
          userId,
        });

        const result: DialResult = {
          userId: userKey,
          listId: list.listId,
          dialed: true,
          sid: call.sid,
          to,
        };
        results.push(result);
        perUserRun.set(userKey, result);
        dialed = true;
        break;
      } catch (error) {
        if (userId) await releaseCampaignCallLockByToken(lockToken);
        results.push({
          userId: userKey,
          listId: list.listId,
          dialed: false,
          reason: error instanceof Error ? error.message : "call_start_failed",
        });
        // Nicht sofort break – probier die naechste Liste dieses Users.
      }
    }

    if (!dialed && !perUserRun.has(userKey)) {
      // Kein Lead konnte fuer diesen User gedialt werden.
      // Ist schon in results protokolliert.
    }
  }

  const triggered = results.filter((r) => r.dialed === true).length;

  return NextResponse.json({
    ok: true,
    schedule: describeCampaignSchedule(),
    activeLists: activeLists.length,
    triggered,
    results,
  });
}
