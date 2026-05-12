import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "nodejs";

function getApiBaseUrl(): string {
  const explicit = process.env.TELNYX_API_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }
  return "https://api.telnyx.com/v2";
}

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization") || "";
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!token || authHeader !== `Bearer ${token}`) {
    log.warn("telnyx.transfer.unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let callControlId: string;
  try {
    const body = (await request.json()) as { callControlId?: string };
    callControlId = String(body.callControlId || "").trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!callControlId) {
    return NextResponse.json({ error: "callControlId required" }, { status: 400 });
  }

  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const transferPhone = process.env.TRANSFER_PHONE?.trim() || "+491715358989";
  const from = process.env.TELNYX_PHONE_NUMBER?.trim();

  if (!apiKey) {
    log.error("telnyx.transfer.missing_credentials", { callControlId });
    return NextResponse.json({ error: "Telnyx credentials not configured" }, { status: 500 });
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/calls/${encodeURIComponent(callControlId)}/actions/transfer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        to: transferPhone,
        ...(from ? { from } : {}),
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      log.error("telnyx.transfer.api_error", { callControlId, status: response.status, details });
      return NextResponse.json({ error: "Telnyx API error", details }, { status: 502 });
    }

    log.info("telnyx.transfer.success", { callControlId, to: transferPhone });
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error("telnyx.transfer.fetch_failed", {
      callControlId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Network error" }, { status: 500 });
  }
}
