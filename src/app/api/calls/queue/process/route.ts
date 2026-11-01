import { NextResponse } from "next/server";
import { processOutboundCallQueue } from "@/lib/outbound-call-queue";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET ist nicht konfiguriert." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processOutboundCallQueue();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    log.error("outbound_call_queue.process_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Warteschlange konnte nicht abgearbeitet werden." }, { status: 500 });
  }
}
