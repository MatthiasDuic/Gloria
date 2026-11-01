import { NextResponse } from "next/server";
import { deleteUserCampaignTopic, getDashboardData, saveScript } from "@/lib/storage";
import type { TopicPolicyConfig } from "@/lib/types";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { TopicPolicyPayloadSchema } from "@/lib/topic-policy-schema";
import { CampaignKnowledgeError, fetchCampaignKnowledge, normalizeKnowledgeSources } from "@/lib/campaign-knowledge";

export const runtime = "nodejs";
export const maxDuration = 300;

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
    const existing = (await getDashboardData({ userId: resolvedUserId, role: "user" }))
      .topicPolicies.find((policy) => policy.topic === parsed.data.topic);
    const knowledgeSources = normalizeKnowledgeSources(
      parsed.data.knowledgeSources ?? existing?.knowledgeSources ?? [],
    );
    const knowledgeContent = await fetchCampaignKnowledge(knowledgeSources);
    const result = await saveScript(
      parsed.data.topic,
      {
        ...parsed.data,
        knowledgeSources,
        knowledgeContent,
        knowledgeFetchedAt: knowledgeSources.length ? new Date().toISOString() : undefined,
        knowledgeFetchError: "",
      },
      { userId: resolvedUserId },
    );
    return NextResponse.json({
      ok: true,
      topicPolicy: result.script,
      storageMode: result.storageMode,
    });
  } catch (error) {
    if (error instanceof CampaignKnowledgeError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    console.error("Campaign configuration save failed", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Kampagne konnte nicht gespeichert werden.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as { topic?: unknown } | null;
  const topic = typeof payload?.topic === "string" ? payload.topic.trim() : "";
  if (!topic) {
    return NextResponse.json({ error: "Kampagnenname ist erforderlich." }, { status: 400 });
  }

  try {
    await deleteUserCampaignTopic(topic, sessionUser.id);
    return NextResponse.json({ ok: true, topic });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Kampagne konnte nicht gelöscht werden.";
    if (message.includes("Standardthemen")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    if (message.includes("nicht freigegeben")) {
      return NextResponse.json({ error: message }, { status: 403 });
    }
    if (message.includes("nicht in der benutzerspezifischen")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    console.error("Campaign topic deletion failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
