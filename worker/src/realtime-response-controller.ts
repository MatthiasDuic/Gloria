export type ResponseTimer = ReturnType<typeof setTimeout>;

function hashInstruction(instr: string): string {
  // Simple hash based on first 50 chars + word count + key phrases
  // Prevents duplicate questions from being queued multiple times
  const trimmed = instr.slice(0, 100).toLowerCase();
  const wordCount = instr.split(/\s+/).length;
  return `${trimmed}|${wordCount}`;
}

export type RealtimeResponseControllerOptions = {
  sendResponse: (instructions: string) => boolean;
  isPlaybackPending: () => boolean;
  onDeferred?: (details: { instructions: string; active: boolean; playbackPending: boolean; delayMs: number }) => void;
  cooldownMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ResponseTimer;
  cancelSchedule?: (timer: ResponseTimer) => void;
};

export class RealtimeResponseController {
  private readonly sendResponse: (instructions: string) => boolean;
  private readonly isPlaybackPending: () => boolean;
  private readonly onDeferred?: RealtimeResponseControllerOptions["onDeferred"];
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => ResponseTimer;
  private readonly cancelSchedule: (timer: ResponseTimer) => void;
  private active = false;
  private queuedInstructions: string | null = null;
  private lastSentInstructionHash: string = "";
  private createNotBefore = 0;
  private flushTimer: ResponseTimer | null = null;
  private stopped = false;

  constructor(options: RealtimeResponseControllerOptions) {
    this.sendResponse = options.sendResponse;
    this.isPlaybackPending = options.isPlaybackPending;
    this.onDeferred = options.onDeferred;
    this.cooldownMs = options.cooldownMs ?? 100;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
  }

  isActive(): boolean {
    return this.active;
  }

  request(instructions: string): boolean {
    if (this.stopped) return false;

    // Deduplication: skip if same instruction is already queued or just sent
    const instrHash = hashInstruction(instructions);
    const queuedHash = this.queuedInstructions ? hashInstruction(this.queuedInstructions) : "";
    if (instrHash === this.lastSentInstructionHash || instrHash === queuedHash) {
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
      this.lastSentInstructionHash = instrHash;
    }
    return sent;
  }

  markCreated(): void {
    if (!this.stopped) this.active = true;
  }

  markFinished(): void {
    if (this.stopped) return;
    this.active = false;
    this.createNotBefore = this.now() + this.cooldownMs;
    this.flush();
  }

  markCancelled(): void {
    if (this.stopped) return;
    this.active = false;
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
  }

  private scheduleFlush(delayMs: number): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = this.schedule(() => {
      this.flushTimer = null;
      this.flush();
    }, delayMs);
  }
}