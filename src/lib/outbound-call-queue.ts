import { randomUUID } from "node:crypto";
import {
  claimOutboundCall,
  enqueueOutboundCall,
  getOutboundCallQueueStatus,
  markOutboundCallActive,
  markOutboundCallFailed,
  releaseCampaignCallLockByToken,
  bindCampaignCallLock,
  type OutboundCallQueueJob,
} from "@/lib/report-db";
import { storeCallReport } from "@/lib/storage";
import { createTelnyxCall, type TelnyxCallRequest } from "@/lib/telnyx";
import { log } from "@/lib/log";

type CallReportPayload = Omit<Parameters<typeof storeCallReport>[0], "callSid">;

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
  try {
    const call = await startQueuedCall(job);
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
  const request = new Request(job.requestUrl);
  return createTelnyxCall(
    { ...(job.payload as unknown as TelnyxCallRequest), queueId: job.id },
    request,
  );
}
