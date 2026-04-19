import { NextRequest, NextResponse } from "next/server";
import { deleteReport, getDashboardData, storeCallReport } from "@/lib/storage";
import { TOPICS, type Topic } from "@/lib/types";

export async function GET() {
  const data = await getDashboardData();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const payload = (await request.json()) as {
    company?: string;
    contactName?: string;
    topic?: string;
    summary?: string;
    appointmentAt?: string;
    recordingConsent?: boolean;
    recordingUrl?: string;
  };

  const company = payload.company?.trim();
  const appointmentAt = payload.appointmentAt?.trim();
  const topic = payload.topic?.trim() as Topic | undefined;

  if (!company) {
    return NextResponse.json({ error: "Firma fehlt." }, { status: 400 });
  }

  if (!appointmentAt || Number.isNaN(Date.parse(appointmentAt))) {
    return NextResponse.json({ error: "Ungültiger Terminzeitpunkt." }, { status: 400 });
  }

  if (!topic || !TOPICS.includes(topic)) {
    return NextResponse.json({ error: "Ungültiges Thema." }, { status: 400 });
  }

  const report = await storeCallReport({
    callSid: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    company,
    contactName: payload.contactName?.trim() || undefined,
    topic,
    summary: payload.summary?.trim() || "Manuell im Dashboard eingetragener Termin.",
    outcome: "Termin",
    appointmentAt: new Date(appointmentAt).toISOString(),
    attempts: 1,
    recordingConsent: Boolean(payload.recordingConsent),
    recordingUrl: payload.recordingUrl?.trim() || undefined,
  });

  return NextResponse.json({ ok: true, report });
}

export async function DELETE(request: NextRequest) {
  const reportId = request.nextUrl.searchParams.get("reportId");

  if (!reportId) {
    return NextResponse.json({ error: "reportId fehlt." }, { status: 400 });
  }

  await deleteReport(reportId);
  return NextResponse.json({ ok: true });
}
