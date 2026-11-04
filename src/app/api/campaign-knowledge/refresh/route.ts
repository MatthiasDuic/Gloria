import { NextResponse } from "next/server";
import { fetchCampaignKnowledge } from "@/lib/campaign-knowledge";
import { getDashboardData, saveScript } from "@/lib/storage";
import { listUsers } from "@/lib/report-db";
import { isSharedCampaignTopic } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  return request.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const users = await listUsers();
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const user of [{ id: undefined }, ...users]) {
      let dashboard;
      try {
        dashboard = await getDashboardData({ userId: user.id, role: "user" });
      } catch (error) {
        failed += 1;
        console.error("[campaign_knowledge_cron] dashboard_load_failed", {
          userId: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      for (const campaign of dashboard.topicPolicies) {
        if (Boolean(user.id) === isSharedCampaignTopic(campaign.topic)) continue;
        const sources = campaign.knowledgeSources || [];
        if (!sources.length) {
          skipped += 1;
          continue;
        }
        const lastFetchedAt = campaign.knowledgeFetchedAt
          ? Date.parse(campaign.knowledgeFetchedAt)
          : 0;
        if (Number.isFinite(lastFetchedAt) && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) {
          skipped += 1;
          continue;
        }

        try {
          const knowledgeContent = await fetchCampaignKnowledge(sources);
          await saveScript(
            campaign.topic,
            {
              ...campaign,
              knowledgeSources: sources,
              knowledgeContent,
              knowledgeFetchedAt: new Date().toISOString(),
              knowledgeFetchError: "",
            },
            { userId: isSharedCampaignTopic(campaign.topic) ? undefined : user.id },
          );
          updated += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          console.error("[campaign_knowledge_cron] refresh_failed", {
            userId: user.id,
            topic: campaign.topic,
            error: message,
          });
          try {
            await saveScript(
              campaign.topic,
              { knowledgeFetchError: message.slice(0, 500) },
              { userId: isSharedCampaignTopic(campaign.topic) ? undefined : user.id },
            );
          } catch (saveError) {
            console.error("[campaign_knowledge_cron] error_status_save_failed", {
              userId: user.id,
              topic: campaign.topic,
              error: saveError instanceof Error ? saveError.message : String(saveError),
            });
          }
        }
      }
    }

    return NextResponse.json({ ok: true, users: users.length, updated, skipped, failed });
  } catch (error) {
    console.error("[campaign_knowledge_cron] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Wissensquellen konnten nicht aktualisiert werden." },
      { status: 500 },
    );
  }
}
