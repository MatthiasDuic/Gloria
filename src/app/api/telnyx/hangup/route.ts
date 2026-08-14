import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "nodejs";

function getApiBaseUrl(): string {
  return (process.env.TELNYX_API_BASE_URL?.trim() || "https://api.telnyx.com/v2").replace(/\/$/, "");
}

export async function POST(request: Request) {
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { callControlId?: string };
  const callControlId = String(body.callControlId || "").trim();
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!callControlId || !apiKey) {
    return NextResponse.json({ error: "Telnyx hangup is not configured" }, { status: 400 });
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      const details = await response.text().catch(() => "");
      log.error("telnyx.hangup.api_error", { callControlId, status: response.status, details });
      return NextResponse.json({ error: "Telnyx API error" }, { status: 502 });
    }
    log.info("telnyx.hangup.success", { callControlId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("telnyx.hangup.fetch_failed", {
      callControlId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Network error" }, { status: 500 });
  }
}