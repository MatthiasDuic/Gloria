import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool } from "pg";
import type { Lead } from "./types";
import { MAX_CONCURRENT_OUTBOUND_CALLS } from "./outbound-call-queue-constants";
import { reserveCallAppointment } from "./report-db";
import { globalJobQueue } from "./job-queue";
import { isDoNotCallRequest, isPhoneNumberSuppressed, suppressPhoneNumber } from "./call-safety";

test("cold database initialization preserves custom topics and topic grants for master and user accounts", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const topics = ["Recruiting", "Mitarbeitergewinnung"];
  const accounts = ["master-owner", "regular-owner"];
  let personal = accounts.flatMap((userId) => topics.map((topic) => ({
    userId, topic, content: JSON.stringify({ id: `${userId}-${topic}`, topic, callObjective: `${userId}: ${topic}` }),
  })));
  let shared = [{ topic: "private Krankenversicherung", data: { topic: "private Krankenversicherung" } },
    { topic: "Bestehendes eigenes Thema", data: { topic: "Bestehendes eigenes Thema" } }];
  let grants = [...topics];
  const statements: string[] = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    statements.push(sql);
    const retainedTopics = Array.isArray(values[0]) ? values[0] : [];
    if (/DELETE FROM user_playbooks WHERE topic <> ALL/.test(sql)) {
      personal = personal.filter((entry) => retainedTopics.includes(entry.topic));
    }
    if (/DELETE FROM gloria_playbooks WHERE topic <> ALL/.test(sql)) {
      shared = shared.filter((entry) => retainedTopics.includes(entry.topic));
    }
    if (/UPDATE users\s+SET allowed_playbook_topics/.test(sql)) {
      grants = grants.filter((topic) => retainedTopics.includes(topic));
    }
    if (/^\s*SELECT topic, data\s+FROM gloria_playbooks/.test(sql)) return { rows: shared, rowCount: shared.length };
    if (/^\s*SELECT\s+topic,\s*content\s+FROM user_playbooks/.test(sql)) {
      const rows = personal.filter((entry) => entry.userId === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM users")) return { rows: [{ id: values[0], username: values[0], role: values[0] === accounts[0] ? "master" : "user", allowed_playbook_topics: grants }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  try {
    const { getTelephonyTopicPolicies } = await import("./storage");
    const { findUserById, readScriptsFromPostgres } = await import("./report-db");
    for (const userId of accounts) {
      const loaded = await getTelephonyTopicPolicies(userId);
      assert.equal(loaded.topicPoliciesStorageMode, "postgres");
      for (const topic of topics) {
        assert.equal(loaded.topicPolicies.find((policy) => policy.topic === topic)?.callObjective, `${userId}: ${topic}`);
      }
      assert.deepEqual((await findUserById(userId))?.allowedPlaybookTopics, topics);
    }
    assert.ok(statements.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS user_playbooks")));
    assert.ok((await readScriptsFromPostgres())?.some((policy) => policy.topic === "Bestehendes eigenes Thema"));
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("the transcript endpoint stores batch fields in the PostgreSQL record format", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousToken = process.env.APP_INTERNAL_TOKEN;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.APP_INTERNAL_TOKEN = "test-internal-token";
  const inserted: Array<Record<string, unknown>> = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (sql.includes("INSERT INTO call_transcript_events") && sql.includes("jsonb_to_recordset")) {
      const rows = JSON.parse(String(values[0])) as Array<Record<string, unknown>>;
      inserted.push(...rows);
      if (rows.some((row) => row.call_sid == null || row.text_value == null)) {
        throw new Error("null value in required transcript column");
      }
    }
    return { rows: [], rowCount: 0 };
  });
  try {
    const { POST } = await import("../app/api/calls/transcript/route");
    const spokenAt = Date.parse("2026-11-05T07:04:32.000Z");
    const response = await POST(new Request("https://example.test/api/calls/transcript", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gloria-internal-token": "test-internal-token" },
      body: JSON.stringify({
        callSid: "test-call",
        userId: "test-user",
        turns: [
          { role: "user", text: "Guten Tag", at: spokenAt, phase: "opener" },
          { role: "assistant", text: "Hallo", at: spokenAt + 1000, phase: "opener", latencyMs: 1204.6 },
        ],
      }),
    }));

    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(inserted.length, 2);
    assert.ok(inserted.every((row) => typeof row.id === "string" && row.id.length > 0));
    assert.deepEqual(
      inserted.map(({ call_sid, user_id, speaker, text_value, phase, latency_ms, spoken_at }) => ({
        call_sid, user_id, speaker, text_value, phase, latency_ms, spoken_at,
      })),
      [
        {
          call_sid: "test-call", user_id: "test-user", speaker: "Interessent", text_value: "Guten Tag",
          phase: "opener", latency_ms: null, spoken_at: new Date(spokenAt).toISOString(),
        },
        {
          call_sid: "test-call", user_id: "test-user", speaker: "Gloria", text_value: "Hallo",
          phase: "opener", latency_ms: 1205, spoken_at: new Date(spokenAt + 1000).toISOString(),
        },
      ],
    );
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previousToken;
  }
});

