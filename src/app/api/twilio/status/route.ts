import { NextResponse } from "next/server";
import { TOPICS } from "@/lib/types";
import type { Topic } from "@/lib/types";
import { validateTwilioRequest } from "@/lib/twilio-signature";
import { log } from "@/lib/log";

export const runtime = "edge";

function normalizeTopic(value?: string | null): Topic {
  const found = TOPICS.find((topic) => topic === value);
  return found || TOPICS[0];
}

function recordingUrlWithFormat(value: string) {
  if (!value) {
    return "";
  }

  return value.endsWith(".mp3") || value.endsWith(".wav") ? value : `${value}.mp3`;
}

export async function POST(request: Request) {
  const signature = await validateTwilioRequest(request);
  if (!signature.ok) {
    log.warn("twilio.signature_rejected", { event: "status", reason: signature.reason });
    return NextResponse.json({ error: "invalid twilio signature" }, { status: 403 });
  }

  const url = new URL(request.url);
  const form = signature.form ?? (await request.formData());
  const isTestCall = url.searchParams.get("testCall") === "1";
  const callSid = String(form.get("CallSid") || "").trim();
  const callStatus = String(form.get("CallStatus") || form.get("RecordingStatus") || "").trim();
  const recordingUrl = recordingUrlWithFormat(String(form.get("RecordingUrl") || "").trim());
  const userId = url.searchParams.get("userId") || undefined;
  const phoneNumberId = url.searchParams.get("phoneNumberId") || undefined;
  const company = url.searchParams.get("company") || "Testanruf";
  const contactName = url.searchParams.get("contactName") || undefined;
  const leadId = url.searchParams.get("leadId") || undefined;
  const topic = normalizeTopic(url.searchParams.get("topic"));
  const baseUrl = `${url.protocol}//${url.host}`;

  if (callSid && (callStatus === "completed" || Boolean(recordingUrl))) {
    try {
      await fetch(`${baseUrl}/api/calls/webhook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          phoneNumberId,
          callSid,
          leadId,
          company,
          contactName,
          topic,
          summary: undefined,
          recordingConsent: recordingUrl ? true : undefined,
          recordingUrl: recordingUrl || undefined,
          attempts: 1,
        }),
        cache: "no-store",
      });
    } catch (error) {
      console.error("Twilio status report could not be saved", error);
    }
  }

  return NextResponse.json({
    ok: true,
    testCall: isTestCall,
    callSid,
    callStatus,
    recordingUrl,
  });
}
