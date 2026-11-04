import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool } from "pg";
import type { Lead } from "./types";
import { MAX_CONCURRENT_OUTBOUND_CALLS } from "./outbound-call-queue-constants";
import { reserveCallAppointment } from "./report-db";
import { globalJobQueue } from "./job-queue";
import { isDoNotCallRequest, isPhoneNumberSuppressed, suppressPhoneNumber } from "./call-safety";

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
