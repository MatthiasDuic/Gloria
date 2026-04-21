import { NextResponse } from "next/server";
import { getTwilioCallerIdOptions } from "@/lib/twilio";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { listPhoneNumbersByUser } from "@/lib/report-db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const dbNumbers = await listPhoneNumbersByUser(sessionUser.id).catch(() => []);
  const fromOptions = dbNumbers.length > 0
    ? dbNumbers.filter((entry) => entry.active).map((entry) => ({
        number: entry.phoneNumber,
        label: entry.label,
        id: entry.id,
      }))
    : getTwilioCallerIdOptions().map((entry) => ({ ...entry, id: undefined }));

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
