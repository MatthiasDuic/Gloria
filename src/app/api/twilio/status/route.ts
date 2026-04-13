import { NextResponse } from "next/server";
import { storeCallReport } from "@/lib/storage";
import { TOPICS } from "@/lib/types";
import type { Topic } from "@/lib/types";

export const runtime = "nodejs";

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
  const url = new URL(request.url);
  const form = await request.formData();
  const isTestCall = url.searchParams.get("testCall") === "1";
  const callSid = String(form.get("CallSid") || "").trim();
  const callStatus = String(form.get("CallStatus") || form.get("RecordingStatus") || "").trim();
  const recordingUrl = recordingUrlWithFormat(String(form.get("RecordingUrl") || "").trim());
  const company = url.searchParams.get("company") || "Testanruf";
  const contactName = url.searchParams.get("contactName") || undefined;
  const leadId = url.searchParams.get("leadId") || undefined;
  const topic = normalizeTopic(url.searchParams.get("topic"));

  // Persist call metadata for test calls so reports and recordings are visible in the dashboard.
  if (isTestCall && callSid && (callStatus === "completed" || Boolean(recordingUrl))) {
    await storeCallReport({
      callSid,
      leadId,
      company,
      contactName,
      topic,
      summary: recordingUrl
        ? "Twilio-Testanruf abgeschlossen. Aufnahme wurde gespeichert."
        : "Twilio-Testanruf abgeschlossen.",
      outcome: "Kein Kontakt",
      recordingConsent: Boolean(recordingUrl),
      recordingUrl: recordingUrl || undefined,
      attempts: 1,
    });
  }

  return NextResponse.json({
    ok: true,
    testCall: isTestCall,
    callSid,
    callStatus,
    recordingUrl,
  });
}
