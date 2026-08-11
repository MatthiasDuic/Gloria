import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { listPhoneNumbersByUser } from "@/lib/report-db";

export const runtime = "nodejs";

type FromOption = { number: string; label: string; id?: string };
const BLOCKED_OUTBOUND_NUMBERS = new Set(["+18446290030"]);

function normalizePhoneNumber(value?: string): string {
  return String(value || "").replace(/[\s()-]/g, "").trim();
}

function isBlockedOutboundNumber(value?: string): boolean {
  const normalized = normalizePhoneNumber(value);
  if (!normalized) return false;
  for (const blocked of BLOCKED_OUTBOUND_NUMBERS) {
    if (normalizePhoneNumber(blocked) === normalized) {
      return true;
    }
  }
  return false;
}

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const dbNumbers = await listPhoneNumbersByUser(sessionUser.id).catch(() => []);
  const fromOptions: FromOption[] = dbNumbers
    .filter((row) => row.active)
    .filter((row) => !isBlockedOutboundNumber(row.phoneNumber))
    .map((row) => ({
      number: row.phoneNumber,
      label: row.label,
      id: row.id,
    }));

  return NextResponse.json(
    {
      fromOptions,
      defaultFrom: fromOptions[0]?.number || "",
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
