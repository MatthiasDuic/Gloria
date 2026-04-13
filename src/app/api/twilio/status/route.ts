import { NextResponse } from "next/server";
import { sendReportEmail } from "@/lib/mailer";
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

  if (callSid && (callStatus === "completed" || Boolean(recordingUrl))) {
    try {
      const report = await storeCallReport({
        callSid,
        leadId,
        company,
        contactName,
        topic,
        // Don't overwrite the conversation summary set by the voice processor.
        // Only set a minimal note if recordingUrl arrived without a prior voice summary.
        summary: undefined,
        recordingConsent: recordingUrl ? true : undefined,
        recordingUrl: recordingUrl || undefined,
        attempts: 1,
      });

      if (recordingUrl) {
        await sendReportEmail(report).catch(() => undefined);
      }
    } catch (error) {
      console.error("Twilio status report could not be saved", error);

      if (recordingUrl) {
        await sendReportEmail({
          id: `status-${Date.now()}`,
          callSid,
          leadId,
          company,
          contactName,
          topic,
          summary: "Aufnahme gespeichert.",
          outcome: "Kein Kontakt",
          conversationDate: new Date().toISOString(),
          attempts: 1,
          recordingConsent: true,
          recordingUrl,
          emailedTo:
            process.env.REPORT_TO_EMAIL || "Matthias.duic@agentur-duic-sprockhoevel.de",
        }).catch(() => undefined);
      }
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
