export class UserTurnBuffer {
  private speaking = false;
  private readonly items = new Map<string, string | undefined>();
  private anonymousItem = 0;

  speechStarted(itemId?: string): void {
    this.speaking = true;
    if (itemId && !this.items.has(itemId)) this.items.set(itemId, undefined);
  }

  speechStopped(itemId?: string): void {
    this.speaking = false;
    if (itemId && !this.items.has(itemId)) this.items.set(itemId, undefined);
  }

  complete(text: string, itemId?: string): void {
    this.items.set(itemId || `anonymous-${++this.anonymousItem}`, text.trim());
  }

  isBlocked(): boolean {
    return this.speaking || [...this.items.values()].some((text) => text === undefined);
  }

  take(): string | undefined {
    return this.takeParts()?.join(" ") || undefined;
  }

  takeParts(): string[] | undefined {
    if (this.isBlocked()) return undefined;
    const parts = [...this.items.values()].filter((text): text is string => typeof text === "string" && Boolean(text));
    this.items.clear();
    return parts;
  }

  clear(): void {
    this.items.clear();
    this.speaking = false;
  }

  resetAfterReconnect(): string | undefined {
    this.speaking = false;
    for (const [id, text] of this.items) {
      if (text === undefined) this.items.delete(id);
    }
    return this.take();
  }
}
