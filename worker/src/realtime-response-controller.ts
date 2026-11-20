export type ResponseTimer = ReturnType<typeof setTimeout>;
export type ResponseTimeoutPhase = "creation" | "generation";

function normalizeInstruction(instr: string): string {
  return instr.trim().replace(/\s+/g, " ").toLowerCase();
}

export type RealtimeResponseControllerOptions = {
  sendResponse: (instructions: string) => boolean;
  isPlaybackPending: () => boolean;
  onDeferred?: (details: { instructions: string; active: boolean; playbackPending: boolean; delayMs: number }) => void;
  cooldownMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ResponseTimer;
  cancelSchedule?: (timer: ResponseTimer) => void;
  onTimeout?: (phase: ResponseTimeoutPhase) => void;
  creationTimeoutMs?: number;
  generationTimeoutMs?: number;
};

export class RealtimeResponseController {
  private readonly sendResponse: (instructions: string) => boolean;
  private readonly isPlaybackPending: () => boolean;
  private readonly onDeferred?: RealtimeResponseControllerOptions["onDeferred"];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => ResponseTimer;
  private readonly cancelSchedule: (timer: ResponseTimer) => void;
  private readonly onTimeout?: (phase: ResponseTimeoutPhase) => void;
  private readonly creationTimeoutMs: number;
  private readonly generationTimeoutMs: number;
  private active = false;
  private queuedInstructions: string | null = null;
  private lastSentInstruction: string | null = null;
  private createNotBefore = 0;
  private flushTimer: ResponseTimer | null = null;
  private responseTimer: ResponseTimer | null = null;
  private stopped = false;

  constructor(options: RealtimeResponseControllerOptions) {
    this.sendResponse = options.sendResponse;
    this.isPlaybackPending = options.isPlaybackPending;
    this.onDeferred = options.onDeferred;
    this.cooldownMs = options.cooldownMs ?? 100;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
    this.onTimeout = options.onTimeout;
    this.creationTimeoutMs = options.creationTimeoutMs ?? 12_000;
    this.generationTimeoutMs = options.generationTimeoutMs ?? 60_000;
  }

  isActive(): boolean {
    return this.active;
  }

  request(instructions: string): boolean {
    if (this.stopped) return false;

    // Deduplication: skip if same instruction is already queued or just sent
    const normalizedInstruction = normalizeInstruction(instructions);
    const queuedInstruction = this.queuedInstructions === null ? null : normalizeInstruction(this.queuedInstructions);
    if (normalizedInstruction === this.lastSentInstruction || normalizedInstruction === queuedInstruction) {
      return false; // Skip duplicate
    }

    const delayMs = Math.max(0, this.createNotBefore - this.now());
    const playbackPending = this.isPlaybackPending();
    if (this.active || playbackPending || delayMs > 0) {
      if (this.queuedInstructions === null) this.queuedInstructions = instructions;
      this.onDeferred?.({ instructions, active: this.active, playbackPending, delayMs });
      if (!this.active) this.scheduleFlush(Math.max(20, delayMs));
      return false;
    }
    const sent = this.sendResponse(instructions);
    if (sent) {
      this.lastSentInstruction = normalizedInstruction;
      // response.created arrives asynchronously; reserve the response slot now.
      this.active = true;
      this.scheduleResponseTimeout("creation", this.creationTimeoutMs);
    }
    return sent;
  }

  markCreated(): void {
    if (this.stopped) return;
    this.active = true;
    this.scheduleResponseTimeout("generation", this.generationTimeoutMs);
  }

  markFinished(): void {
    if (this.stopped) return;
    this.active = false;
    this.clearResponseTimeout();
    this.createNotBefore = this.now() + this.cooldownMs;
    this.flush();
  }

  markCancelled(): void {
    if (this.stopped) return;
    this.active = false;
    this.clearResponseTimeout();
    this.flush();
  }

  markInterruptRequested(): void {
    if (this.stopped) return;
    this.queuedInstructions = null;
    if (this.flushTimer) this.cancelSchedule(this.flushTimer);
    this.flushTimer = null;
  }

  flush(): void {
    if (this.stopped || this.active || this.queuedInstructions === null) return;
    if (this.isPlaybackPending()) {
      this.scheduleFlush(20);
      return;
    }
    const instructions = this.queuedInstructions;
    this.queuedInstructions = null;
    this.request(instructions);
  }

  stop(): void {
    this.stopped = true;
    this.active = false;
    this.queuedInstructions = null;
    if (this.flushTimer) this.cancelSchedule(this.flushTimer);
    this.flushTimer = null;
    this.clearResponseTimeout();
  }

  /** Reset after user speaks so same instruction can be re-sent for next turn. */
  clearLastInstruction(): void {
    this.lastSentInstruction = null;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }

  private scheduleResponseTimeout(phase: ResponseTimeoutPhase, delayMs: number): void {
    this.clearResponseTimeout();
    this.responseTimer = this.schedule(() => {
      this.responseTimer = null;
      if (!this.stopped && this.active) this.onTimeout?.(phase);
    }, delayMs);
  }

  private clearResponseTimeout(): void {
    if (this.responseTimer) this.cancelSchedule(this.responseTimer);
    this.responseTimer = null;
  }
}