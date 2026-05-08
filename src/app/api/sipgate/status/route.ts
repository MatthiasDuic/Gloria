/**
 * sipgate status webhook.
 *
 * sipgate.io sendet Call-Events an diese URL (outgoingUrl in sipgate.io Settings).
 *
 * Relevante Events:
 *   - event=hangup   → Gespräch beendet, offene Reports finalisieren
 *   - event=answer   → Gespräch angenommen (kann für Latenz-Logging genutzt werden)
 *   - event=newCall  → eingehender Anruf (→ wird auch an incomingUrl gesendet)
 *
 * sipgate schickt form-encoded POST mit:
 *   event, callId, from, to, direction, cause (bei hangup: normalClearing | cancel | busy | ...)
 */

import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "edge";
export const dynamic = "force-dynamic";

function verifyWebhookSecret(request: Request): boolean {
  const expected = process.env.SIPGATE_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret") || "";
  return provided === expected;
}

async function parseSipgateForm(request: Request): Promise<Record<string, string>> {
  try {
    const form = await request.clone().formData();
    const result: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      result[key] = String(value);
    }
    return result;
  } catch {
    return {};
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyWebhookSecret(request)) {
    log.warn("sipgate.status.secret_mismatch");
    return new NextResponse("", { status: 200 }); // sipgate expects 200
  }

  const form = await parseSipgateForm(request);
  const event = form.event || "unknown";
  const callId = form.callId || form.xmlCallId || "";
  const cause = form.cause || "";
  const from = form.from || "";
  const to = form.to || "";
  const direction = form.direction || "";

  log.info("sipgate.status", { event, callId, cause, from, to, direction });

  // sipgate.io requires an empty 200 response for status events.
  // Any non-200 response causes sipgate to retry.
  return new NextResponse("", {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function GET(): Promise<NextResponse> {
  return new NextResponse("sipgate status endpoint ok", { status: 200 });
}