test("the telephony assignment endpoint never loads contacts or call reports", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousToken = process.env.APP_INTERNAL_TOKEN;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.APP_INTERNAL_TOKEN = "fixture-policy";
  const statements: string[] = [];
  mock.method(Pool.prototype, "query", async (sql: string) => {
    statements.push(sql);
    if (/^\s*SELECT topic, data\s+FROM gloria_playbooks/.test(sql)) return { rows: [{ topic: "private Krankenversicherung", data: { id: "shared", callObjective: "Unveränderter Originalauftrag" } }], rowCount: 1 };
    if (sql.includes("FROM users")) return { rows: [{ id: "owner", username: "owner", role: "user", allowed_playbook_topics: [] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  try {
    const { getDatabasePool } = await import("./report-db");
    await getDatabasePool();
    statements.length = 0;
    const { GET } = await import("../app/api/telnyx/topic-policies/route");
    const response = await GET(new Request("https://example.test/api/telnyx/topic-policies?userId=owner", { headers: { "x-gloria-internal-token": "fixture-policy" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).topicPolicies[0].callObjective, "Unveränderter Originalauftrag");
    assert.equal(statements.some((sql) => /FROM (?:gloria_leads|gloria_reports|conversation_events|gloria_calendar_events)/.test(sql)), false);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousToken === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previousToken;
  }
});

test("users save personal topics while master changes update the single shared source", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const shared = [{ id: "shared-pkv", topic: "private Krankenversicherung", callObjective: "Gemeinsamer Auftrag", opener: "", discovery: "", objectionHandling: "", close: "" }];
  const personal: Array<{ userId: string; topic: string; content: string }> = [];
  let personalWrites = 0;
  let sharedWrites = 0;
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (/^\s*SELECT topic, data\s+FROM gloria_playbooks/.test(sql)) return { rows: shared.map((data) => ({ topic: data.topic, data })), rowCount: shared.length };
    if (/^\s*SELECT\s+topic,\s*content\s+FROM user_playbooks/.test(sql)) {
      const rows = personal.filter((entry) => entry.userId === values[0]);
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM users")) return { rows: [{ id: values[0], username: values[0], role: values[0] === "master-owner" ? "master" : "user", allowed_playbook_topics: ["Anderes Thema"] }], rowCount: 1 };
    if (sql.includes("INSERT INTO user_playbooks") && values.length >= 4) {
      personalWrites++;
      const stored = { userId: String(values[1]), topic: String(values[2]), content: String(values[3]) };
      const index = personal.findIndex((entry) => entry.userId === stored.userId && entry.topic === stored.topic);
      if (index >= 0) personal[index] = stored;
      else personal.push(stored);
    }
    if (/^\s*INSERT INTO gloria_playbooks/.test(sql) && values.length === 2) {
      sharedWrites++;
      shared[0] = JSON.parse(String(values[1]));
    }
    return { rows: [], rowCount: 0 };
  });
  try {
    const { getDatabasePool } = await import("./report-db");
    await getDatabasePool();
    personalWrites = 0;
    sharedWrites = 0;
    const { GET, POST } = await import("../app/api/topic-policies/route");
    const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
    const request = (role: "master" | "user", topic: string, callObjective: string, userId = "owner") => new Request("https://example.test/api/topic-policies", {
      method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${createSessionToken({ id: userId, username: userId, role, realName: "", companyName: "", gesellschaft: "" })}` },
      body: JSON.stringify({ topic, callObjective, knowledgeSources: [] }),
    });
    assert.equal((await POST(request("user", "Mein persönliches Thema", "Mein eigener Auftrag"))).status, 200);
    assert.equal(personalWrites, 1);
    assert.equal(sharedWrites, 0);
    assert.equal((await POST(request("master", "private Krankenversicherung", "Zentraler Masterauftrag"))).status, 200);
    assert.equal(sharedWrites, 1);
    assert.equal(personalWrites, 1);
    const { getDashboardData } = await import("./storage");
    const data = await getDashboardData({ userId: "owner", role: "user" });
    assert.equal(data.topicPolicies.find((policy) => policy.topic === "private Krankenversicherung")?.callObjective, "Zentraler Masterauftrag");
    assert.ok(data.topicPolicies.some((policy) => policy.topic === "Mein persönliches Thema"));
    assert.equal((await POST(request("user", "Neues Thema ohne Auftrag", ""))).status, 200);
    const freshSessionRequest = (id: string, role: "master" | "user" = "user") => new Request("https://example.test/api/topic-policies", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${createSessionToken({ id, username: id, role, realName: "", companyName: "", gesellschaft: "" })}` },
    });
    const freshLogin = await GET(freshSessionRequest("owner"));
    assert.equal(freshLogin.status, 200);
    const reloaded = await freshLogin.json();
    assert.equal(reloaded.topicPolicies.find((policy: { topic: string }) => policy.topic === "Neues Thema ohne Auftrag")?.callObjective, "");
    assert.equal((await POST(request("user", "Neues Thema ohne Auftrag", "Dauerhaft geänderter Auftrag"))).status, 200);
    const afterEdit = await (await GET(freshSessionRequest("owner"))).json();
    assert.equal(afterEdit.topicPolicies.find((policy: { topic: string }) => policy.topic === "Neues Thema ohne Auftrag")?.callObjective, "Dauerhaft geänderter Auftrag");
    const otherLogin = await (await GET(freshSessionRequest("other-owner"))).json();
    assert.equal(otherLogin.topicPolicies.some((policy: { topic: string }) => policy.topic === "Neues Thema ohne Auftrag"), false);
    const { getTelephonyTopicPolicies } = await import("./storage");
    const { canUserAccessTopic } = await import("./report-db");
    for (const role of ["master", "user"] as const) {
      for (const topic of ["Recruiting", "Mitarbeitergewinnung"]) {
        const response = await POST(request(role, topic, "", `${role}-owner`));
        assert.equal(response.status, 200);
        assert.equal((await response.json()).storageMode, "postgres");
        assert.equal((await POST(request(role, topic, `${role}: ${topic}`, `${role}-owner`))).status, 200);
      }
    }
    for (const role of ["master", "user"] as const) {
      const ownerId = `${role}-owner`;
      const login = await (await GET(freshSessionRequest(ownerId, role))).json();
      const assignment = await getTelephonyTopicPolicies(ownerId);
      assert.equal(login.topicPoliciesStorageMode, "postgres");
      for (const topic of ["Recruiting", "Mitarbeitergewinnung"]) {
        assert.equal(login.topicPolicies.find((policy: { topic: string }) => policy.topic === topic)?.callObjective, `${role}: ${topic}`);
        assert.equal(assignment.topicPolicies.find((policy) => policy.topic === topic)?.callObjective, `${role}: ${topic}`);
        assert.equal(await canUserAccessTopic(ownerId, topic), true);
      }
    }
    const unrelatedLogin = await (await GET(freshSessionRequest("unrelated-owner"))).json();
    assert.equal(unrelatedLogin.topicPolicies.some((policy: { topic: string }) => ["Recruiting", "Mitarbeitergewinnung"].includes(policy.topic)), false);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("configured database write failures never confirm a topic using a file fallback", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  mock.method(Pool.prototype, "query", async (sql: string) => {
    if (/INSERT INTO (?:user_playbooks|gloria_playbooks)/.test(sql)) throw new Error("fixture write unavailable");
    if (sql.includes("FROM users")) return { rows: [{ id: "owner", username: "owner", role: "user", allowed_playbook_topics: [] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  try {
    const { saveScript } = await import("./storage");
    await assert.rejects(saveScript("Recruiting", { callObjective: "Test" }, { userId: "owner" }), /konnte nicht gespeichert werden/);
    await assert.rejects(saveScript("private Krankenversicherung", { callObjective: "Test" }), /nicht dauerhaft in PostgreSQL gespeichert/);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("Vercel requires a database before confirming durable topic storage", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousVercel = process.env.VERCEL;
  delete process.env.DATABASE_URL;
  process.env.VERCEL = "1";
  try {
    const { saveScript } = await import("./storage");
    await assert.rejects(saveScript("Recruiting", { callObjective: "Test" }), /PostgreSQL-Datenbank konfiguriert/);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test("campaign copies preserve full content and never overwrite an existing personal name", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  let duplicate = false;
  let saved: unknown[] | undefined;
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO user_playbooks")) { saved = values; return { rows: [{ id: values[0] }], rowCount: 1 }; }
      return { rows: sql.includes("SELECT 1 FROM user_playbooks") && duplicate ? [{ exists: true }] : [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  try {
    const { createPersonalCampaignCopy } = await import("./report-db");
    const source = { id: "original", topic: "private Krankenversicherung", callObjective: "Auftrag. ".repeat(300), knowledgeContent: "Vollständiges Wissen.", conversationGuardrails: "Verbindliche Regeln.", opener: "", discovery: "", objectionHandling: "", close: "" };
    const copy = await createPersonalCampaignCopy("owner", source, "Meine persönliche Kampagne");
    assert.ok(copy);
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.callObjective, source.callObjective);
    assert.equal(copy.knowledgeContent, source.knowledgeContent);
    assert.equal(copy.conversationGuardrails, source.conversationGuardrails);
    assert.equal(copy.sourceTopic, source.topic);
    assert.equal(saved?.[1], "owner");
    duplicate = true;
    assert.equal(await createPersonalCampaignCopy("owner", source, "Meine persönliche Kampagne"), null);
    await assert.rejects(createPersonalCampaignCopy("owner", source, "betriebliche Krankenversicherung"), /reserviert/);
    const { POST } = await import("../app/api/topic-policies/copy/route");
    assert.equal((await POST(new Request("https://example.test/api/topic-policies/copy", { method: "POST", body: "{}" }))).status, 401);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("both shared campaigns remain callable regardless of a user's old allow list", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  mock.method(Pool.prototype, "query", async (sql: string) => ({
    rows: sql.includes("FROM users") ? [{ id: "user", username: "user", role: "user", allowed_playbook_topics: ["Anderes Thema"] }] : [], rowCount: 0,
  }));
  try {
    const { canUserAccessTopic } = await import("./report-db");
    assert.equal(await canUserAccessTopic("user", "private Krankenversicherung"), true);
    assert.equal(await canUserAccessTopic("user", "betriebliche Krankenversicherung"), true);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("regular users cannot edit shared insurance campaigns but keep individually named topics", async () => {
  const { POST, DELETE } = await import("../app/api/topic-policies/route");
  const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
  const { isSharedCampaignTopic, resolveCampaignPolicies } = await import("./types");
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken({ id: "user", username: "user", role: "user", realName: "", companyName: "", gesellschaft: "" })}`;
  for (const topic of ["private Krankenversicherung", "betriebliche Krankenversicherung"]) {
    const request = (method: string) => new Request("https://example.test/api/topic-policies", { method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ topic, callObjective: "Unzulässige Änderung" }) });
    assert.equal((await POST(request("POST"))).status, 403);
    assert.equal((await DELETE(request("DELETE"))).status, 403);
  }
  assert.equal(isSharedCampaignTopic("PRIVATE KRANKENVERSICHERUNG"), true);
  assert.equal(isSharedCampaignTopic("Individuelles Thema"), false);
  const shared = [{ topic: "private Krankenversicherung", callObjective: "Gemeinsamer Originalauftrag" }];
  const firstUser = resolveCampaignPolicies(shared, [{ topic: "private Krankenversicherung", callObjective: "Alte persönliche Kopie" }, { topic: "Persönlich A", callObjective: "Nur A" }]);
  const secondUser = resolveCampaignPolicies(shared, [{ topic: "Persönlich B", callObjective: "Nur B" }]);
  assert.equal(firstUser[0].callObjective, "Gemeinsamer Originalauftrag");
  assert.equal(secondUser[0].callObjective, "Gemeinsamer Originalauftrag");
  assert.equal(secondUser.some((policy) => policy.topic === "Persönlich A"), false);
});

test("global assignment inspection is denied to unauthenticated callers", async () => {
  const { GET, POST } = await import("../app/api/telnyx/topic-policies/route");
  assert.equal((await GET(new Request("https://example.test/api/telnyx/topic-policies?scope=global"))).status, 403);
  assert.equal((await POST(new Request("https://example.test/api/telnyx/topic-policies", { method: "POST", body: "{}" }))).status, 403);
});

test("master restoration copies an existing assignment without creating new conversation wording", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const source = { id: "source", topic: "private Krankenversicherung", callObjective: "Unveränderter Originalauftrag zur Gesundheitsversorgung.", opener: "Originaler Einstieg", discovery: "Originale Bedarfsfrage", close: "Originaler Abschluss", objectionHandling: "Originale Einwände" };
  const writes: unknown[][] = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (/^\s*SELECT topic, data\s+FROM gloria_playbooks/.test(sql)) return { rows: [{ topic: source.topic, data: source }], rowCount: 1 };
    if (/^\s*SELECT\s+topic,\s*content\s+FROM user_playbooks/.test(sql)) return { rows: [{ topic: source.topic, content: JSON.stringify({ ...source, id: "current", callObjective: undefined }) }], rowCount: 1 };
    if (sql.includes("INSERT INTO user_playbooks")) writes.push(values);
    return { rows: [], rowCount: 0 };
  });
  try {
    const { POST } = await import("../app/api/telnyx/topic-policies/route");
    const { createSessionToken, SESSION_COOKIE_NAME } = await import("./session");
    const token = createSessionToken({ id: "owner", username: "owner", role: "master", realName: "", companyName: "", gesellschaft: "" });
    const request = (expectedCurrentId: string) => new Request("https://example.test/api/telnyx/topic-policies", {
      method: "POST", headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "restore_global_assignment", topic: source.topic, expectedCurrentId, expectedSourceObjective: source.callObjective }),
    });
    assert.equal((await POST(request("changed-id"))).status, 409);
    assert.equal((await POST(request("current"))).status, 200);
    assert.ok(writes.some((values) => values.some((value) => typeof value === "string" && value.includes(source.callObjective))));
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("a failed user-playbook read never bootstraps or overwrites conversation contents", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const writes: string[] = [];
  mock.method(Pool.prototype, "query", async (sql: string) => {
    if (/^\s*SELECT\s+topic,\s*content\s+FROM user_playbooks/i.test(sql)) throw new Error("fixture database unavailable");
    if (/INSERT INTO (?:user_playbooks|gloria_playbooks)/.test(sql)) writes.push(sql);
    return { rows: [], rowCount: 0 };
  });
  try {
    const { getDashboardData } = await import("./storage");
    await assert.rejects(getDashboardData({ userId: "fixture-owner", role: "user" }), /Gesprächsleitfaden.*nicht verfügbar/);
    assert.deepEqual(writes, []);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("queue recovery frees only calls explicitly confirmed finished by Telnyx", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousApiKey = process.env.TELNYX_API_KEY;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.TELNYX_API_KEY = "fixture";
  const completed: unknown[] = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (sql.includes("WITH finished")) completed.push(values[0]);
    return { rows: sql.includes("SELECT id,call_sid FROM outbound_call_queue")
      ? [{ id: "live", call_sid: "live-call" }, { id: "ended", call_sid: "ended-call" }] : [], rowCount: 0 };
  });
  mock.method(globalThis, "fetch", async (url: string | URL | Request) => new Response(JSON.stringify({ data: { is_alive: String(url).endsWith("live-call") } }), { status: 200 }));
  try {
    const { reconcileOutboundCallQueue } = await import("./outbound-call-queue");
    await reconcileOutboundCallQueue();
    assert.deepEqual(completed, ["ended-call"]);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousApiKey === undefined) delete process.env.TELNYX_API_KEY;
    else process.env.TELNYX_API_KEY = previousApiKey;
  }
});

test("text-only incremental transcripts authenticate before touching persistence", async () => {
  const previous = process.env.APP_INTERNAL_TOKEN;
  process.env.APP_INTERNAL_TOKEN = "fixture-transcript";
  try {
    const { POST } = await import("../app/api/calls/transcript/route");
    assert.equal((await POST(new Request("https://example.test/api/calls/transcript", { method: "POST", body: "{}" }))).status, 401);
    assert.equal((await POST(new Request("https://example.test/api/calls/transcript", {
      method: "POST", headers: { "x-gloria-internal-token": "fixture-transcript" }, body: JSON.stringify({ callSid: "call", userId: "owner", turns: [{ role: "audio", text: "not-text", at: Date.now() }] }),
    }))).status, 400);
  } finally {
    if (previous === undefined) delete process.env.APP_INTERNAL_TOKEN;
    else process.env.APP_INTERNAL_TOKEN = previous;
  }
});

test("contact prohibitions persist per owner and normalize phone numbers", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  let saved: unknown[] | undefined;
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO gloria_call_suppressions")) saved = values;
    return { rows: sql.startsWith("SELECT 1 FROM gloria_call_suppressions") && JSON.stringify(saved) === JSON.stringify(values) ? [{ blocked: true }] : [], rowCount: 0 };
  });
  try {
    assert.equal(isDoNotCallRequest("Rufen Sie mich bitte nicht mehr an."), true);
    assert.equal(isDoNotCallRequest("Bitte morgen wieder anrufen."), false);
    await suppressPhoneNumber("owner", "+49 2339 555100");
    assert.equal(await isPhoneNumberSuppressed("owner", "+492339555100"), true);
    assert.equal(await isPhoneNumberSuppressed("other-owner", "+492339555100"), false);
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});

test("background jobs have stable database identities and authenticated GET cron processing", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousCron = process.env.CRON_SECRET;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.CRON_SECRET = "fixture-cron";
  const queries: string[] = [];
  mock.method(Pool.prototype, "query", async (sql: string) => {
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  });
  try {
    const first = await globalJobQueue.enqueue("send_email", "fixture-call", { reportId: "report" });
    assert.equal(await globalJobQueue.enqueue("send_email", "fixture-call", { reportId: "report" }), first);
    assert.ok(queries.some((sql) => sql.includes("ON CONFLICT (id) DO UPDATE")));
    const { GET } = await import("../app/api/jobs/process/route");
    assert.equal((await GET(new Request("https://example.test/api/jobs/process"))).status, 401);
    const response = await GET(new Request("https://example.test/api/jobs/process", { headers: { authorization: "Bearer fixture-cron" } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).processed, 0);
    assert.ok(queries.some((sql) => sql.includes("FOR UPDATE SKIP LOCKED")));
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousCron === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousCron;
  }
});

test("appointment reservations serialize per owner and reject occupied intervals", async () => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const statements: string[] = [];
  let blocked = false;
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: sql.includes("AS busy WHERE") && blocked ? [{ occupied: true }] : [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  try {
    const start = new Date(Date.now() + 86400_000).toISOString();
    assert.equal(await reserveCallAppointment("owner", "call-one", start), true);
    blocked = true;
    assert.equal(await reserveCallAppointment("owner", "call-two", start), false);
    assert.equal(statements.filter((sql) => sql.includes("INSERT INTO gloria_booking_holds")).length, 1);
    assert.ok(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock")) < statements.findIndex((sql) => sql.includes("AS busy WHERE")));
    assert.equal(statements.at(-1), "ROLLBACK");
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
import { acquireCampaignCallLock, claimOutboundCall, deferOutboundCall, diagnosePostgresConnection, listOutboundCallsForUser, writeLeadsToPostgres } from "./report-db";

test("the shared queue starts a fifth call but blocks a sixth call", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  let activeCalls = 4;
  let selections = 0;
  const statements: string[] = [];
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("COUNT(*)::text AS count FROM outbound_call_queue")) {
        return { rows: [{ count: String(activeCalls) }], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        selections += 1;
        return { rows: [{
          id: "fifth-call",
          user_id: "test-user",
          payload: { callSource: "manual" },
          report_payload: {},
          request_url: "https://example.test/api/telnyx/test-call",
          created_at: new Date(),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  try {
    assert.equal(MAX_CONCURRENT_OUTBOUND_CALLS, 5);
    assert.equal((await claimOutboundCall())?.id, "fifth-call");
    activeCalls = 5;
    assert.equal(await claimOutboundCall(), null);
    activeCalls = 6;
    assert.equal(await claimOutboundCall(), null);
    assert.equal(selections, 1);
    assert.ok(statements.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))
      < statements.findIndex((sql) => sql.includes("FOR UPDATE SKIP LOCKED")));
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("missing call identities restore reserved campaign leads before queueing", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/FROM users\s+WHERE id = \$1/.test(sql)) {
      return {
        rows: [{ id: "normal", username: "normal", real_name: "", company_name: "Test", password_hash: "test", role: "user" }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  try {
    const { queueOutboundCall } = await import("./outbound-call-queue");
    const request = new Request("https://example.test/api/campaigns/lists");
    const report = { company: "Testfirma", topic: "Beratung" };
    const payload = { to: "+492339555200", company: "Testfirma", topic: "Beratung" };
    await assert.rejects(queueOutboundCall({
      request, report, payload: { ...payload, userId: "normal", leadId: "normal-lead" },
      reservedCampaignLead: true,
    }), /vollständigen Namen/);
    await assert.rejects(queueOutboundCall({
      request, report, payload: { ...payload, leadId: "global-lead" },
      reservedCampaignLead: true,
    }), /keinen zugeordneten Benutzer/);
    await assert.rejects(queueOutboundCall({
      request, report, payload: { ...payload, userId: "normal", leadId: "callback-lead", isCallback: true },
    }), /vollständigen Namen/);

    const restored = statements.filter(({ sql }) => sql.includes("UPDATE gloria_leads SET status = 'neu'"));
    assert.deepEqual(restored.map(({ values }) => values), [
      ["normal-lead", "normal"], ["global-lead", null],
    ]);
    assert.ok(restored.every(({ sql }) => sql.includes("user_id IS NOT DISTINCT FROM $2")));
    assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO outbound_call_queue")), false);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("identity failures while starting queued calls restore only reserved campaign leads", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousSlots = process.env.CAMPAIGN_SLOTS;
  const previousTimezone = process.env.CAMPAIGN_TIMEZONE;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  delete process.env.CAMPAIGN_SLOTS;
  delete process.env.CAMPAIGN_TIMEZONE;
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T10:00:00Z") });
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const rows = [
    { id: "new-global", user_id: null, leadId: "global-lead", reservedCampaignLead: true },
    { id: "old-global", user_id: null, leadId: "old-lead", reservedCampaignLead: undefined },
    { id: "changed-user", user_id: "normal", leadId: "normal-lead", reservedCampaignLead: true },
    { id: "callback", user_id: "normal", leadId: "callback-lead", reservedCampaignLead: false, callSource: "crm" },
  ];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/FROM users\s+WHERE id = \$1/.test(sql)) {
      return {
        rows: [{ id: "normal", username: "normal", real_name: "", company_name: "Test", password_hash: "test", role: "user" }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => {
      if (sql.includes("COUNT(*)::text AS count FROM outbound_call_queue")) {
        return { rows: [{ count: "0" }], rowCount: 1 };
      }
      if (sql.includes("FOR UPDATE SKIP LOCKED")) {
        const row = rows.shift();
        return {
          rows: row ? [{
            id: row.id, user_id: row.user_id,
            payload: {
              to: "+492339555200", company: "Testfirma", topic: "Beratung", leadId: row.leadId,
              userId: row.user_id || undefined, reservedCampaignLead: row.reservedCampaignLead,
              callSource: row.callSource,
            },
            report_payload: {}, request_url: "https://example.test/api/campaigns/lists",
            campaign_lock_token: null, status: "queued", created_at: new Date(), started_at: null,
          }] : [],
          rowCount: row ? 1 : 0,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  try {
    const { processOutboundCallQueue } = await import("./outbound-call-queue");
    assert.deepEqual(await processOutboundCallQueue(), { started: 0 });
    const restored = statements
      .filter(({ sql }) => sql.includes("UPDATE gloria_leads SET status = 'neu'"))
      .map(({ values }) => values)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(restored, [["global-lead", null], ["normal-lead", "normal"], ["old-lead", null]]);
    assert.equal(statements.filter(({ sql }) => sql.includes("SET status = 'failed', error = $2")).length, 4);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousSlots === undefined) delete process.env.CAMPAIGN_SLOTS;
    else process.env.CAMPAIGN_SLOTS = previousSlots;
    if (previousTimezone === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = previousTimezone;
  }
});

test("queue selection pauses campaign jobs at 17:30 and allows them again next morning", async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousSlots = process.env.CAMPAIGN_SLOTS;
  const previousTimezone = process.env.CAMPAIGN_TIMEZONE;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  delete process.env.CAMPAIGN_SLOTS;
  delete process.env.CAMPAIGN_TIMEZONE;
  const selections: Array<{ sql: string; values: unknown[] }> = [];
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-03T16:29:59Z") });
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FOR UPDATE SKIP LOCKED")) selections.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  try {
    for (const timestamp of ["2026-11-03T16:29:59Z", "2026-11-03T16:30:00Z", "2026-11-04T08:00:00Z"]) {
      mock.timers.setTime(Date.parse(timestamp));
      assert.equal(await claimOutboundCall(), null);
    }
    assert.deepEqual(selections.map(({ values }) => values), [[true], [false], [true]]);
    assert.match(selections[0].sql, /\$1::boolean OR/);
    assert.match(selections[0].sql, /campaign_lock_token IS NULL/);
    assert.match(selections[0].sql, /payload->>'callSource', report_payload->>'callSource'/);
    assert.match(selections[0].sql, /<> 'crm'/);
  } finally {
    mock.restoreAll();
    mock.timers.reset();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    if (previousSlots === undefined) delete process.env.CAMPAIGN_SLOTS;
    else process.env.CAMPAIGN_SLOTS = previousSlots;
    if (previousTimezone === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = previousTimezone;
  }
});

test("deferring a call preserves its queued job and never resets an active call", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return { rows: [], rowCount: 0 };
  });
  try {
    await deferOutboundCall("paused-campaign-job");
    const query = queries.find(({ sql }) => sql.includes("SET status = 'queued'"));
    assert.ok(query);
    assert.deepEqual(query.values, ["paused-campaign-job"]);
    assert.match(query.sql, /WHERE id = \$1 AND status = 'starting'/);
    assert.match(query.sql, /started_at = NULL/);
    assert.equal(queries.some(({ sql }) => sql.includes("DELETE FROM campaign_call_locks")), false);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("serverless database pools bound connections and promptly release idle clients", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  let options: Pool["options"] | undefined;
  mock.method(Pool.prototype, "query", async function (this: Pool) {
    options = this.options;
    return { rows: [], rowCount: 0 };
  });
  try {
    assert.match(await diagnosePostgresConnection(), /^Postgres reachable/);
    assert.equal(options?.max, 2);
    assert.equal(options?.idleTimeoutMillis, 1000);
    assert.equal(options?.connectionTimeoutMillis, 5000);
    assert.equal(options?.maxLifetimeSeconds, 60);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("queue diagnostics expose only the current user's campaign lock without its token", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("SELECT locks.acquired_at")) {
      return { rows: [{
        acquired_at: new Date("2026-11-03T13:34:00Z"),
        expires_at: new Date("2026-11-04T13:34:00Z"),
        call_sid: "finished-call",
        queue_status: "completed",
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  try {
    const result = await listOutboundCallsForUser("test-user");
    assert.deepEqual(result.campaignLock, {
      acquiredAt: "2026-11-03T13:34:00.000Z",
      expiresAt: "2026-11-04T13:34:00.000Z",
      callSid: "finished-call",
      queueStatus: "completed",
    });
    const query = queries.find(({ sql }) => sql.includes("SELECT locks.acquired_at"));
    assert.ok(query);
    assert.deepEqual(query.values, ["test-user"]);
    assert.match(query.sql, /WHERE locks\.user_id = \$1 AND locks\.expires_at > NOW\(\)/);
    assert.equal(JSON.stringify(result).includes("lock_token"), false);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("campaign lock acquisition recovers completed calls without releasing pending calls", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return { rows: [], rowCount: sql.includes("INSERT INTO campaign_call_locks") ? 1 : 0 };
  });
  try {
    assert.equal(await acquireCampaignCallLock({
      userId: "test-user",
      leadId: "test-list",
      lockToken: "next-lock",
    }), true);
    const cleanupIndex = queries.findIndex(({ sql }) => sql.includes("DELETE FROM campaign_call_locks AS locks"));
    assert.ok(cleanupIndex >= 0);
    const cleanup = queries[cleanupIndex];
    assert.deepEqual(cleanup.values, ["test-user"]);
    assert.match(cleanup.sql, /locks\.user_id = \$1/);
    assert.match(cleanup.sql, /completed\.status = 'completed'/);
    assert.match(cleanup.sql, /completed\.campaign_lock_token = locks\.lock_token/);
    assert.match(cleanup.sql, /completed\.call_sid = locks\.call_sid/);
    assert.match(cleanup.sql, /AND NOT EXISTS/);
    assert.match(cleanup.sql, /pending\.status IN \('queued', 'starting', 'active'\)/);
    assert.match(cleanup.sql, /pending\.campaign_lock_token = locks\.lock_token/);
    assert.match(cleanup.sql, /pending\.call_sid = locks\.call_sid/);
    assert.ok(queries.findIndex(({ sql }) => sql.includes("INSERT INTO campaign_call_locks")) > cleanupIndex);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("Postgres lead writes use bounded batches and preserve all values in one transaction", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  let released = false;
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  }));
  try {
    const leads: Lead[] = Array.from({ length: 301 }, (_, index) => ({
      id: `lead-${index}`,
      userId: "test-user",
      listId: "crm-search-test",
      company: `Firma ${index}`,
      contactName: "",
      phone: "",
      topic: "",
      status: "neu",
      attempts: index,
      callSource: "crm",
      crmCompanyId: index + 1,
      crmCompanyData: { industry: "Maschinenbau", documents: [{ content: "document-content" }] },
    }));
    assert.equal(await writeLeadsToPostgres(leads, "test-user"), true);
    const inserts = queries.filter(({ sql }) => sql.includes("INSERT INTO gloria_leads"));
    assert.equal(inserts.length, 4);
    assert.deepEqual(inserts.map(({ values }) => values.length), [3500, 3500, 3500, 35]);
    for (const { sql, values } of inserts) {
      const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
      assert.equal(Math.max(...placeholders), values.length);
      assert.equal(placeholders.length, values.length);
    }
    const rows = inserts.flatMap(({ values }) =>
      Array.from({ length: values.length / 35 }, (_, index) => values.slice(index * 35, (index + 1) * 35)),
    );
    assert.deepEqual(rows.map((row) => row[0]), leads.map((lead) => lead.id));
    assert.deepEqual(rows.map((row) => row[29]), leads.map((lead) => lead.attempts));
    assert.equal(rows[0][7], "");
    assert.deepEqual(JSON.parse(String(rows[0][34])), leads[0].crmCompanyData);
    assert.equal(queries[0].sql, "BEGIN");
    assert.match(queries[1].sql, /pg_advisory_xact_lock/);
    assert.deepEqual(queries[2], {
      sql: "DELETE FROM gloria_leads WHERE user_id = $1",
      values: ["test-user"],
    });

    assert.equal(queries.at(-1)?.sql, "COMMIT");
    assert.equal(released, true);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test("a failed Postgres batch rolls back the replacement and releases the connection", async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  const statements: string[] = [];
  let released = false;
  let inserts = 0;
  mock.method(Pool.prototype, "query", async () => ({ rows: [], rowCount: 0 }));
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("INSERT INTO gloria_leads") && ++inserts === 2) {
        throw new Error("test batch write failure");
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  }));
  try {
    const leads: Lead[] = Array.from({ length: 101 }, (_, index) => ({
      id: `rollback-${index}`,
      company: "Fixture GmbH",
      phone: "",
      topic: "",
      status: "neu",
      attempts: 0,
    }));
    assert.equal(await writeLeadsToPostgres(leads, "test-user"), false);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(statements.includes("COMMIT"), false);
    assert.equal(released, true);
  } finally {
    mock.restoreAll();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});
