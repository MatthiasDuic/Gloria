// Einmal-Skript: startet einen Testanruf in Produktion an eine feste Nummer.
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env.local");
const envRaw = fs.readFileSync(envPath, "utf8");
const cfg = {};
for (const rawLine of envRaw.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq <= 0) continue;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  cfg[key] = value;
}

const base = "https://gloria.agentur-duic-sprockhoevel.de";
const username = cfg.BASIC_AUTH_USERNAME;
const password = cfg.BASIC_AUTH_PASSWORD;
if (!username || !password) {
  throw new Error("BASIC_AUTH_USERNAME/BASIC_AUTH_PASSWORD fehlen in .env.local");
}

let cookieHeader = "";
async function req(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    options.body = JSON.stringify(options.json);
  }
  const r = await fetch(`${base}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    redirect: "manual",
    cache: "no-store",
  });
  const setCookie = r.headers.getSetCookie?.() || [];
  if (setCookie.length > 0) {
    cookieHeader = setCookie.map((s) => s.split(";")[0]).join("; ");
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

console.log("Login …");
const login = await req("/api/auth/login", { method: "POST", json: { username, password } });
console.log("  status:", login.status, "ok:", login.json?.ok);

console.log("Admin phone numbers …");
const phones = await req("/api/admin/phone-numbers");
console.log("  status:", phones.status, "count:", phones.json?.phoneNumbers?.length);
for (const p of phones.json?.phoneNumbers || []) {
  console.log("   -", p.phoneNumber, "id:", p.id, "user:", p.userId);
}
const callerIds = (cfg.TWILIO_CALLER_IDS || cfg.TWILIO_PHONE_NUMBER || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
console.log("  allowed caller ids (from local .env.local):", callerIds);
const firstPhone =
  (phones.json?.phoneNumbers || []).find((p) => p.phoneNumber === "+4923399255995") ||
  phones.json?.phoneNumbers?.[0];
if (!firstPhone) throw new Error("Keine Telefonnummer verfügbar.");
console.log("  using:", firstPhone.phoneNumber, "id:", firstPhone.id);

console.log("Test-Call …");
const call = await req("/api/twilio/test-call", {
  method: "POST",
  json: {
    to: "+4915755806701",
    company: "Testanruf Copilot",
    contactName: "",
    topic: "betriebliche Krankenversicherung",
    phoneNumberId: firstPhone.id,
  },
});
console.log("  status:", call.status);
console.log("  body:", JSON.stringify(call.json || call.text, null, 2));
