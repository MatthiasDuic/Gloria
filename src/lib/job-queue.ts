import * as fs from "node:fs";
import * as path from "node:path";

export type JobType = "extract_report" | "send_email" | "send_invite";

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
  private queueFilePath: string;
  private readonly MAX_ATTEMPTS = 5;
  private readonly RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000]; // 5s, 15s, 30s, 1m, 2m

  constructor() {
    const tempDir = process.env.TEMP_DIR || "/tmp";
    this.queueFilePath = path.join(tempDir, "gloria-job-queue.json");
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.queueFilePath)) {
        const data = fs.readFileSync(this.queueFilePath, "utf-8");
        const jobs: Job[] = JSON.parse(data);
        for (const job of jobs) {
          if (job.status === "pending" || job.status === "processing") {
            this.queue.set(job.id, job);
          }
        }
        console.info("[job-queue] Loaded from disk", { count: this.queue.size });
      }
    } catch (error) {
      console.error("[job-queue] Load failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private saveToDisk(): void {
    try {
      const jobs = Array.from(this.queue.values());
      fs.writeFileSync(this.queueFilePath, JSON.stringify(jobs, null, 2), "utf-8");
    } catch (error) {
      console.error("[job-queue] Save failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  enqueue(type: JobType, callSid: string, payload: Record<string, unknown>): string {
    const id = `${callSid}:${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
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
    this.saveToDisk();

    console.info("[job-queue] Enqueued", {
      jobId: id,
      type,
      callSid,
      queueSize: this.queue.size,
    });

    return id;
  }

  dequeue(): Job | null {
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

  markSuccess(jobId: string): void {
    const job = this.queue.get(jobId);
    if (!job) return;

    job.status = "completed";
    job.error = undefined;
    this.processingSet.delete(jobId);
    this.saveToDisk();

    console.info("[job-queue] Completed", {
      jobId,
      type: job.type,
      callSid: job.callSid,
      attempts: job.attempts,
    });
  }

  markFailure(jobId: string, error: Error | string): void {
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

    this.saveToDisk();
  }

  getStats(): {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  } {
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

  getAllJobs(): Job[] {
    return Array.from(this.queue.values());
  }
}

export const globalJobQueue = new JobQueue();
