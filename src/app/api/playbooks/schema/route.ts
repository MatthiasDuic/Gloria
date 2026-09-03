import { NextResponse } from "next/server";
import { PLAYBOOK_JSON_SCHEMA_V1 } from "@/lib/playbook-schema";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  return NextResponse.json({
    version: "1",
    schema: PLAYBOOK_JSON_SCHEMA_V1,
  });
}
