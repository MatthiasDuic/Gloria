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
  const inlineComment = value.indexOf(" #");
  if (inlineComment > 0) value = value.slice(0, inlineComment).trim();
  cfg[key] = value;
}

const base = "https://gloria-ki-assistant.vercel.app";
const masterUser = cfg.BASIC_AUTH_USERNAME;
const masterPass = cfg.BASIC_AUTH_PASSWORD;
if (!masterUser || !masterPass) {
  throw new Error("Missing BASIC_AUTH_USERNAME/BASIC_AUTH_PASSWORD in .env.local");
}

const checks = [];
const add = (check, ok, detail) => checks.push({ check, ok: Boolean(ok), detail });

class Session {
  constructor() {
    this.cookieHeader = "";
  }

  async request(urlPath, options = {}) {
    const headers = new Headers(options.headers || {});
    if (this.cookieHeader) headers.set("cookie", this.cookieHeader);
    if (options.json !== undefined) {
      headers.set("content-type", "application/json");
      options.body = JSON.stringify(options.json);
    }

    const response = await fetch(`${base}${urlPath}`, {
      method: options.method || "GET",
      headers,
      body: options.body,
      redirect: "manual",
      cache: "no-store",
    });

    const setCookie = response.headers.getSetCookie?.() || [];
    if (setCookie.length > 0) {
      const pairs = setCookie.map((entry) => entry.split(";")[0]);
      this.cookieHeader = pairs.join("; ");
    }

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return { status: response.status, text, json };
  }
}

const anon = new Session();
const master = new Session();
const user = new Session();

// 1) unauthorized
{
  const r = await anon.request("/api/reports");
  add("unauth_reports_denied", [401, 302, 307].includes(r.status), `status=${r.status}`);
}

// 2) master login + me
{
  const login = await master.request("/api/auth/login", {
    method: "POST",
    json: { username: masterUser, password: masterPass },
  });
  add("master_login_ok", login.status === 200 && login.json?.ok === true, `status=${login.status}`);

  const me = await master.request("/api/auth/me");
  add("master_me_role", me.json?.user?.role === "master", `role=${me.json?.user?.role ?? "-"}`);
}

// 3) master admin users allowed
{
  const r = await master.request("/api/admin/users");
  add(
    "master_admin_users_allowed",
    r.status === 200 && Array.isArray(r.json?.users),
    `status=${r.status};count=${Array.isArray(r.json?.users) ? r.json.users.length : -1}`,
  );
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const e2eUser = `e2e_user_${stamp}`;
const e2ePass = `E2e!${stamp}`;
let userId = "";
let reportId = "";

// 4) create user
{
  const r = await master.request("/api/admin/users", {
    method: "POST",
    json: {
      username: e2eUser,
      password: e2ePass,
      realName: "E2E User",
      companyName: "E2E GmbH",
      role: "user",
    },
  });
  userId = r.json?.user?.id || "";
  add("create_user_ok", r.status === 200 && Boolean(userId), `status=${r.status}`);
}

// 5) assign phone
{
  const r = await master.request("/api/admin/phone-numbers", {
    method: "POST",
    json: {
      userId,
      phoneNumber: "+4900000000001",
      label: "E2E Line",
      active: true,
    },
  });
  add("assign_phone_ok", r.status === 200 && r.json?.ok === true, `status=${r.status}`);
}

// 6) user login + me
{
  const login = await user.request("/api/auth/login", {
    method: "POST",
    json: { username: e2eUser, password: e2ePass },
  });
  add("user_login_ok", login.status === 200 && login.json?.ok === true, `status=${login.status}`);

  const me = await user.request("/api/auth/me");
  add("user_me_role", me.json?.user?.role === "user", `role=${me.json?.user?.role ?? "-"}`);
}

// 7) user admin forbidden
{
  const r = await user.request("/api/admin/users");
  add("user_admin_users_forbidden", r.status === 403, `status=${r.status}`);
}

// 8) user phone scope
{
  const r = await user.request("/api/admin/phone-numbers");
  const phones = Array.isArray(r.json?.phoneNumbers) ? r.json.phoneNumbers : [];
  const own = phones.filter((p) => p.userId === userId);
  add("user_phone_scope", r.status === 200 && own.length >= 1, `status=${r.status};total=${phones.length};own=${own.length}`);
}

// 9) user create report
{
  const appointmentAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const r = await user.request("/api/reports", {
    method: "POST",
    json: {
      company: "E2E GmbH",
      topic: "Energie",
      summary: "E2E tenant report",
      appointmentAt,
    },
  });
  reportId = r.json?.report?.id || "";
  add("user_create_report_ok", r.status === 200 && Boolean(reportId), `status=${r.status}`);
}

// 10) user sees own report
{
  const r = await user.request("/api/reports");
  const reports = Array.isArray(r.json?.reports) ? r.json.reports : [];
  add("user_reports_contains_own", reports.some((x) => x.id === reportId), `reportId=${reportId}`);
}

// 11) master sees user report
{
  const r = await master.request("/api/reports");
  const reports = Array.isArray(r.json?.reports) ? r.json.reports : [];
  add("master_reports_contains_user_report", reports.some((x) => x.id === reportId), `reportId=${reportId}`);
}

const failed = checks.filter((c) => !c.ok);
const out = {
  baseUrl: base,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  createdUser: e2eUser,
  createdUserId: userId,
  createdReportId: reportId,
};

console.log(JSON.stringify(out));
