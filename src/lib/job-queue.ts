import { getDatabasePool, isDatabaseUrlConfigured } from "./report-db";
import type { Pool } from "pg";

export type JobType = "send_email";

export interface Job {
  id: string;
  type: JobType;
  callSid: string;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextRetryAt?: number;
  error?: string;
  status: "pending" | "processing" | "completed" | "failed";
}

class JobQueue {
  private queue: Map<string, Job> = new Map();
  private processingSet: Set<string> = new Set();
  private schemaReady: Promise<void> | null = null;
  private readonly MAX_ATTEMPTS = 5;
  private readonly RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000]; // 5s, 15s, 30s, 1m, 2m

  private async database(): Promise<Pool | null> {
    if (!isDatabaseUrlConfigured()) {
      if (process.env.VERCEL) throw new Error("Durable jobs require PostgreSQL.");
      return null;
    }
    const database = await getDatabasePool();
    if (!this.schemaReady) {
      this.schemaReady = database.query(`CREATE TABLE IF NOT EXISTS gloria_background_jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, call_sid TEXT NOT NULL,
        payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', next_retry_at TIMESTAMPTZ, error TEXT
      )`).then(() => undefined).catch((error) => { this.schemaReady = null; throw error; });
    }
    await this.schemaReady;
    return database;
  }

  async enqueue(type: JobType, callSid: string, payload: Record<string, unknown>): Promise<string> {
    const id = `${callSid}:${type}`;
    const database = await this.database();
    if (database) {
      await database.query(`INSERT INTO gloria_background_jobs (id,type,call_sid,payload)
        VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = NOW(),
          status = CASE WHEN gloria_background_jobs.status = 'failed' THEN 'pending' ELSE gloria_background_jobs.status END,
          attempts = CASE WHEN gloria_background_jobs.status = 'failed' THEN 0 ELSE gloria_background_jobs.attempts END,
          next_retry_at = CASE WHEN gloria_background_jobs.status = 'failed' THEN NOW() ELSE gloria_background_jobs.next_retry_at END
        WHERE gloria_background_jobs.status = 'pending'
           OR (gloria_background_jobs.status = 'failed' AND gloria_background_jobs.payload IS DISTINCT FROM EXCLUDED.payload)`, [id,type,callSid,JSON.stringify(payload)]);
      return id;
    }
    const existing = this.queue.get(id);
    if (existing) {
      if (existing.status === "pending") existing.payload = payload;
      return id;
    }
    const job: Job = {
      id,
      type,
      callSid,
      payload,
      createdAt: Date.now(),
      attempts: 0,
      status: "pending",
    };

    this.queue.set(id, job);

    console.info("[job-queue] Enqueued", {
      jobId: id,
      type,
      callSid,
      queueSize: this.queue.size,
    });

    return id;
  }

  async dequeue(): Promise<Job | null> {
    const database = await this.database();
    if (database) {
      const result = await database.query(`UPDATE gloria_background_jobs SET
        status = 'processing', attempts = attempts + 1, updated_at = NOW()
        WHERE id = (SELECT id FROM gloria_background_jobs
          WHERE (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= NOW()))
             OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id,type,call_sid,payload,created_at,attempts,status`);
      const row = result.rows[0];
      return row ? { id: row.id, type: row.type, callSid: row.call_sid, payload: row.payload,
        createdAt: new Date(row.created_at).getTime(), attempts: row.attempts, status: row.status } : null;
    }
    const now = Date.now();
    for (const [id, job] of this.queue.entries()) {
      if (this.processingSet.has(id)) continue;
      if (job.status !== "pending") continue;
      if (job.nextRetryAt && job.nextRetryAt > now) continue;

      this.processingSet.add(id);
      job.status = "processing";
      job.attempts += 1;
      return job;
    }
    return null;
  }

  async markSuccess(jobId: string): Promise<void> {
    const database = await this.database();
    if (database) {
      await database.query("UPDATE gloria_background_jobs SET status = 'completed', error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'processing'", [jobId]);
      return;
    }
    const job = this.queue.get(jobId);
    if (!job) return;

    job.status = "completed";
    job.error = undefined;
    this.processingSet.delete(jobId);

    console.info("[job-queue] Completed", {
      jobId,
      type: job.type,
      callSid: job.callSid,
      attempts: job.attempts,
    });
  }

  async markFailure(jobId: string, error: Error | string): Promise<void> {
    const database = await this.database();
    if (database) {
      await database.query(`UPDATE gloria_background_jobs SET
        status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        error = $2, next_retry_at = NOW() + (LEAST(120000, 5000 * POWER(3, attempts - 1)) * INTERVAL '1 millisecond'),
        updated_at = NOW() WHERE id = $1 AND status = 'processing'`, [jobId, String(error).slice(0,1000)]);
      return;
    }
    const job = this.queue.get(jobId);
    if (!job) return;

    job.error = error instanceof Error ? error.message : String(error);
    this.processingSet.delete(jobId);

    if (job.attempts >= this.MAX_ATTEMPTS) {
      job.status = "failed";
      console.error("[job-queue] Failed (max attempts)", {
        jobId,
        type: job.type,
        callSid: job.callSid,
        attempts: job.attempts,
        error: job.error,
      });
    } else {
      job.status = "pending";
      const delayMs = this.RETRY_DELAYS_MS[job.attempts - 1] || this.RETRY_DELAYS_MS[this.RETRY_DELAYS_MS.length - 1];
      job.nextRetryAt = Date.now() + delayMs;
      console.info("[job-queue] Will retry", {
        jobId,
        type: job.type,
        callSid: job.callSid,
        attempts: job.attempts,
        retryAfterMs: delayMs,
        error: job.error,
      });
    }

  }

  async getStats(): Promise<{
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  }> {
    const database = await this.database();
    if (database) {
      const result = await database.query("SELECT status, COUNT(*)::integer AS count FROM gloria_background_jobs GROUP BY status");
      const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
      for (const row of result.rows) if (row.status in stats) stats[row.status as keyof typeof stats] = row.count;
      return stats;
    }
    let pending = 0,
      processing = 0,
      completed = 0,
      failed = 0;
    for (const job of this.queue.values()) {
      if (job.status === "pending") pending++;
      else if (job.status === "processing") processing++;
      else if (job.status === "completed") completed++;
      else if (job.status === "failed") failed++;
    }
    return { pending, processing, completed, failed };
  }

  async getAllJobs(): Promise<Job[]> {
    const database = await this.database();
    if (database) return [];
    return Array.from(this.queue.values());
  }
}

export const globalJobQueue = new JobQueue();
