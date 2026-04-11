import { NextResponse } from "next/server";
import { importLeadsFromCsv } from "@/lib/storage";

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as { csvText?: string };

  if (!payload.csvText?.trim()) {
    return NextResponse.json(
      { error: "Bitte CSV-Inhalt mitsenden." },
      { status: 400 },
    );
  }

  const result = await importLeadsFromCsv(payload.csvText);
  return NextResponse.json(result);
}
