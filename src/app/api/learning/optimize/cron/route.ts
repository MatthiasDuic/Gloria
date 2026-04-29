import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";
import { listUsers } from "@/lib/report-db";
import { optimizePlaybook } from "@/lib/playbook-optimizer";
import { sendOperationalEmail } from "@/lib/mailer";
import { TOPICS } from "@/lib/types";
import type { Topic } from "@/lib/types";
import type { OptimizerResult } from "@/lib/playbook-optimizer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Wöchentlicher Lern-Cron (vercel cron, Mo 04:00 UTC).
 *
 * Strategie BEWUSST nicht "auto-apply": Wir generieren pro (User × Topic)
 * einen Optimizer-Vorschlag aus den letzten Reports und sammeln daraus
 * einen MASTER-DIGEST per E-Mail. Geschrieben wird NICHTS – die Master-Admin
 * entscheidet, ob ein Vorschlag in das Playbook übernommen wird (UI:
 * Playbook-Optimierung manuell ausführen mit `apply=1`).
 *
 * Auth: Bearer ${CRON_SECRET}. Vercel Cron sendet diesen Header automatisch,
 * wenn der Secret in den Environment Variables hinterlegt ist.
 */
function isAuthorized(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

function diffSummary(label: string, before: string, after: string): string {
  const trimmedBefore = (before || "").trim();
  const trimmedAfter = (after || "").trim();
  if (trimmedBefore === trimmedAfter) return `  ${label}: (unverändert)`;
  return [`  ${label}:`, `    ALT: ${trimmedBefore || "(leer)"}`, `    NEU: ${trimmedAfter}`].join("\n");
}

type SuggestionEntry = {
  userId: string;
  username: string;
  topic: Topic;
  reportCount: number;
  source: OptimizerResult["source"];
  rationale: string[];
  diff: string;
};

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const users = await listUsers();
  if (users.length === 0) {
    return NextResponse.json({
      ok: true,
      processed: 0,
      reason: "Keine User – Cron benötigt Postgres mit listUsers().",
    });
  }

  const suggestions: SuggestionEntry[] = [];
  let analysed = 0;

  for (const user of users) {
    let data;
    try {
      data = await getDashboardData({ userId: user.id, role: "user" });
    } catch (error) {
      console.warn("[learning_cron] dashboard_load_failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const topic of TOPICS as readonly Topic[]) {
      const current = data.playbooks.find((p) => p.topic === topic);
      if (!current) continue;

      const reports = data.reports.filter((r) => r.topic === topic);
      // Mind. 5 Reports nötig, damit eine Optimierung statistisch sinnvoll ist.
      if (reports.length < 5) continue;

      analysed += 1;
      try {
        const optimized = await optimizePlaybook(topic, reports, current);
        const changed =
          optimized.opener.trim() !== (current.opener || "").trim() ||
          optimized.discovery.trim() !== (current.discovery || "").trim() ||
          optimized.objectionHandling.trim() !== (current.objectionHandling || "").trim() ||
          optimized.close.trim() !== (current.close || "").trim();

        if (!changed) continue;

        const diff = [
          diffSummary("Opener", current.opener || "", optimized.opener),
          diffSummary("Discovery", current.discovery || "", optimized.discovery),
          diffSummary("Einwand", current.objectionHandling || "", optimized.objectionHandling),
          diffSummary("Close", current.close || "", optimized.close),
        ].join("\n");

        suggestions.push({
          userId: user.id,
          username: user.username,
          topic,
          reportCount: reports.length,
          source: optimized.source,
          rationale: optimized.rationale.slice(0, 5),
          diff,
        });
      } catch (error) {
        console.warn("[learning_cron] optimize_failed", {
          userId: user.id,
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;

  if (suggestions.length === 0) {
    console.info(
      JSON.stringify({
        scope: "learning_cron",
        analysed,
        suggested: 0,
        elapsedMs,
      }),
    );
    return NextResponse.json({ ok: true, analysed, suggested: 0, elapsedMs });
  }

  const lines: string[] = [];
  lines.push(`Wöchentlicher Lernzyklus – Vorschläge zur Playbook-Optimierung`);
  lines.push("");
  lines.push(`Analysierte Playbooks: ${analysed}`);
  lines.push(`Vorschläge mit echten Änderungen: ${suggestions.length}`);
  lines.push("");
  lines.push(
    `WICHTIG: Es wurde NICHTS automatisch in die Playbooks geschrieben. Bewerte die Vorschläge und übernimm sie ggf. im Dashboard (Playbook-Optimierung > Anwenden).`,
  );
  lines.push("");
  for (const s of suggestions) {
    lines.push("--------------------------------------------------------------");
    lines.push(`User: ${s.username} (${s.userId})`);
    lines.push(`Thema: ${s.topic}  |  Reports: ${s.reportCount}  |  Quelle: ${s.source}`);
    if (s.rationale.length) {
      lines.push("Begründung:");
      for (const r of s.rationale) lines.push(`  - ${r}`);
    }
    lines.push("Diff:");
    lines.push(s.diff);
    lines.push("");
  }

  const masterEmail = process.env.LEARNING_DIGEST_EMAIL?.trim() || process.env.REPORT_TO_EMAIL?.trim();
  let mailResult: { delivered: boolean; reason?: string; messageId?: string } = {
    delivered: false,
    reason: "no recipient",
  };
  if (masterEmail) {
    try {
      mailResult = await sendOperationalEmail({
        subject: `Gloria Lernzyklus: ${suggestions.length} Playbook-Vorschläge`,
        body: lines.join("\n"),
        to: masterEmail,
      });
    } catch (error) {
      mailResult = {
        delivered: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  console.info(
    JSON.stringify({
      scope: "learning_cron",
      analysed,
      suggested: suggestions.length,
      mail: mailResult,
      elapsedMs,
    }),
  );

  return NextResponse.json({
    ok: true,
    analysed,
    suggested: suggestions.length,
    mail: mailResult,
    elapsedMs,
    suggestions: suggestions.map((s) => ({
      userId: s.userId,
      username: s.username,
      topic: s.topic,
      reportCount: s.reportCount,
      source: s.source,
      rationale: s.rationale,
    })),
  });
}
