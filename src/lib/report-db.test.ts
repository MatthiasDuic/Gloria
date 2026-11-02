import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { Pool } from "pg";
import type { Lead } from "./types";
import { writeLeadsToPostgres } from "./report-db";

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
