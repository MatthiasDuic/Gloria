import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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

  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();

  if (!accountSid || !authToken) {
    return NextResponse.json({ error: "Twilio-Zugangsdaten nicht konfiguriert." }, { status: 503 });
  }

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

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

    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Aufnahme konnte nicht abgerufen werden." }, { status: 502 });
  }
}
