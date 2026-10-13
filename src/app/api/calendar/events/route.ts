import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { deleteCalendarEvent, listCalendarEvents, saveCalendarEvent } from "@/lib/storage";
import { z } from "zod";

const inputSchema = z.object({
  id: z.string().min(1).optional(),
  type: z.enum(["followup", "block"]),
  title: z.string().trim().min(1).max(200),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().max(5000).optional(),
}).refine((input) => input.type !== "block" || Boolean(input.endAt && Date.parse(input.endAt) > Date.parse(input.startAt)), {
  message: "Sperrzeiten benötigen ein Ende nach dem Beginn.",
});

export async function GET(request: Request) {
  const user = getSessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  try { return NextResponse.json({ events: await listCalendarEvents(user.id) }); }
  catch (error) {
    console.error("calendar/events GET failed:", error);
    return NextResponse.json({ error: "Kalendereinträge konnten nicht geladen werden." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = getSessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Ungültige JSON-Daten." }, { status: 400 }); }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  const input = parsed.data;
  try {
    if (input.id && !(await listCalendarEvents(user.id)).some((event) => event.id === input.id)) {
      return NextResponse.json({ error: "Kalendereintrag nicht gefunden." }, { status: 404 });
    }
    const startAt = new Date(input.startAt).toISOString();
    const endAt = input.type === "followup"
      ? new Date(Date.parse(startAt) + 90 * 60_000).toISOString()
      : new Date(input.endAt!).toISOString();
    const event = await saveCalendarEvent(user.id, { type: input.type, title: input.title, startAt, endAt, note: input.note }, input.id);
    return NextResponse.json({ ok: true, event });
  } catch (error) {
    console.error("calendar/events POST failed:", error);
    return NextResponse.json({ error: "Kalendereintrag konnte nicht gespeichert werden." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  const user = getSessionUserFromRequest(request);
  if (!user) return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Kalendereintrag fehlt." }, { status: 400 });
  try {
    if (!await deleteCalendarEvent(user.id, id)) return NextResponse.json({ error: "Kalendereintrag nicht gefunden." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("calendar/events DELETE failed:", error);
    return NextResponse.json({ error: "Kalendereintrag konnte nicht gelöscht werden." }, { status: 503 });
  }
}
