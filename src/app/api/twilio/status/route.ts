import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();

  return NextResponse.json({
    ok: true,
    callSid: String(form.get("CallSid") || ""),
    callStatus: String(form.get("CallStatus") || ""),
    recordingUrl: String(form.get("RecordingUrl") || ""),
  });
}
