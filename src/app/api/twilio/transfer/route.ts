import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * Internal endpoint called by the Render worker when Gloria decides to transfer
 * a live call to Jutta Brost. It uses the Twilio REST API to immediately redirect
 * the active call to a <Dial> TwiML verb.
 *
 * Auth: Bearer APP_INTERNAL_TOKEN
 */
export async function POST(request: Request) {
  // Validate internal token
  const authHeader = request.headers.get("authorization") || "";
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!token || authHeader !== `Bearer ${token}`) {
    log.warn("twilio.transfer.unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let callSid: string;
  try {
    const body = (await request.json()) as { callSid?: string };
    callSid = String(body.callSid || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!callSid) {
    return NextResponse.json({ error: "callSid required" }, { status: 400 });
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const transferPhone = process.env.TRANSFER_PHONE?.trim() || "+491715358989";

  if (!accountSid || !authToken) {
    log.error("twilio.transfer.missing_credentials", { callSid });
    return NextResponse.json({ error: "Twilio credentials not configured" }, { status: 500 });
  }

  // Build TwiML that dials Jutta Brost with a 30s timeout and a fallback Say.
  // <Dial> with action attribute: if the dial fails or the callee doesn't answer,
  // Twilio executes the action URL — but since we run on edge we keep it simple
  // and use callbackUrl-less Dial (Twilio hangs up if not answered).
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="30" callerId="${escapeXml(process.env.TWILIO_PHONE_NUMBER?.trim() || "")}">${escapeXml(transferPhone)}</Dial><Say voice="alice" language="de-DE">Die Verbindung konnte leider nicht hergestellt werden. Jutta Brost meldet sich kurzfristig bei Ihnen. Auf Wiederhören.</Say></Response>`;

  try {
    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`;
    const formBody = new URLSearchParams();
    formBody.set("Twiml", twiml);

    const resp = await fetch(twilioUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
      },
      body: formBody.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      log.error("twilio.transfer.api_error", { callSid, status: resp.status, body: text });
      return NextResponse.json({ error: "Twilio API error", details: text }, { status: 502 });
    }

    log.info("twilio.transfer.success", { callSid, to: transferPhone });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("twilio.transfer.fetch_failed", {
      callSid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Network error" }, { status: 500 });
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
