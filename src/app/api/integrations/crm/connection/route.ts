import { isIP } from "node:net";
import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import {
  findUserById,
  getUserCrmConnection,
  updateUserCrmConnection,
} from "@/lib/report-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

function validateCrmApiUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const localHost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && localHost && url.protocol === "http:")) ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    (!localHost && !hostname.includes(".")) ||
    (isIP(hostname) === 4 && isPrivateIpv4(hostname)) ||
    (isIP(hostname) === 6 && hostname !== "[::1]")
  ) {
    return null;
  }
  return url.origin;
}

async function getPairedUser(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) return { error: "Nicht angemeldet.", status: 401 as const };
  const user = await findUserById(sessionUser.id);
  if (!user) return { error: "Benutzer nicht gefunden.", status: 401 as const };
  return { user };
}

export async function GET(request: Request) {
  const auth = await getPairedUser(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  try {
    const connection = await getUserCrmConnection(auth.user.id);
    return NextResponse.json({
      connected: Boolean(connection?.apiUrl && connection.crmUserId),
      apiUrl: connection?.apiUrl || "",
    });
  } catch (error) {
    console.error("Could not load CRM connection:", error);
    return NextResponse.json({ error: "CRM-Verbindung konnte nicht geladen werden." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await getPairedUser(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Ungültiger JSON-Inhalt." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "Verbindungsdaten sind ungültig." }, { status: 400 });
  }
  const body = payload as Record<string, unknown>;
  const apiUrl = validateCrmApiUrl(body.apiUrl);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiUrl || !apiKey || apiKey.length > 512) {
    return NextResponse.json({ error: "Bitte eine gültige HTTPS-Adresse und den CRM-API-Schlüssel angeben." }, { status: 400 });
  }

  let response: Response;
  try {
    response = await fetch(`${apiUrl}/integrations/gloria/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-crm-api-key": apiKey },
      body: JSON.stringify({ gloria_user_id: auth.user.id }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("CRM account pairing request failed:", error);
    return NextResponse.json({ error: "CRM-Server nicht erreichbar. Adresse und Verbindung prüfen." }, { status: 502 });
  }
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 || response.status === 409
      ? response.status
      : 502;
    return NextResponse.json({
      error: status === 401 || status === 403
        ? "CRM-API-Schlüssel ungültig oder CRM-Benutzer inaktiv."
        : status === 409
          ? "Dieses CRM- oder Gloria-Konto ist bereits anders verknüpft."
          : "CRM konnte die Verbindung nicht bestätigen.",
    }, { status });
  }

  const contentType = response.headers.get("content-type") || "nicht angegeben";
  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch {
    console.error("Could not read CRM account pairing response:", { status: response.status, contentType });
    return NextResponse.json({ error: "CRM-Antwort konnte nicht gelesen werden. Bitte Backend-Adresse und Verbindung prüfen." }, { status: 502 });
  }

  let pairing: unknown;
  try {
    pairing = JSON.parse(responseBody);
  } catch {
    console.error("CRM account pairing response was not valid JSON:", {
      status: response.status,
      contentType,
      bodyLength: responseBody.length,
    });
    return NextResponse.json({
      error: `CRM antwortete mit HTTP ${response.status}, aber nicht mit gültigem JSON (Content-Type: ${contentType}). Bitte die CRM-Backend-Adresse prüfen: https://versifon-crm-backend.onrender.com`,
    }, { status: 502 });
  }
  if (
    !pairing ||
    typeof pairing !== "object" ||
    !("paired" in pairing) ||
    pairing.paired !== true ||
    !("crm_user_id" in pairing) ||
    typeof pairing.crm_user_id !== "string" ||
    !pairing.crm_user_id.trim() ||
    pairing.crm_user_id.length > 160
  ) {
    console.error("CRM account pairing response was missing required confirmation fields:", {
      status: response.status,
      contentType,
    });
    return NextResponse.json({
      error: "CRM hat keine passende Verknüpfungsbestätigung zurückgegeben. Bitte prüfen, dass die Adresse auf das CRM-Backend zeigt und dieses aktuell ist.",
    }, { status: 502 });
  }

  try {
    await updateUserCrmConnection(auth.user.id, { apiUrl, crmUserId: pairing.crm_user_id });
  } catch (error) {
    console.error("Could not persist CRM account pairing:", error);
    return NextResponse.json({ error: "CRM hat die Verbindung bestätigt, aber Gloria konnte sie nicht speichern." }, { status: 500 });
  }
  return NextResponse.json({ connected: true, apiUrl });
}

export async function DELETE(request: Request) {
  const auth = await getPairedUser(request);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Zum Trennen wird der CRM-API-Schlüssel benötigt." }, { status: 400 });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return NextResponse.json({ error: "Verbindungsdaten sind ungültig." }, { status: 400 });
  }
  const body = payload as Record<string, unknown>;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const connection = await getUserCrmConnection(auth.user.id);
  if (!connection?.apiUrl || !connection.crmUserId || !apiKey) {
    return NextResponse.json({ error: "Keine vollständige CRM-Verbindung vorhanden." }, { status: 409 });
  }
  let response: Response;
  try {
    response = await fetch(`${connection.apiUrl}/integrations/gloria/pair`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-crm-api-key": apiKey },
      body: JSON.stringify({ gloria_user_id: auth.user.id }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("CRM account unpair request failed:", error);
    return NextResponse.json({ error: "CRM-Server nicht erreichbar; Verbindung wurde nicht getrennt." }, { status: 502 });
  }
  if (!response.ok) {
    return NextResponse.json({ error: "CRM konnte die Verbindung nicht trennen. API-Schlüssel prüfen." }, { status: 502 });
  }
  try {
    await updateUserCrmConnection(auth.user.id, { apiUrl: "", crmUserId: "" });
  } catch (error) {
    console.error("Could not clear CRM account pairing:", error);
    return NextResponse.json({ error: "CRM-Verbindung wurde getrennt, aber Gloria konnte den lokalen Status nicht aktualisieren." }, { status: 500 });
  }
  return NextResponse.json({ connected: false });
}
