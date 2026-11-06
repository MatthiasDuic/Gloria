import assert from "node:assert/strict";
import { mock, test } from "node:test";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { Pool } from "pg";
import { globalJobQueue, type Job } from "./job-queue";
import { sendReportEmail } from "./mailer";
import type { CallReport } from "./types";

const report: CallReport = {
  id: "report",
  callSid: "call",
  company: "Testfirma",
  contactName: "Testperson",
  topic: "Beratung",
  summary: "Termin vereinbart.",
  outcome: "Termin",
  conversationDate: "2026-11-05T07:00:00.000Z",
  appointmentAt: "2026-11-12T10:00:00.000Z",
  attempts: 1,
  recordingConsent: false,
  emailedTo: "advisor@example.test",
};

async function withMailFixture(
  run: (sent: () => SendMailOptions[], leadWrites: unknown[][], setLeadEmail: (email?: string) => void) => Promise<void>,
) {
  const previous = {
    DATABASE_URL: process.env.DATABASE_URL,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    REPORT_TO_EMAIL: process.env.REPORT_TO_EMAIL,
    CRON_SECRET: process.env.CRON_SECRET,
    APP_INTERNAL_TOKEN: process.env.APP_INTERNAL_TOKEN,
  };
  process.env.DATABASE_URL = "postgres://localhost/gloria-test";
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_USER = "test-user";
  process.env.SMTP_PASS = "test-password";
  process.env.REPORT_TO_EMAIL = "advisor@example.test";
  process.env.CRON_SECRET = "test-cron";
  process.env.APP_INTERNAL_TOKEN = "test-internal";
  let leadEmail: string | undefined;
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (/FROM users\s+WHERE id = \$1/.test(sql)) {
      const id = String(values[0]);
      const role = id === "master" ? "master" : id === "normal" ? "user" : undefined;
      return {
        rows: role ? [{
          id, username: id, real_name: "Erika Mustermann", company_name: "Testagentur",
          password_hash: "test", role, created_at: "2026-01-01T00:00:00.000Z",
        }] : [],
        rowCount: role ? 1 : 0,
      };
    }
    if (/FROM gloria_leads\s+WHERE user_id = \$1/.test(sql)) {
      return {
        rows: [{
          id: "lead", user_id: String(values[0]), company: "Testfirma", contact_name: "Testperson",
          phone: "+492339555100", email: leadEmail, topic: "Beratung", status: "neu", attempts: 0,
          call_source: "crm", email_history: [],
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const leadWrites: unknown[][] = [];
  mock.method(Pool.prototype, "connect", async () => ({
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("INSERT INTO gloria_leads")) leadWrites.push(values);
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  }));
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const sendMail = transport.sendMail.bind(transport);
  const sentMessages: SendMailOptions[] = [];
  mock.method(transport, "sendMail", async (message: SendMailOptions) => {
    sentMessages.push({ ...message });
    return sendMail(message);
  });
  mock.method(nodemailer, "createTransport", () => transport);
  try {
    await run(() => sentMessages, leadWrites, (email) => { leadEmail = email; });
  } finally {
    mock.restoreAll();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("internal reports are sent only to the advisor", async () => {
  await withMailFixture(async (sent) => {
    assert.equal((await sendReportEmail({ ...report, userId: "normal" })).delivered, true);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].to, "advisor@example.test");
    assert.equal(sent()[0].icalEvent, undefined);
  });
});

test("SMTP transport selects implicit TLS on port 465 and STARTTLS on other ports", async () => {
  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_PORT: process.env.SMTP_PORT,
  };
  process.env.SMTP_HOST = "smtp.example.test";
  process.env.SMTP_USER = "test-user";
  process.env.SMTP_PASS = "test-password";
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const configurations: unknown[] = [];
  mock.method(nodemailer, "createTransport", (options) => {
    configurations.push(options);
    return transport;
  });
  try {
    for (const port of ["465", "587", "2525"]) {
      process.env.SMTP_PORT = port;
      assert.equal((await sendReportEmail(report)).delivered, true);
    }

    assert.deepEqual(configurations.map((options) => {
      assert.ok(options && typeof options === "object");
      return {
        port: "port" in options ? options.port : undefined,
        secure: "secure" in options ? options.secure : undefined,
        requireTLS: "requireTLS" in options ? options.requireTLS : undefined,
      };
    }), [
      { port: 465, secure: true, requireTLS: false },
      { port: 587, secure: false, requireTLS: true },
      { port: 2525, secure: false, requireTLS: true },
    ]);

    process.env.SMTP_PORT = "not-a-port";
    await assert.rejects(sendReportEmail(report), /SMTP_PORT muss eine gültige Portnummer/);
  } finally {
    mock.restoreAll();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the call webhook never queues a customer mail and hands the spoken address to the user", async () => {
  await withMailFixture(async (sent, leadWrites) => {
    const enqueue = mock.method(globalJobQueue, "enqueue", async (type) => `${type}-job`);
    const { POST } = await import("../app/api/calls/webhook/route");
    const appointmentAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    for (const [userId, spokenEmail, expectedEmail] of [
      ["normal", "Ja, meine Adresse ist kunde@example.test.", "kunde@example.test"],
      ["master", "Die Adresse lautet anna punkt muster at beispiel punkt de. Vielen Dank.", "anna.muster@beispiel.de"],
      ["master", "Meine Adresse ist m a x at b e i s p i e l punkt d e.", "max@beispiel.de"],
      ["master", "Bitte an kunde@beispiel.xn--p1ai senden.", "kunde@beispiel.xn--p1ai"],
    ]) {
      const writesBefore = leadWrites.length;
      const response = await POST(new Request("https://example.test/api/calls/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gloria-internal-token": "test-internal" },
        body: JSON.stringify({
          callSid: `call-${enqueue.mock.callCount()}`, userId, leadId: "lead", callSource: "crm",
          company: "Testfirma", topic: "Beratung", summary: "Termin vereinbart.", outcome: "Termin",
          appointmentAt, appointmentMode: "Microsoft Teams",
          transcript: [
            { role: "assistant", text: "Damit Herr Duic Ihnen die Terminbestätigung per E-Mail zusenden kann, brauche ich noch Ihre E-Mail-Adresse." },
            { role: "user", text: spokenEmail },
          ],
        }),
      }));
      assert.equal(response.status, 200);
      const body = await response.json() as { confirmationEmail?: string; report: CallReport };
      assert.equal(body.confirmationEmail, expectedEmail);
      assert.match(body.report.summary, new RegExp(`E-Mail für die Terminbestätigung: ${expectedEmail.replace(/[.+-]/g, "\\$&")}`));
      assert.ok(leadWrites.slice(writesBefore).some((values) => values.includes(expectedEmail)));
    }
    assert.deepEqual(enqueue.mock.calls.map((call) => call.arguments[0]), ["send_email", "send_email", "send_email", "send_email"]);
    assert.equal(sent().length, 0);
  });
});

test("an existing lead address is never overwritten by the spoken address", async () => {
  await withMailFixture(async (_sent, leadWrites, setLeadEmail) => {
    setLeadEmail("info@testfirma.example");
    mock.method(globalJobQueue, "enqueue", async (type) => `${type}-job`);
    const { POST } = await import("../app/api/calls/webhook/route");
    const response = await POST(new Request("https://example.test/api/calls/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-gloria-internal-token": "test-internal" },
      body: JSON.stringify({
        callSid: "call-existing-email", userId: "normal", leadId: "lead", callSource: "crm",
        company: "Testfirma", topic: "Beratung", summary: "Termin vereinbart.", outcome: "Termin",
        appointmentAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        transcript: [
          { role: "assistant", text: "Ich brauche noch Ihre E-Mail-Adresse." },
          { role: "user", text: "kunde@example.test" },
        ],
      }),
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { report: CallReport };
    assert.match(body.report.summary, /E-Mail für die Terminbestätigung: kunde@example\.test/);
    assert.ok(leadWrites.every((values) => !values.includes("kunde@example.test")));
  });
});

function mockJobProcessing(job: Job) {
  mock.method(globalJobQueue, "dequeue", async () => job);
  const success = mock.method(globalJobQueue, "markSuccess", async () => undefined);
  const failure = mock.method(globalJobQueue, "markFailure", async () => undefined);
  mock.method(globalJobQueue, "getStats", async () => ({ pending: 0, processing: 0, completed: 1, failed: 0 }));
  return { success, failure };
}

async function processOneJob() {
  const { POST } = await import("../app/api/jobs/process/route");
  return POST(new Request("https://example.test/api/jobs/process", {
    method: "POST",
    headers: { authorization: "Bearer test-cron", "content-type": "application/json" },
    body: JSON.stringify({ maxJobs: 1 }),
  }));
}

test("already queued legacy customer invitations are discarded without sending", async () => {
  await withMailFixture(async (sent, leadWrites) => {
    const job = {
      id: "old-invite", type: "send_invite", callSid: "call",
      payload: { report: { ...report, userId: "master", leadId: "lead" }, attendeeEmail: "customer@example.test" },
      createdAt: Date.now(), attempts: 1, status: "processing",
    } as unknown as Job;
    const { success, failure } = mockJobProcessing(job);
    const response = await processOneJob();
    assert.equal(response.status, 200);
    const body = await response.json() as { processed: number; failed: number };
    assert.equal(body.processed, 1);
    assert.equal(body.failed, 0);
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(sent().length, 0);
    assert.equal(leadWrites.length, 0);
  });
});

test("queued internal report mails are still delivered to the advisor", async () => {
  await withMailFixture(async (sent) => {
    const job: Job = {
      id: "report-mail", type: "send_email", callSid: "call",
      payload: { report: { ...report, userId: "master" } },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    await processOneJob();
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].to, "advisor@example.test");
  });
});

test("booking a report never claims a confirmation was already sent", async () => {
  await withMailFixture(async (sent, leadWrites) => {
    const { storeCallReport } = await import("./storage");
    await storeCallReport({
      userId: "normal", leadId: "lead", company: "Testfirma", topic: "Beratung", outcome: "Termin",
    });
    assert.equal(sent().length, 0);
    assert.equal(leadWrites.length, 1);
    assert.deepEqual(JSON.parse(String(leadWrites[0][21])), []);
  });
});
