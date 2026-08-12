import { NextResponse } from "next/server";
import { getDashboardData, saveScript } from "@/lib/storage";
import type { TopicPolicyConfig } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { TopicPolicyPayloadSchema } from "@/lib/topic-policy-schema";

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
    topicPolicies: data.topicPolicies,
    topicPoliciesStorageMode: data.topicPoliciesStorageMode,
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

  const payload = (await request.json()) as Partial<TopicPolicyConfig> & {
    topic?: TopicPolicyConfig["topic"];
  };

  const parsed = TopicPolicyPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .slice(0, 5);
    return NextResponse.json(
      {
        error: `Topic-Policy-Payload ist ungültig: ${details.join("; ")}`,
        details,
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
      topicPolicy: result.script,
      storageMode: result.storageMode,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Topic Policy konnte nicht gespeichert werden.",
      },
      { status: 500 },
    );
  }
}
