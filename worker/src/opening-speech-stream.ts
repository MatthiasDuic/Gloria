import { endsWithSentenceAbbreviation } from "./german-sentence.js";

export class OpeningSpeechStream {
  private readonly segmenter = new Intl.Segmenter("de", { granularity: "sentence" });
  private buffer = "";
  private pending = Promise.resolve();
  private stopped = false;
  private started = false;

  constructor(private readonly speak: (text: string) => Promise<void>) {}

  hasStarted(): boolean { return this.started; }

  append(text: string): void {
    if (this.stopped || !text) return;
    this.buffer += text;
    const segments = [...this.segmenter.segment(this.buffer)];
    let consumed = 0;
    let complete = "";
    for (let index = 0; index < segments.length - 1; index++) {
      complete += segments[index].segment;
      if (endsWithSentenceAbbreviation(complete)) continue;
      consumed += complete.length;
      this.enqueue(complete);
      complete = "";
    }
    this.buffer = this.buffer.slice(consumed);
  }

  finish(): Promise<void> {
    if (!this.stopped) this.enqueue(this.buffer);
    this.buffer = "";
    return this.pending;
  }

  stop(): void {
    this.stopped = true;
    this.buffer = "";
  }

  private enqueue(text: string): void {
    const sentence = text.replace(/\s+/g, " ").trim();
    if (!sentence) return;
    this.pending = this.pending.then(async () => {
      if (this.stopped) return;
      this.started = true;
      await this.speak(sentence);
    });
  }
}