export class UserTurnBuffer {
  private speaking = false;
  private readonly items = new Map<string, string | undefined>();
  private anonymousItem = 0;
  private readonly expiredItemIds = new Set<string>();

  speechStarted(itemId?: string): void {
    this.speaking = true;
    if (itemId && !this.items.has(itemId)) this.items.set(itemId, undefined);
  }

  speechStopped(itemId?: string): void {
    this.speaking = false;
    if (itemId && !this.items.has(itemId)) this.items.set(itemId, undefined);
  }

  complete(text: string, itemId?: string): void {
    const id = itemId || `anonymous-${++this.anonymousItem}`;
    if (this.expiredItemIds.has(id)) return;
    this.items.set(id, text.trim());
  }

  fail(itemId: string): void {
    this.expiredItemIds.add(itemId);
    if (this.expiredItemIds.size > 128) {
      const oldest = this.expiredItemIds.values().next().value;
      if (oldest) this.expiredItemIds.delete(oldest);
    }
    this.items.set(itemId, "");
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
    this.expiredItemIds.clear();
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
