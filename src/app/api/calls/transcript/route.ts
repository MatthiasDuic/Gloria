import { NextResponse } from "next/server";
import { appendCallTranscriptEventsToPostgres } from "@/lib/report-db";
import { isDoNotCallRequest, suppressPhoneNumber } from "@/lib/call-safety";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!token || request.headers.get("x-gloria-internal-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.callSid !== "string" || typeof body.userId !== "string" || !Array.isArray(body.turns)
    || body.turns.length > 1000 || body.turns.some((turn: { role?: string; text?: string; at?: number }) =>
      !["user", "assistant"].includes(turn.role || "") || typeof turn.text !== "string"
      || turn.text.length > 20000 || !Number.isFinite(turn.at))) {
    return NextResponse.json({ error: "Invalid transcript" }, { status: 400 });
  }
  if (!body.turns.length) return NextResponse.json({ ok: true });
  if (typeof body.calledPhone === "string" && body.turns.some((turn: { role: string; text: string }) => turn.role === "user" && isDoNotCallRequest(turn.text))) {
    await suppressPhoneNumber(body.userId, body.calledPhone);
  }
  const saved = await appendCallTranscriptEventsToPostgres(body.turns.map((turn: { role: string; text: string; at: number; phase?: string; latencyMs?: number }) => ({
    callSid: body.callSid, userId: body.userId, speaker: turn.role === "assistant" ? "Gloria" : "Interessent",
    text: turn.text, spokenAt: turn.at, phase: turn.phase, latencyMs: turn.latencyMs,
  })));
  return NextResponse.json({ ok: saved }, { status: saved ? 200 : 503 });
}