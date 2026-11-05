export type PrefetchedSpeechListener = {
  onChunk: (chunk: Buffer) => void;
  onEnd: (ok: boolean, playedBytes: number) => void;
};

export class PrefetchedSpeech {
  private readonly chunks: Buffer[] = [];
  private state: "pending" | "done" | "failed" = "pending";
  private listener: PrefetchedSpeechListener | null = null;
  private playedBytes = 0;

  constructor(readonly text: string) {}

  push(chunk: Buffer): void {
    if (this.state !== "pending" || !chunk.length) return;
    const copy = Buffer.from(chunk);
    this.chunks.push(copy);
    if (this.listener) {
      this.playedBytes += copy.length;
      this.listener.onChunk(copy);
    }
  }

  complete(ok: boolean): void {
    if (this.state !== "pending") return;
    this.state = ok && this.chunks.length > 0 ? "done" : "failed";
    const listener = this.listener;
    this.listener = null;
    listener?.onEnd(this.state === "done", this.playedBytes);
  }

  isUsable(): boolean {
    return this.state !== "failed";
  }

  isReady(): boolean {
    return this.state === "done";
  }

  play(listener: PrefetchedSpeechListener): void {
    this.playedBytes = 0;
    for (const chunk of this.chunks) {
      this.playedBytes += chunk.length;
      listener.onChunk(chunk);
    }
    if (this.state === "pending") {
      this.listener = listener;
      return;
    }
    listener.onEnd(this.state === "done", this.playedBytes);
  }

  detach(): void {
    this.listener = null;
  }
}
