export type PlaybackTimer = ReturnType<typeof setTimeout>;

export type TelnyxPlaybackOptions = {
  sendFrame: (frame: Buffer) => boolean;
  onIdle?: () => void;
  frameBytes?: number;
  frameIntervalMs?: number;
  prebufferFrames?: number;
  schedule?: (callback: () => void, delayMs: number) => PlaybackTimer;
  cancelSchedule?: (timer: PlaybackTimer) => void;
};

export class TelnyxPlayback {
  private readonly sendFrame: (frame: Buffer) => boolean;
  private readonly onIdle?: () => void;
  private readonly frameBytes: number;
  private readonly frameIntervalMs: number;
  private readonly prebufferFrames: number;
  private readonly schedule: (callback: () => void, delayMs: number) => PlaybackTimer;
  private readonly cancelSchedule: (timer: PlaybackTimer) => void;
  private readonly queue: Buffer[] = [];
  private timer: PlaybackTimer | null = null;
  private audioBuffer = Buffer.alloc(0);
  private stopped = false;
  private sentBytes = 0;
  private responsePending = false;
  private audioFinished = false;

  constructor(options: TelnyxPlaybackOptions) {
    this.sendFrame = options.sendFrame;
    this.onIdle = options.onIdle;
    this.frameBytes = options.frameBytes ?? 160;
    this.frameIntervalMs = options.frameIntervalMs ?? 20;
    this.prebufferFrames = Math.max(1, options.prebufferFrames ?? 1);
    this.schedule = options.schedule ?? setTimeout;
    this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
  }

  startResponse(): void {
    this.audioBuffer = Buffer.alloc(0);
    this.sentBytes = 0;
    this.responsePending = true;
    this.audioFinished = false;
  }

  appendBase64Audio(delta: string): void {
    if (this.stopped || !delta) return;
    this.audioBuffer = Buffer.concat([this.audioBuffer, Buffer.from(delta, "base64")]);
    while (this.audioBuffer.length >= this.frameBytes) {
      this.enqueue(this.audioBuffer.subarray(0, this.frameBytes));
      this.audioBuffer = this.audioBuffer.subarray(this.frameBytes);
    }
  }

  finishAudio(silenceByte: number): void {
    if (this.stopped) return;
    if (this.audioBuffer.length > 0) {
      const frame = Buffer.concat([
        this.audioBuffer,
        Buffer.alloc(this.frameBytes - this.audioBuffer.length, silenceByte),
      ]);
      this.audioBuffer = Buffer.alloc(0);
      this.queue.push(frame);
    }
    this.audioFinished = true;
    this.startPumpIfReady();
  }

  isPending(): boolean {
    return this.responsePending || this.queue.length > 0 || this.timer !== null;
  }

  bytesSent(): number {
    return this.sentBytes;
  }

  interrupt(): { audioEndMs: number; bytesSent: number } {
    const bytesSent = this.sentBytes;
    const sentFrames = Math.ceil(bytesSent / this.frameBytes);
    this.queue.length = 0;
    this.audioBuffer = Buffer.alloc(0);
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = null;
    this.sentBytes = 0;
    this.responsePending = false;
    this.audioFinished = false;
    return { audioEndMs: sentFrames * this.frameIntervalMs, bytesSent };
  }

  stop(): void {
    this.stopped = true;
    this.interrupt();
  }

  private enqueue(frame: Buffer): void {
    this.queue.push(frame);
    this.startPumpIfReady();
  }

  private startPumpIfReady(): void {
    if (!this.timer && (this.audioFinished || this.queue.length >= this.prebufferFrames)) this.pump();
  }

  private pump = (): void => {
    this.timer = null;
    if (this.stopped || this.queue.length === 0) {
      if (!this.stopped && this.audioFinished) {
        this.responsePending = false;
        this.onIdle?.();
      }
      return;
    }
    const frame = this.queue.shift();
    if (frame && this.sendFrame(frame)) this.sentBytes += frame.length;
    this.timer = this.schedule(this.pump, this.frameIntervalMs);
  };
}