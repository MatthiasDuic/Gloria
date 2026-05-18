import { NextResponse } from "next/server";
import { getTelnyxCallerIdOptions } from "@/lib/telnyx";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { listPhoneNumbersByUser } from "@/lib/report-db";

export const runtime = "nodejs";

type FromOption = { number: string; label: string; id?: string };

async function listOwnedTelnyxNumbers(): Promise<FromOption[]> {
  const apiKey = process.env.TELNYX_API_KEY?.trim();
  if (!apiKey) return [];

  const apiBaseUrl = (process.env.TELNYX_API_BASE_URL || "https://api.telnyx.com/v2").trim().replace(/\/$/, "");
  const response = await fetch(`${apiBaseUrl}/phone_numbers?page[size]=100`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    cache: "no-store",
  }).catch(() => null);

  if (!response || !response.ok) {
    return [];
  }

  const payload = (await response.json().catch(() => ({}))) as {
    data?: Array<{
      phone_number?: string;
      record_type?: string;
    }>;
  };

  const rows = Array.isArray(payload.data) ? payload.data : [];
  return rows
    .map((entry) => String(entry.phone_number || "").trim())
    .filter(Boolean)
    .map((number) => ({ number, label: number }));
}

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const [dbNumbers, fallbackOptions, ownedNumbers] = await Promise.all([
    listPhoneNumbersByUser(sessionUser.id).catch(() => []),
    Promise.resolve(getTelnyxCallerIdOptions().map((entry) => ({ ...entry, id: undefined }))),
    listOwnedTelnyxNumbers(),
  ]);

  const merged = new Map<string, FromOption>();

  for (const entry of ownedNumbers) {
    if (!merged.has(entry.number)) merged.set(entry.number, entry);
  }

  for (const entry of fallbackOptions) {
    if (!merged.has(entry.number)) merged.set(entry.number, entry);
  }

  for (const entry of dbNumbers.filter((row) => row.active)) {
    merged.set(entry.phoneNumber, {
      number: entry.phoneNumber,
      label: entry.label,
      id: entry.id,
    });
  }

  const fromOptions = Array.from(merged.values());

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
