import fs from "node:fs";

const envRaw = fs.readFileSync(".env.local", "utf8");
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
let cookieHeader = "";
async function req(p, o = {}) {
  const headers = new Headers(o.headers || {});
  if (cookieHeader) headers.set("cookie", cookieHeader);
  if (o.json !== undefined) {
    headers.set("content-type", "application/json");
    o.body = JSON.stringify(o.json);
  }
  const r = await fetch(`${base}${p}`, { method: o.method || "GET", headers, body: o.body, redirect: "manual", cache: "no-store" });
  const sc = r.headers.getSetCookie?.() || [];
  if (sc.length) cookieHeader = sc.map((s) => s.split(";")[0]).join("; ");
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

await req("/api/auth/login", { method: "POST", json: { username: cfg.BASIC_AUTH_USERNAME, password: cfg.BASIC_AUTH_PASSWORD } });
const reports = await req("/api/reports");
const sid = process.argv[2];
const r = (reports.json?.reports || []).find((x) => x.callSid === sid) || reports.json?.reports?.[0];
console.log(JSON.stringify(r, null, 2));
