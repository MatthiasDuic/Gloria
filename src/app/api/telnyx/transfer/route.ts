import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { findUserById } from "@/lib/report-db";
import { normalizePhoneForDial } from "@/lib/phone-utils";
import { telnyxCommandId } from "@/lib/telnyx-webhook-auth";

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
  let userId: string;
  try {
    const body = (await request.json()) as { callControlId?: unknown; userId?: unknown };
    callControlId = typeof body.callControlId === "string" ? body.callControlId.trim() : "";
    userId = typeof body.userId === "string" ? body.userId.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!callControlId) {
    return NextResponse.json({ error: "callControlId required" }, { status: 400 });
  }
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const apiKey = process.env.TELNYX_API_KEY?.trim();
  const from = process.env.TELNYX_PHONE_NUMBER?.trim();

  if (!apiKey) {
    log.error("telnyx.transfer.missing_credentials", { callControlId });
    return NextResponse.json({ error: "Telnyx credentials not configured" }, { status: 500 });
  }

  try {
    const user = await findUserById(userId);
    if (!user) {
      log.warn("telnyx.transfer.user_not_found", { callControlId, userId });
      return NextResponse.json({ error: "Benutzer nicht gefunden." }, { status: 404 });
    }
    const transferPhone = normalizePhoneForDial(user.realPhone);
    if (!transferPhone || !/^\+[1-9]\d{7,14}$/.test(transferPhone)) {
      log.warn("telnyx.transfer.missing_user_phone", { callControlId, userId });
      return NextResponse.json({ error: "Keine gültige reale Rufnummer für diesen Benutzer hinterlegt." }, { status: 422 });
    }
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
        command_id: telnyxCommandId(callControlId, "transfer"),
        target_leg_client_state: Buffer.from(JSON.stringify({
          transferLeg: true,
          originalCallControlId: callControlId,
        })).toString("base64"),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      log.error("telnyx.transfer.api_error", { callControlId, status: response.status, details });
      return NextResponse.json({ error: "Telnyx API error", details }, { status: 502 });
    }

    log.info("telnyx.transfer.command_accepted", { callControlId, to: transferPhone });
    return NextResponse.json({ commandAccepted: true });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    log.error("telnyx.transfer.fetch_failed", {
      callControlId,
      timedOut,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: timedOut ? "Telnyx command outcome is unknown" : "Network error" },
      { status: timedOut ? 504 : 500 },
    );
  }
}
