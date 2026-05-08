import { NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { getDashboardData } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = request.nextUrl.searchParams.get("url");

  if (!url) {
    return NextResponse.json({ error: "Kein URL-Parameter angegeben." }, { status: 400 });
  }

  // Only proxy authentic Twilio recording URLs
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return NextResponse.json({ error: "Ungültige URL." }, { status: 400 });
  }

  if (parsedUrl.hostname !== "api.twilio.com") {
    return NextResponse.json({ error: "Nur Twilio-Aufnahmen können abgerufen werden." }, { status: 403 });
  }

  if (sessionUser.role !== "master") {
    const ownData = await getDashboardData({ userId: sessionUser.id, role: "user" });
    const ownsRecording = ownData.reports.some((report) => report.recordingUrl === url);

    if (!ownsRecording) {
      return NextResponse.json({ error: "Keine Berechtigung für diese Aufnahme." }, { status: 403 });
    }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) {
    return NextResponse.json({ error: "Twilio-Zugangsdaten nicht konfiguriert." }, { status: 503 });
  }

  const credentials = btoa(`${accountSid}:${authToken}`);

  try {
    const twilioResponse = await fetch(url, {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });

    if (!twilioResponse.ok) {
      return NextResponse.json(
        { error: `Twilio antwortete mit ${twilioResponse.status}.` },
        { status: twilioResponse.status },
      );
    }

    const contentType = twilioResponse.headers.get("content-type") ?? "audio/mpeg";
    const audioBuffer = await twilioResponse.arrayBuffer();
    const download = request.nextUrl.searchParams.get("download") === "1";
    const ext = contentType.includes("wav") ? "wav" : "mp3";

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
        ...(download
          ? { "Content-Disposition": `attachment; filename="aufnahme.${ext}"` }
          : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: "Aufnahme konnte nicht abgerufen werden." }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const reportId = request.nextUrl.searchParams.get("reportId");

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

  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`;
  const forwarded = await fetch(`${baseUrl}/api/reports?reportId=${encodeURIComponent(reportId)}`, {
    method: "DELETE",
    headers: { cookie: request.headers.get("cookie") || "" },
    cache: "no-store",
  });

  if (!forwarded.ok) {
    return NextResponse.json({ error: "Aufnahme konnte nicht gelöscht werden." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
