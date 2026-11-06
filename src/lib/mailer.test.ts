import assert from "node:assert/strict";
import { mock, test } from "node:test";
import nodemailer, { type SendMailOptions } from "nodemailer";
import { Pool } from "pg";
import { enqueueAppointmentConfirmation } from "./appointment-confirmation";
import { globalJobQueue, type Job } from "./job-queue";
import { sendAppointmentInvite, sendReportEmail } from "./mailer";
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
  run: (
    sent: () => SendMailOptions[],
    leadWrites: unknown[][],
    rejectRecipient: (address: string) => void,
    setMasterLookupRoles: (roles: Array<"master" | "user">) => void,
    transcriptReads: string[],
  ) => Promise<void>,
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
  let masterLookupRoles: Array<"master" | "user"> = [];
  const transcriptReads: string[] = [];
  mock.method(Pool.prototype, "query", async (sql: string, values: unknown[] = []) => {
    if (/FROM\s+call_transcript_events\b/.test(sql)) transcriptReads.push(sql);
    if (/FROM users\s+WHERE id = \$1/.test(sql)) {
      const id = String(values[0]);
      const role = id === "master" ? masterLookupRoles.shift() || "master" : id === "normal" ? "user" : undefined;
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
          phone: "+492339555100", topic: "Beratung", status: "neu", attempts: 0,
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
  const rejectedRecipients = new Set<string>();
  const sentMessages: SendMailOptions[] = [];
  mock.method(transport, "sendMail", async (message: SendMailOptions) => {
    sentMessages.push({ ...message, attachments: message.attachments?.map((attachment) => ({ ...attachment })) });
    const info = await sendMail(message);
    return {
      ...info,
      accepted: info.envelope.to.filter((address) => !rejectedRecipients.has(address.toLowerCase())),
      rejected: info.envelope.to.filter((address) => rejectedRecipients.has(address.toLowerCase())),
    };
  });
  mock.method(nodemailer, "createTransport", () => transport);
  try {
    await run(
      () => sentMessages,
      leadWrites,
      (address) => rejectedRecipients.add(address.toLowerCase()),
      (roles) => { masterLookupRoles = [...roles]; },
      transcriptReads,
    );
  } finally {
    mock.restoreAll();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("normal users never send a customer appointment confirmation, but internal reports still work", async () => {
  await withMailFixture(async (sent) => {
    const normalReport = { ...report, userId: "normal", appointmentMode: "Beim Kunden vor Ort" };
    const result = await sendAppointmentInvite({
      report: normalReport, attendeeEmail: "customer@example.test", appointmentPdf: Buffer.alloc(1001),
    });
    assert.equal(result.delivered, false);
    assert.equal(sent().length, 0);

    assert.equal((await sendReportEmail(normalReport)).delivered, true);
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].to, "advisor@example.test");
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

test("master confirmations describe the appointment and when the digital link arrives", async () => {
  await withMailFixture(async (sent) => {
    for (const appointmentMode of ["Beim Kunden vor Ort", "Microsoft Teams"]) {
      const result = await sendAppointmentInvite({
        report: { ...report, userId: "master", appointmentMode },
        attendeeEmail: "customer@example.test",
        appointmentPdf: Buffer.alloc(1001),
      });
      assert.equal(result.delivered, true);
    }

    assert.equal(sent().length, 2);
    assert.match(String(sent()[0].text), /Termin.*best[aä]tigt/i);
    assert.match(String(sent()[0].text), /Beim Kunden vor Ort/);
    assert.doesNotMatch(String(sent()[0].text), /Link/i);
    assert.match(String(sent()[1].text), /Microsoft Teams/);
    assert.match(String(sent()[1].text), /Link.*einen Tag vor dem Termin/i);
  });
});

test("an appointment without a known owner cannot send a confirmation", async () => {
  await withMailFixture(async (sent) => {
    await assert.rejects(
      sendAppointmentInvite({ report, attendeeEmail: "customer@example.test", appointmentPdf: Buffer.alloc(1001) }),
      /Benutzer/i,
    );
    await assert.rejects(
      sendAppointmentInvite({ report: { ...report, userId: "missing" }, attendeeEmail: "customer@example.test", appointmentPdf: Buffer.alloc(1001) }),
      /Benutzer/i,
    );
    assert.equal(sent().length, 0);
  });
});

test("master confirmations require a valid customer address", async () => {
  await withMailFixture(async (sent) => {
    for (const attendeeEmail of [undefined, "invalid-address", "customer@example.test,other@example.test"]) {
      const result = await sendAppointmentInvite({
        report: { ...report, userId: "master" }, attendeeEmail, appointmentPdf: Buffer.alloc(1001),
      });
      assert.equal(result.delivered, false);
      assert.match(result.reason || "", /Kunden-E-Mail-Adresse/);
    }
    assert.equal(sent().length, 0);
  });
});

test("only master appointments are queued for automatic confirmation", async () => {
  await withMailFixture(async (sent) => {
    const enqueue = mock.method(globalJobQueue, "enqueue", async () => "test-job");
    const manual = await enqueueAppointmentConfirmation({ ...report, userId: "normal" }, "customer@example.test");
    assert.match(manual.reason, /manuell/);
    assert.equal(enqueue.mock.callCount(), 0);

    const automatic = await enqueueAppointmentConfirmation({ ...report, userId: "master" }, "customer@example.test");
    assert.match(automatic.reason, /test-job/);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(enqueue.mock.calls[0].arguments[0], "send_invite");
    await assert.rejects(enqueueAppointmentConfirmation({ ...report, userId: "missing" }), /Benutzer/i);
    assert.equal(enqueue.mock.callCount(), 1);
    assert.equal(sent().length, 0);
  });
});

test("the call webhook queues a customer confirmation only for the master user", async () => {
  await withMailFixture(async () => {
    const enqueue = mock.method(globalJobQueue, "enqueue", async (type) => `${type}-job`);
    const { POST } = await import("../app/api/calls/webhook/route");
    const appointmentAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    for (const [userId, spokenEmail, expectedEmail] of [
      ["normal", "Ja, meine Adresse ist kunde@example.test.", undefined],
      ["master", "Ja, meine Adresse ist kunde@example.test.", "kunde@example.test"],
      ["master", "Die Adresse lautet anna punkt muster at beispiel punkt de. Vielen Dank.", "anna.muster@beispiel.de"],
      ["master", "Meine Adresse ist m a x at b e i s p i e l punkt d e.", "max@beispiel.de"],
      ["master", "Bitte an kunde@beispiel.xn--p1ai senden.", "kunde@beispiel.xn--p1ai"],
    ]) {
      const response = await POST(new Request("https://example.test/api/calls/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-gloria-internal-token": "test-internal" },
        body: JSON.stringify({
          callSid: `call-${enqueue.mock.callCount()}`, userId, callSource: "manual",
          company: "Testfirma", topic: "Beratung", summary: "Termin vereinbart.", outcome: "Termin",
          appointmentAt, appointmentMode: "Microsoft Teams",
          transcript: [
            { role: "assistant", text: "Für die Terminbestätigung brauche ich noch Ihre E-Mail-Adresse." },
            { role: "user", text: spokenEmail },
          ],
        }),
      }));
      assert.equal(response.status, 200);
      const calls = enqueue.mock.calls.map((call) => call.arguments);
      const latest = calls.at(-1);
      if (userId === "normal") {
        assert.deepEqual(calls.map(([type]) => type), ["send_email"]);
      } else {
        assert.equal(latest?.[0], "send_invite");
        assert.equal(latest?.[2].attendeeEmail, expectedEmail);
      }
    }
    assert.deepEqual(enqueue.mock.calls.map((call) => call.arguments[0]), [
      "send_email", "send_email", "send_invite", "send_email", "send_invite", "send_email", "send_invite",
      "send_email", "send_invite",
    ]);
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

test("an already queued normal-user invitation is skipped without sending", async () => {
  await withMailFixture(async (sent, leadWrites) => {
    const job: Job = {
      id: "old-invite", type: "send_invite", callSid: "call",
      payload: { report: { ...report, userId: "normal", leadId: "lead" } },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
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

test("the role is checked again immediately before sending a queued invitation", async () => {
  await withMailFixture(async (sent, leadWrites, _rejectRecipient, setMasterLookupRoles) => {
    setMasterLookupRoles(["master", "user"]);
    const job: Job = {
      id: "downgraded-invite", type: "send_invite", callSid: "call",
      payload: {
        report: { ...report, userId: "master", leadId: "lead" },
        attendeeEmail: "customer@example.test",
      },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    const response = await processOneJob();
    assert.equal(response.status, 200);
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(sent().length, 0);
    assert.equal(leadWrites.length, 0);
  });
});

test("a successful master invitation is recorded only after the email was sent", async () => {
  await withMailFixture(async (sent, leadWrites) => {
    const job: Job = {
      id: "master-invite", type: "send_invite", callSid: "call",
      payload: {
        report: { ...report, userId: "master", leadId: "lead", appointmentMode: "Microsoft Teams" },
        attendeeEmail: "customer@example.test",
      },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    const response = await processOneJob();
    assert.equal(response.status, 200);
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(sent().length, 1);
    assert.equal(leadWrites.length, 1);
    const history = JSON.parse(String(leadWrites[0][21])) as Array<{ source: string; to: string }>;
    assert.deepEqual(history.map(({ source, to }) => ({ source, to })), [
      { source: "gloria", to: "customer@example.test" },
    ]);
  });
});

test("a customer rejected by SMTP is not recorded as sent", async () => {
  await withMailFixture(async (sent, leadWrites, rejectRecipient) => {
    rejectRecipient("customer@example.test");
    const job: Job = {
      id: "rejected-invite", type: "send_invite", callSid: "call",
      payload: {
        report: { ...report, userId: "master", leadId: "lead", appointmentMode: "Microsoft Teams" },
        attendeeEmail: "customer@example.test",
      },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    const response = await processOneJob();
    const body = await response.json() as { processed: number; failed: number };
    assert.equal(body.processed, 0);
    assert.equal(body.failed, 1);
    assert.equal(success.mock.callCount(), 0);
    assert.equal(failure.mock.callCount(), 1);
    assert.equal(sent().length, 1);
    assert.equal(leadWrites.length, 0);
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

test("non-PKV confirmations send their calendar without a PDF, including stale queued attachments", async () => {
  await withMailFixture(async (sent) => {
    for (const topic of ["betriebliche Krankenversicherung", "Meine PKV-Kampagne"]) {
      for (const appointmentPdf of [undefined, Buffer.alloc(1001)]) {
        const result = await sendAppointmentInvite({
          report: { ...report, topic, userId: "master" }, attendeeEmail: "customer@example.test", appointmentPdf,
        });
        assert.equal(result.delivered, true);
        const mail = sent().at(-1)!;
        assert.equal(mail.attachments?.length, 1);
        assert.equal(mail.attachments?.[0].contentType, "text/calendar; method=REQUEST; charset=UTF-8");
        assert.doesNotMatch(String(mail.text), /Kundenterminbogen/);
      }
    }
  });
});

test("PKV confirmations still require a complete PDF", async () => {
  await withMailFixture(async (sent) => {
    for (const appointmentPdf of [undefined, Buffer.alloc(999), Buffer.alloc(1001)]) {
      const result = await sendAppointmentInvite({
        report: { ...report, topic: "private Krankenversicherung", userId: "master" },
        attendeeEmail: "customer@example.test", appointmentPdf,
      });
      assert.equal(result.delivered, Boolean(appointmentPdf && appointmentPdf.length >= 1000));
    }
    assert.equal(sent().length, 1);
    assert.equal(sent()[0].attachments?.length, 2);
  });
});

test("queued non-PKV invitations never load transcripts or generate a PDF", async () => {
  await withMailFixture(async (sent, _leadWrites, _rejectRecipient, _setMasterLookupRoles, transcriptReads) => {
    const job: Job = {
      id: "no-pdf", type: "send_invite", callSid: "call",
      payload: { report: { ...report, userId: "master", topic: "betriebliche Krankenversicherung" }, attendeeEmail: "customer@example.test" },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    await processOneJob();
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(sent()[0].attachments?.length, 1);
    assert.equal(transcriptReads.length, 0);
  });
});

test("queued PKV invitations load the transcript and attach a complete PDF", async () => {
  await withMailFixture(async (sent, _leadWrites, _rejectRecipient, _setMasterLookupRoles, transcriptReads) => {
    const job: Job = {
      id: "pkv-pdf", type: "send_invite", callSid: "call",
      payload: { report: { ...report, userId: "master", topic: "private Krankenversicherung" }, attendeeEmail: "customer@example.test" },
      createdAt: Date.now(), attempts: 1, status: "processing",
    };
    const { success, failure } = mockJobProcessing(job);
    await processOneJob();
    assert.equal(success.mock.callCount(), 1);
    assert.equal(failure.mock.callCount(), 0);
    assert.equal(transcriptReads.length, 1);
    const pdf = sent()[0].attachments?.find((entry) => entry.contentType === "application/pdf")?.content;
    assert.ok(Buffer.isBuffer(pdf));
    assert.ok(pdf.length >= 1000);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });
});
