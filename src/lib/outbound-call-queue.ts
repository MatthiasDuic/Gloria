import { randomUUID } from "node:crypto";
import {
  claimOutboundCall,
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
import { createTelnyxCall, type TelnyxCallRequest } from "@/lib/telnyx";
import { log } from "@/lib/log";
import { CampaignOutsideHoursError, isWithinCampaignHours } from "@/lib/campaign-schedule";

type CallReportPayload = Omit<Parameters<typeof storeCallReport>[0], "callSid">;

class CampaignStoppedError extends Error {}

export async function queueOutboundCall(params: {
  payload: TelnyxCallRequest;
  report: CallReportPayload;
  request: Request;
  campaignLockToken?: string;
}): Promise<{
  queueId: string;
  status: OutboundCallQueueJob["status"];
  callSid?: string;
  error?: string;
  position: number;
}> {
  const queueId = randomUUID();
  await enqueueOutboundCall({
    id: queueId,
    userId: params.payload.userId,
    payload: params.payload as unknown as Record<string, unknown>,
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
