export type ResponseTimer = ReturnType<typeof setTimeout>;

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
  private createNotBefore = 0;
  private flushTimer: ResponseTimer | null = null;
  private stopped = false;

  constructor(options: RealtimeResponseControllerOptions) {
    this.sendResponse = options.sendResponse;
    this.isPlaybackPending = options.isPlaybackPending;
    this.onDeferred = options.onDeferred;
    this.cooldownMs = options.cooldownMs ?? 180;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
  }

  isActive(): boolean {
    return this.active;
  }

  request(instructions: string): boolean {
    if (this.stopped) return false;
    const delayMs = Math.max(0, this.createNotBefore - this.now());
    const playbackPending = this.isPlaybackPending();
    if (this.active || playbackPending || delayMs > 0) {
      if (this.queuedInstructions === null) this.queuedInstructions = instructions;
      this.onDeferred?.({ instructions, active: this.active, playbackPending, delayMs });
      if (!this.active) this.scheduleFlush(Math.max(20, delayMs));
      return false;
    }
    return this.sendResponse(instructions);
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