import { NextRequest, NextResponse } from "next/server";
import { deleteAllReports, deleteReport, getDashboardData, getLeadById, storeCallReport, updateLeadDetails } from "@/lib/storage";
import { TOPICS, type Topic } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export async function GET(request: NextRequest) {
  try {
    const sessionUser = getSessionUserFromRequest(request);

    if (!sessionUser) {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
    return NextResponse.json(data);
  } catch (error) {
    console.error("/api/reports GET failed:", error);
    return NextResponse.json({
      leads: [],
      reports: [],
      topicPolicies: [],
      metrics: {
        dialAttempts: 0,
        conversations: 0,
        appointments: 0,
        rejections: 0,
        callbacksOpen: 0,
        gatekeeperLoops: 0,
        transferSuccessRate: 0,
      },
      reportStorageMode: "file",
      topicPoliciesStorageMode: "file",
      degraded: true,
    });
  }
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

  if (!topic || !TOPICS.includes(topic as (typeof TOPICS)[number])) {
    return NextResponse.json({ error: "Ungültiges Thema." }, { status: 400 });
  }

  const report = await storeCallReport({
    userId: sessionUser.id,
    callSource: "manual",
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

  // Bulk-Löschung ist immer auf den angemeldeten Benutzer begrenzt.
  // Dadurch bleiben Report-Daten strikt mandantensepariert.
  if (all === "1" && !reportId) {
    const callSource = request.nextUrl.searchParams.get("source");
    if (callSource !== "manual" && callSource !== "crm") {
      return NextResponse.json({ error: "Bitte den Anrufbereich auswählen." }, { status: 400 });
    }
    const result = await deleteAllReports({ userId: sessionUser.id, callSource });
    return NextResponse.json({
      ok: true,
      deletedReports: result.deletedReports,
      deletedRecordings: result.deletedRecordings,
    });
  }

  if (!reportId) {
    return NextResponse.json({ error: "reportId fehlt." }, { status: 400 });
  }

  const ownData = await getDashboardData({ userId: sessionUser.id, role: "user" });
  const owned = ownData.reports.some((report) => report.id === reportId);

  if (!owned) {
    return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
  }

  await deleteReport(reportId);
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  const payload = await request.json() as { leadId?: string; nextCallAt?: string };
  if (!payload.leadId || typeof payload.nextCallAt !== "string"
    || (payload.nextCallAt && !Number.isFinite(Date.parse(payload.nextCallAt)))) {
    return NextResponse.json({ error: "Ungültige manuelle Wiedervorlage." }, { status: 400 });
  }
  const lead = await getLeadById(payload.leadId, sessionUser.id);
  if (!lead || lead.callSource !== "manual") return NextResponse.json({ error: "Manuelle Wiedervorlage nicht gefunden." }, { status: 404 });
  try {
    const updated = await updateLeadDetails(lead.id, {
      nextCallAt: payload.nextCallAt, status: payload.nextCallAt ? "wiedervorlage" : "angerufen",
    }, sessionUser.id);
    if (!updated) return NextResponse.json({ error: "Manuelle Wiedervorlage nicht gefunden." }, { status: 404 });
    return NextResponse.json({ ok: true, lead: updated });
  } catch (error) {
    console.error("Manuelle Wiedervorlage konnte nicht gespeichert werden:", error);
    return NextResponse.json({ error: "Wiedervorlage konnte nicht gespeichert werden." }, { status: 500 });
  }
}
