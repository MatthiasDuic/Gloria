import { NextRequest, NextResponse } from "next/server";
import { deleteAllReports, deleteReport, getDashboardData, storeCallReport } from "@/lib/storage";
import { TOPICS, type Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export async function GET(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

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
    userId: sessionUser.id,
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
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const reportId = request.nextUrl.searchParams.get("reportId");
  const all = request.nextUrl.searchParams.get("all");

  // Bulk-Löschung aller Reports des angemeldeten Nutzers.
  // Master-Accounts löschen global, User-Accounts nur ihre eigenen
  // Datensätze (über userId-Filter im DB-Layer).
  if (all === "1" && !reportId) {
    const scope = sessionUser.role === "master" ? {} : { userId: sessionUser.id };
    const result = await deleteAllReports(scope);
    return NextResponse.json({
      ok: true,
      deletedReports: result.deletedReports,
      deletedRecordings: result.deletedRecordings,
    });
  }

  if (!reportId) {
    return NextResponse.json({ error: "reportId fehlt." }, { status: 400 });
  }

  if (sessionUser.role !== "master") {
    const ownData = await getDashboardData({ userId: sessionUser.id, role: "user" });
    const owned = ownData.reports.some((report) => report.id === reportId);

    if (!owned) {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }
  }

  await deleteReport(reportId);
  return NextResponse.json({ ok: true });
}
