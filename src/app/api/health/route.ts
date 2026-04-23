import { NextResponse } from "next/server";
import { describePreflightFailure, runPreflight } from "@/lib/preflight";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get("mode") || "liveness";

  if (mode === "liveness") {
    return NextResponse.json({ ok: true, service: "gloria-admin" });
  }

  const timeoutMs = Number.parseInt(searchParams.get("timeoutMs") || "", 10);
  const result = await runPreflight({
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
  });

  return NextResponse.json(
    {
      ok: result.ok,
      service: "gloria-admin",
      durationMs: result.durationMs,
      checks: result.checks,
      failureReason: result.ok ? undefined : describePreflightFailure(result),
    },
    { status: result.ok ? 200 : 503 },
  );
}
