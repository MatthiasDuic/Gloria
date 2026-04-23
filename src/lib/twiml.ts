function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildAttributes(attrs: Record<string, string | number | boolean | undefined>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) {
      continue;
    }

    parts.push(`${key}="${escapeXml(String(value))}"`);
  }

  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function withResponse(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

export function buildConnectStreamTwiml(params: {
  streamUrl: string;
  statusCallback?: string;
  parameters?: Record<string, string | undefined>;
  waitPrompt?: string;
}): string {
  const parameterTags = Object.entries(params.parameters || {})
    .filter(([, value]) => Boolean(value))
    .map(
      ([name, value]) =>
        `<Parameter${buildAttributes({ name, value: value as string })} />`,
    )
    .join("");

  const streamTag = `<Stream${buildAttributes({
    url: params.streamUrl,
    statusCallback: params.statusCallback,
  })}>${parameterTags}</Stream>`;

  const waitBlock = params.waitPrompt
    ? `<Say${buildAttributes({ voice: "alice", language: "de-DE" })}>${escapeXml(params.waitPrompt)}</Say>`
    : "";

  return withResponse(`<Connect>${streamTag}</Connect>${waitBlock}`);
}

export function buildGatherTwiml(params: {
  sayText?: string;
  playUrl?: string;
  gather: {
    input: string;
    action: string;
    method?: "GET" | "POST";
    language?: string;
    speechModel?: string;
    profanityFilter?: boolean;
    speechTimeout?: string | number;
    timeout?: number;
    actionOnEmptyResult?: boolean;
    hints?: string;
    numDigits?: number;
  };
  redirectUrl?: string;
  redirectMethod?: "GET" | "POST";
}): string {
  const sayBlock = params.sayText
    ? `<Say${buildAttributes({ voice: "alice", language: "de-DE" })}>${escapeXml(params.sayText)}</Say>`
    : "";
  const playBlock = params.playUrl ? `<Play>${escapeXml(params.playUrl)}</Play>` : "";

  const gatherAttrs = buildAttributes({
    input: params.gather.input,
    action: params.gather.action,
    method: params.gather.method || "POST",
    language: params.gather.language,
    speechModel: params.gather.speechModel,
    profanityFilter: params.gather.profanityFilter,
    speechTimeout: params.gather.speechTimeout,
    timeout: params.gather.timeout,
    actionOnEmptyResult: params.gather.actionOnEmptyResult,
    hints: params.gather.hints,
    numDigits: params.gather.numDigits,
  });

  const redirectBlock = params.redirectUrl
    ? `<Redirect${buildAttributes({ method: params.redirectMethod || "POST" })}>${escapeXml(params.redirectUrl)}</Redirect>`
    : "";

  return withResponse(`${sayBlock}${playBlock}<Gather${gatherAttrs} />${redirectBlock}`);
}

export function buildSayHangupTwiml(params: {
  sayText?: string;
  playUrl?: string;
  /**
   * Sekunden Pause zwischen Goodbye und dem eigentlichen Auflegen.
   * Telefonisch wirkt ein Anruf deutlich höflicher, wenn Gloria nach
   * ihrem "Auf Wiederhören" nicht sofort die Leitung kappt, sondern dem
   * Gegenüber noch kurz Raum lässt, selbst zu reagieren. Twilio-Default
   * war hier 0s (abruptes Klacken). Wir gehen auf 3s.
   */
  trailingPauseSeconds?: number;
}): string {
  const sayBlock = params.sayText
    ? `<Say${buildAttributes({ voice: "alice", language: "de-DE" })}>${escapeXml(params.sayText)}</Say>`
    : "";
  const playBlock = params.playUrl ? `<Play>${escapeXml(params.playUrl)}</Play>` : "";
  const pauseSeconds = Math.max(0, Math.min(10, params.trailingPauseSeconds ?? 3));
  const pauseBlock = pauseSeconds > 0 ? `<Pause${buildAttributes({ length: pauseSeconds })} />` : "";

  return withResponse(`${sayBlock}${playBlock}${pauseBlock}<Hangup />`);
}

export function buildDialTwiml(params: {
  number: string;
  sayText?: string;
  timeout?: number;
}): string {
  const sayBlock = params.sayText
    ? `<Say${buildAttributes({ voice: "alice", language: "de-DE" })}>${escapeXml(params.sayText)}</Say>`
    : "";

  const dialBlock = `<Dial${buildAttributes({ timeout: params.timeout || 20 })}>${escapeXml(params.number)}</Dial>`;

  return withResponse(`${sayBlock}${dialBlock}`);
}
