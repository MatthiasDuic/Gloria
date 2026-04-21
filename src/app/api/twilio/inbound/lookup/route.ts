import { NextResponse } from "next/server";
import { findLeadForInboundCallbackByPhone } from "@/lib/storage";

export const runtime = "nodejs";

function isInternalAuthorized(request: Request): boolean {
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();

  if (!username || !password) {
    return false;
  }

  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) {
    return false;
  }

  try {
    const decoded = atob(auth.slice(6));
    return decoded === `${username}:${password}`;
  } catch {
    return false;
  }
}

function isInternalTokenAuthorized(request: Request): boolean {
  const token = request.headers.get("x-gloria-internal-token")?.trim();
  const expected = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (!token || !expected) {
    return false;
  }

  return token === expected;
}

export async function GET(request: Request) {
  if (!isInternalAuthorized(request) && !isInternalTokenAuthorized(request)) {
    return NextResponse.json({ error: "Nicht autorisiert." }, { status: 401 });
  }

  const url = new URL(request.url);
  const from = String(url.searchParams.get("from") || "").trim();

  if (!from) {
    return NextResponse.json({ error: "from fehlt." }, { status: 400 });
  }

  const lead = await findLeadForInboundCallbackByPhone(from);

  if (!lead) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    lead: {
      id: lead.id,
      company: lead.company,
      contactName: lead.contactName,
      topic: lead.topic,
      directDial: lead.directDial,
      phone: lead.phone,
    },
  });
}
