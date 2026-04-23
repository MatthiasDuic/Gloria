import { NextResponse } from "next/server";
import { getDashboardData, saveScript } from "@/lib/storage";
import type { PlaybookConfig } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { PlaybookPayloadSchema } from "@/lib/playbook-schema";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;

  const data = await getDashboardData({
    userId: resolvedUserId,
    role: "user",
  });

  return NextResponse.json({
    playbooks: data.playbooks,
    playbooksStorageMode: data.playbooksStorageMode,
  });
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const url = new URL(request.url);
  const targetUserId = url.searchParams.get("userId")?.trim();
  const resolvedUserId =
    sessionUser.role === "master" && targetUserId ? targetUserId : sessionUser.id;

  const payload = (await request.json()) as Partial<PlaybookConfig> & {
    topic?: PlaybookConfig["topic"];
  };

  const parsed = PlaybookPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Playbook-Payload ist ungültig.",
        details: parsed.error.issues.map((issue) => issue.message).slice(0, 5),
      },
      { status: 400 },
    );
  }

  if (!parsed.data.topic) {
    return NextResponse.json({ error: "Thema fehlt." }, { status: 400 });
  }

  try {
    const result = await saveScript(parsed.data.topic, parsed.data, { userId: resolvedUserId });
    return NextResponse.json({
      ok: true,
      playbook: result.script,
      storageMode: result.storageMode,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Playbook konnte nicht gespeichert werden.",
      },
      { status: 500 },
    );
  }
}
