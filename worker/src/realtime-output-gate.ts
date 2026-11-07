export type RealtimeOutputItem = {
  id?: string;
  type?: string;
  phase?: string;
  name?: string;
};

// Vor diesen Werkzeugen ist der commentary-Text die hörbare Aussage (Verabschiedung bzw. Weiterleitungsansage).
const ANNOUNCED_TOOLS = new Set(["end_call", "transfer_to_human"]);

// Interne Selbstkommentare ("Der Kunde möchte ...", "Ich beende das Gespräch") dürfen nie hörbar werden.
const META_SENTENCE = /\b(?:end_call|transfer_to_human|tool|funktionsaufruf)\b|^\s*(?:der|die)\s+(?:kunde|kundin|anrufer(?:in)?|interessent(?:in)?|person|angerufene|gesprächspartner(?:in)?|nutzer(?:in)?)\b|\bich\s+(?:beende|werde)\s+(?:jetzt\s+|nun\s+|hiermit\s+)?(?:das\s+|den\s+)?(?:gespräch|telefonat|anruf)\b|\bbeende\s+ich\s+(?:jetzt\s+|nun\s+)?(?:das\s+|den\s+)?(?:gespräch|telefonat|anruf)\b|\b(?:gespräch|telefonat|anruf)\s+(?:wird\s+)?(?:jetzt\s+|nun\s+|hiermit\s+)?beende[nt]\b|\bich\s+lege\s+(?:jetzt\s+|nun\s+)?auf\b/i;

export function stripMetaCommentary(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [];
  return sentences.filter((sentence) => !META_SENTENCE.test(sentence)).join("").replace(/\s+/g, " ").trim();
}

export type RealtimeOutputGateOptions = {
  /** Decides whether an announced tool (end_call/transfer_to_human) will actually run; otherwise its commentary is dropped. */
  canAnnounce?: (toolName: string) => boolean;
  /** Spoken before end_call when the response would otherwise hang up without any audible farewell. */
  hangupFallbackText?: string;
};

/**
 * gpt-realtime-2.x liefert vor Antworten und Werkzeugaufrufen oft eine Vorrede im commentary-Kanal
 * ("ich prüfe kurz die Terminbestätigung ..."). Diese wird zurückgehalten und nur gesprochen,
 * wenn danach keine eigentliche Antwort folgt oder sie ein end_call/transfer_to_human ankündigt.
 */
export class RealtimeOutputGate {
  private commentaryIds = new Set<string>();
  private held: Array<{ id: string; text: string }> = [];
  private suppressed: string[] = [];
  private spoken = "";
  private lastSpokenItemId: string | undefined;

  constructor(private readonly options: RealtimeOutputGateOptions = {}) {}

  reset(): void {
    this.commentaryIds.clear();
    this.held = [];
    this.suppressed = [];
    this.spoken = "";
    this.lastSpokenItemId = undefined;
  }

  observeItem(item: RealtimeOutputItem | undefined): string {
    if (!item) return "";
    if (item.type === "message") {
      if (item.phase === "commentary" && item.id) {
        this.commentaryIds.add(item.id);
        return "";
      }
      this.dropHeld();
      return "";
    }
    if (item.type === "function_call") {
      // Ohne Namen erst beim Argumentabschluss entscheiden.
      if (!item.name) return "";
      if (ANNOUNCED_TOOLS.has(item.name)) {
        if (this.options.canAnnounce && !this.options.canAnnounce(item.name)) {
          this.dropHeld();
          return "";
        }
        return this.releaseAnnouncement(item.name);
      }
      this.dropHeld();
    }
    return "";
  }

  acceptText(itemId: string | undefined, text: string): string {
    if (!text) return "";
    if (itemId && this.commentaryIds.has(itemId)) {
      const entry = this.held.find((candidate) => candidate.id === itemId);
      if (entry) entry.text += text;
      else this.held.push({ id: itemId, text });
      return "";
    }
    return this.emit(itemId, text);
  }

  finish(): string {
    return this.releaseHeld();
  }

  takeSuppressed(): string[] {
    const suppressed = this.suppressed;
    this.suppressed = [];
    return suppressed;
  }

  private releaseHeld(): string {
    let released = "";
    for (const entry of this.held) released += this.emit(entry.id, entry.text);
    this.held = [];
    return released;
  }

  private releaseAnnouncement(toolName: string): string {
    let released = "";
    for (const entry of this.held) {
      const clean = stripMetaCommentary(entry.text);
      const original = entry.text.replace(/\s+/g, " ").trim();
      if (clean !== original && original) this.suppressed.push(original);
      if (clean) released += this.emit(entry.id, clean);
    }
    this.held = [];
    if (toolName === "end_call" && !this.spoken.trim() && this.options.hangupFallbackText) {
      released += this.emit(undefined, this.options.hangupFallbackText);
    }
    return released;
  }

  private dropHeld(): void {
    for (const entry of this.held) {
      const text = entry.text.replace(/\s+/g, " ").trim();
      if (text) this.suppressed.push(text);
    }
    this.held = [];
  }

  private emit(itemId: string | undefined, text: string): string {
    const needsSeparator = Boolean(itemId && this.lastSpokenItemId && itemId !== this.lastSpokenItemId)
      && this.spoken.length > 0
      && !/\s$/.test(this.spoken)
      && !/^\s/.test(text);
    const output = needsSeparator ? ` ${text}` : text;
    if (itemId) this.lastSpokenItemId = itemId;
    this.spoken += output;
    return output;
  }
}
