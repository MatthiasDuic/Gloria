import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { ensureMasterAdmin, findUserById } from "@/lib/report-db";
import { createCalendarFeedToken } from "@/lib/calendar-feed";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  try {
    await ensureMasterAdmin();
    const latestUser = await findUserById(sessionUser.id);

    if (!latestUser) {
      return NextResponse.json({ error: "Benutzer nicht gefunden." }, { status: 401 });
    }

    const calendarFeedToken = createCalendarFeedToken(latestUser.id);

    return NextResponse.json({
      user: {
        id: latestUser.id,
        username: latestUser.username,
        role: latestUser.role,
        realName: latestUser.realName,
        companyName: latestUser.companyName,
        selectedVoiceId: latestUser.selectedVoiceId,
        allowedPlaybookTopics: latestUser.allowedPlaybookTopics,
        calendarFeedToken,
      },
    });
  } catch (error) {
    console.error("/api/auth/me failed, using token fallback:", error);
    return NextResponse.json({
      user: {
        id: sessionUser.id,
        username: sessionUser.username,
        role: sessionUser.role,
        realName: sessionUser.realName,
        companyName: sessionUser.companyName,
        selectedVoiceId: "",
        allowedPlaybookTopics: [],
        calendarFeedToken: createCalendarFeedToken(sessionUser.id),
      },
      degraded: true,
    });
  }
}
