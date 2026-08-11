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

const login = await req("/api/auth/login", { method: "POST", json: { username, password } });
console.log("login", login.status, login.json);
const phones = await req("/api/admin/phone-numbers");
console.log("phones status", phones.status);
console.log(JSON.stringify(phones.json, null, 2));
