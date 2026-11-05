import { randomUUID } from "node:crypto";
import {
  claimOutboundCall,
  completeOutboundCall,
  getDatabasePool,
  deferOutboundCall,
  restoreUnstartedCampaignLead,
  enqueueOutboundCall,
  getOutboundCallQueueStatus,
  markOutboundCallActive,
  markOutboundCallFailed,
  releaseCampaignCallLockByToken,
  bindCampaignCallLock,
  type OutboundCallQueueJob,
} from "@/lib/report-db";
import { getLeadById, isCampaignListActive, storeCallReport } from "@/lib/storage";
import { isPhoneNumberSuppressed } from "@/lib/call-safety";
import { CallOwnerIdentityError, createTelnyxCall, resolveCallOwnerIdentity, type TelnyxCallRequest } from "@/lib/telnyx";
import { log } from "@/lib/log";
import { CampaignOutsideHoursError, isWithinCampaignHours } from "@/lib/campaign-schedule";

type CallReportPayload = Omit<Parameters<typeof storeCallReport>[0], "callSid">;

class CampaignStoppedError extends Error {}

export async function reconcileOutboundCallQueue(): Promise<void> {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!apiKey) return;
  const database = await getDatabasePool();
  const stale = await database.query(`SELECT id,call_sid FROM outbound_call_queue
    WHERE status = 'active' AND call_sid IS NOT NULL AND updated_at < NOW() - INTERVAL '2 minutes'
    ORDER BY updated_at LIMIT 10`);
  const base = process.env.TELNYX_API_BASE_URL?.replace(/\/$/, "") || "https://api.telnyx.com/v2";
  await Promise.all(stale.rows.map(async (call: { id: string; call_sid: string }) => {
    try {
      const response = await fetch(`${base}/calls/${encodeURIComponent(call.call_sid)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(5000), cache: "no-store",
      });
      if (!response.ok) return;
      const body = await response.json();
      if (body.data?.is_alive === false) {
        await completeOutboundCall(call.call_sid, call.id);
        log.warn("outbound_call_queue.recovered_finished_call", { queueId: call.id, callSid: call.call_sid });
      } else if (body.data?.is_alive === true) {
        await database.query("UPDATE outbound_call_queue SET updated_at = NOW() WHERE id = $1 AND status = 'active'", [call.id]);
      }
    } catch (error) {
      log.warn("outbound_call_queue.reconcile_failed", { queueId: call.id, error: String(error) });
    }
  }));
}

export async function queueOutboundCall(params: {
  payload: TelnyxCallRequest;
  report: CallReportPayload;
  request: Request;
  campaignLockToken?: string;
  reservedCampaignLead?: boolean;
}): Promise<{
  queueId: string;
  status: OutboundCallQueueJob["status"];
  callSid?: string;
  error?: string;
  position: number;
}> {
  try {
    await resolveCallOwnerIdentity(params.payload.userId);
  } catch (error) {
    if (params.reservedCampaignLead && params.payload.leadId) {
      await restoreUnstartedCampaignLead(params.payload.leadId, params.payload.userId);
    }
    throw error;
  }
  const queueId = randomUUID();
  await enqueueOutboundCall({
    id: queueId,
    userId: params.payload.userId,
    payload: { ...params.payload, reservedCampaignLead: params.reservedCampaignLead === true },
    reportPayload: params.report as unknown as Record<string, unknown>,
    requestUrl: params.request.url,
    campaignLockToken: params.campaignLockToken,
  });

  await processOutboundCallQueue();
  const queueStatus = await getOutboundCallQueueStatus(queueId);
  if (!queueStatus) {
    throw new Error("Der Warteschlangenstatus des angenommenen Anrufs konnte nicht geladen werden.");
  }
  return {
    queueId,
    ...queueStatus,
  };
}

export async function processOutboundCallQueue(): Promise<{ started: number }> {
  const jobs: OutboundCallQueueJob[] = [];
  while (true) {
    const job = await claimOutboundCall();
    if (!job) break;
    jobs.push(job);
  }
  const started = await Promise.all(jobs.map(startClaimedCall));
  return { started: started.filter(Boolean).length };
}

async function startClaimedCall(job: OutboundCallQueueJob): Promise<boolean> {
  let startedCallSid: string | undefined;
  try {
    const callSource = job.payload.callSource || job.reportPayload.callSource
      || (job.payload.leadId && !job.payload.isTestCall ? "crm" : "manual");
    if ((job.campaignLockToken || callSource === "crm") && !isWithinCampaignHours()) {
      await deferOutboundCall(job.id);
      return false;
    }
    const call = await startQueuedCall(job);
    startedCallSid = call.sid;
    await markOutboundCallActive(job.id, call.sid);
    if (job.campaignLockToken) {
      await bindCampaignCallLock(job.campaignLockToken, call.sid);
    }
    await storeCallReport({
      ...(job.reportPayload as CallReportPayload),
      callSid: call.sid,
    });
    return true;
  } catch (error) {
    if (startedCallSid) {
      log.error("outbound_call_queue.persistence_after_start_failed", { queueId: job.id, callSid: startedCallSid, error: String(error) });
      return true;
    }
    if (error instanceof CampaignOutsideHoursError) {
      await deferOutboundCall(job.id);
      return false;
    }
    if (error instanceof CampaignStoppedError && job.userId && typeof job.payload.leadId === "string") {
      await markOutboundCallFailed(job.id, "campaign_stopped");
      await restoreUnstartedCampaignLead(job.payload.leadId, job.userId);
      if (job.campaignLockToken) await releaseCampaignCallLockByToken(job.campaignLockToken);
      return false;
    }
    const reason = error instanceof Error ? error.message : String(error);
    await markOutboundCallFailed(job.id, reason);
    const reservedCampaignLead = job.payload.reservedCampaignLead === true
      || Boolean(job.campaignLockToken)
      || (job.payload.reservedCampaignLead === undefined && !job.userId
        && job.payload.callSource === undefined && job.reportPayload.callSource === undefined
        && job.payload.isTestCall !== true);
    if (error instanceof CallOwnerIdentityError && reservedCampaignLead
      && typeof job.payload.leadId === "string") {
      await restoreUnstartedCampaignLead(job.payload.leadId, job.userId);
    }
    if (job.campaignLockToken) {
      await releaseCampaignCallLockByToken(job.campaignLockToken);
    }
    log.error("outbound_call_queue.start_failed", {
      queueId: job.id,
      userId: job.userId,
      error: reason,
    });
    return false;
  }
}

async function startQueuedCall(job: OutboundCallQueueJob) {
  if (job.userId && typeof job.payload.to === "string" && await isPhoneNumberSuppressed(job.userId, job.payload.to)) {
    throw new Error("Anrufsperre: Diese Telefonnummer darf nicht mehr angerufen werden.");
  }
  if (job.campaignLockToken && typeof job.payload.leadId === "string") {
    const lead = await getLeadById(job.payload.leadId, job.userId);
    if (!lead || !await isCampaignListActive(lead.listId || "legacy", job.userId)) {
      throw new CampaignStoppedError();
    }
  }
  const request = new Request(job.requestUrl);
  return createTelnyxCall(
    { ...(job.payload as unknown as TelnyxCallRequest), queueId: job.id },
    request,
  );
}
