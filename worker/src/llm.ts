import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";
import { canScheduleFromFlow } from "./topic-policy.js";

// buildBasePrompt and generateReply removed — dead code.
// Live path is exclusively streamReply (sentence-level LLM→TTS pipeline).

export type TurnOutput = {
  reply: string;
  hangup: boolean;
  transfer: boolean;
};

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseEnvBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

async function recoverAbortedStream(params: {
  apiKey: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
}): Promise<TurnOutput | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1400);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        temperature: 0.5,
        max_tokens: Math.min(70, Math.max(36, params.maxTokens)),
        response_format: { type: "json_object" },
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content?.trim() || "";
    if (!content) return null;

    try {
      const parsed = JSON.parse(content) as { reply?: string; hangup?: boolean; transfer?: boolean };
      const reply = parsed.reply?.trim();
      if (!reply) return null;
      return {
        reply,
        hangup: Boolean(parsed.hangup),
        transfer: Boolean(parsed.transfer),
      };
    } catch {
      return { reply: content, hangup: false, transfer: false };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pre-warmt die OpenAI-Verbindung für den ersten Live-Turn.
 */
export function prewarmOpenAi(): void {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return;
  void fetch("https://api.openai.com/v1/models", {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  })
    .then((res) => {
      // Body draining ist wichtig damit die Connection im Pool bleibt.
      void res.text().catch(() => undefined);
      log.info("llm.prewarm_ok", { status: res.status });
    })
    .catch(() => {
      /* ignore – best effort */
    });
}

export async function streamReply(
  ctx: CallContext,
  userText: string,
  onSentence: (sentence: string) => void,
): Promise<TurnOutput> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const deterministicReply = buildDeterministicPostBookingReply(ctx);
  if (deterministicReply) {
    log.info("llm.reply_path", { callSid: ctx.callSid, path: "deterministic_post_booking" });
    return emitDeterministicReply(deterministicReply, onSentence);
  }

  const factualCorrection = buildDeterministicFactualCorrection(ctx, userText);
  if (factualCorrection) {
    log.info("llm.reply_path", { callSid: ctx.callSid, path: "deterministic_factual_correction" });
    onSentence(factualCorrection.reply);
    return factualCorrection;
  }

  const trustReply = buildDeterministicTrustReply(ctx, userText);
  if (trustReply) {
    log.info("llm.reply_path", { callSid: ctx.callSid, path: "deterministic_trust" });
    onSentence(trustReply.reply);
    return trustReply;
  }

  const route = decideTurnRoute(ctx, userText);
  log.info("llm.turn_route", { callSid: ctx.callSid, route: route.route, reason: route.reason });

  // OpenAI formuliert den normalen Gesprächsverlauf. Der deterministische
  // PKV-Fallback bleibt für lokale Tests und den Fall ohne API-Key erhalten.
  if (route.route === "worker" || !apiKey) {
    const deterministicPkvReply = buildDeterministicPkvFlowReply(ctx, userText);
    if (deterministicPkvReply) {
      log.info("llm.reply_path", { callSid: ctx.callSid, path: "deterministic_pkv" });
      return emitDeterministicReply(deterministicPkvReply, onSentence);
    }
  }

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  // Live-Default: gpt-4.1-mini reduziert Timeout-Abbrüche deutlich und hält
  // den Turn-Flow in Telefonaten stabil. Override via OPENAI_MODEL.
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
  // Premium-Sweetspot: genug Kontext + knappe Antworten fuer natuerliche
  // Dynamik bei niedriger Reaktionszeit.
  const transcriptTurns = parseEnvInt("LLM_TRANSCRIPT_TURNS", 10, 6, 24);
  const maxTokens = parseEnvInt("LLM_MAX_TOKENS", 105, 60, 220);
  const timeoutMs = parseEnvInt("LLM_TIMEOUT_MS", 7000, 3500, 20000);
  const firstTokenTimeoutMs = parseEnvInt("LLM_FIRST_TOKEN_TIMEOUT_MS", 1600, 700, 5000);
  const earlyFlushChars = parseEnvInt("LLM_EARLY_FLUSH_CHARS", 160, 24, 400);

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildSystemPrompt(ctx) },
  ];
  // handleUserUtterance hat den aktuellen Nutzerturn bereits ins Transkript
  // geschrieben. Nicht ein zweites Mal an das Modell senden.
  const history = ctx.transcript.at(-1)?.role === "user" && ctx.transcript.at(-1)?.text === userText
    ? ctx.transcript.slice(0, -1)
    : ctx.transcript;
  for (const turn of history.slice(-transcriptTurns)) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userText });

  const requestBody = {
    model,
    messages,
    temperature: 0.58,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    stream: true,
  };

  log.info("llm.reply_path", {
    callSid: ctx.callSid,
    path: "openai_stream",
    model,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let firstTokenSeen = false;
  const firstTokenTimer = setTimeout(() => {
    if (firstTokenSeen) return;
    controller.abort(new Error("llm_first_token_timeout"));
  }, firstTokenTimeoutMs);

  // Streaming-State für inkrementelles Reply-Extrahieren.
  let assembled = "";
  let phase: "before" | "in" | "after" = "before";
  let escapeNext = false;
  let pendingFlush = "";
  let replyText = "";
  let scanPos = 0;
  let emittedSegmentCount = 0;
  let emittedQuestion = false;
  let lastEmittedNorm = "";

  const flushSentence = () => {
    const out = pendingFlush.trim();
    pendingFlush = "";
    if (out.length > 0) {
      const filtered = enforceRealtimeReplyPolicy(ctx, userText, sanitizeReplyText(out));
      if (!filtered) return;
      const normalized = filtered.toLowerCase().replace(/\s+/g, " ").trim();
      if (!normalized) return;
      if (normalized === lastEmittedNorm) return;
      if (isDanglingContinuation(filtered) && emittedSegmentCount > 0) return;
      const hasQuestion = /\?/.test(filtered);
      if (hasQuestion && emittedQuestion) return;
      if (emittedSegmentCount >= 2) return;
      try {
        onSentence(filtered);
        emittedSegmentCount += 1;
        if (hasQuestion) emittedQuestion = true;
        lastEmittedNorm = normalized;
      } catch (err) {
        log.error("llm.onSentence_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const consume = (delta: string): void => {
    assembled += delta;
    while (scanPos < assembled.length) {
      const ch = assembled[scanPos++];
      if (phase === "before") {
        const m = /"reply"\s*:\s*"/.exec(assembled.slice(0, scanPos));
        if (m && m.index + m[0].length === scanPos) {
          phase = "in";
        }
      } else if (phase === "in") {
        if (escapeNext) {
          if (ch === "n") {
            replyText += "\n";
            pendingFlush += "\n";
          } else if (ch === "t" || ch === "r") {
            replyText += " ";
            pendingFlush += " ";
          } else {
            replyText += ch;
            pendingFlush += ch;
          }
          escapeNext = false;
        } else if (ch === "\\") {
          escapeNext = true;
        } else if (ch === '"') {
          phase = "after";
          flushSentence();
        } else {
          replyText += ch;
          pendingFlush += ch;
          // Satzgrenze: nur echte Satzenden flushen (kein Komma-Split).
          // Komma-Splits erzeugen Satzfragmente mit falscher Intonation im TTS.
          if (/[.!?]/.test(ch) && pendingFlush.length >= 8) {
            // Schutz gegen Abkürzungen: "z." / "B." / "Hr." / "Fr." / Ordinalia.
            const tail = replyText.slice(-3).toLowerCase();
            const isAbbrev =
              /\b(z|b|hr|fr|dr|st|ca|bzw|usw|inkl|ggf|evtl|nr|tel|app)\.$/i.test(replyText) ||
              /\b\d+\.$/.test(replyText) || // Ordinalzahlen "30.", "12."
              tail.endsWith(" z.") ||
              tail.endsWith(" b.");
            if (!isAbbrev) flushSentence();
          }
          // Latenzbremsen vermeiden: bei langen Teilsaetzen an natuerlichen
          // Klauselgrenzen frueh flushen, statt auf den finalen Punkt zu warten.
          if (pendingFlush.length >= earlyFlushChars && /[,;:]/.test(ch)) {
            flushSentence();
          }
          // Sicherheitspuffer: sehr lange Segmente an Leerzeichen trennen.
          if (pendingFlush.length >= 250 && /\s/.test(ch)) {
            flushSentence();
          }
        }
      }
    }
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const body = res.body ? await res.text() : "";
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() || "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const json = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            firstTokenSeen = true;
            consume(delta);
          }
        } catch {
          /* heartbeat / non-json */
        }
      }
    }
    // Restpuffer flushen, falls der Reply ohne Satzzeichen endete.
    if ((phase as string) !== "before") flushSentence();

    let hangup = false;
    let transfer = false;
    try {
      const parsed = JSON.parse(assembled) as { hangup?: boolean; transfer?: boolean; reply?: string };
      hangup = Boolean(parsed.hangup);
      transfer = Boolean(parsed.transfer);
      if (parsed.reply && !replyText) replyText = parsed.reply;
    } catch {
      /* fallback: replyText was scanner-extracted, hangup defaults to false */
    }

    let reply = replyText.trim() || "Entschuldigung, könnten Sie das bitte wiederholen?";
    reply = enforceRealtimeReplyPolicy(ctx, userText, sanitizeReplyText(reply)) ||
      "Entschuldigung, könnten Sie das bitte wiederholen?";
    if (consentAlreadyGranted(ctx) && /aufzeichn|mitschneid/i.test(reply)) {
      reply = stripConsentQuestion(reply);
    }
    return { reply, hangup, transfer };
  } catch (error) {
    log.error("llm.stream_failed", {
      error: error instanceof Error ? error.message : String(error),
      firstTokenSeen,
    });

    if (!replyText.trim()) {
      const recovered = await recoverAbortedStream({
        apiKey,
        model,
        messages,
        maxTokens,
      });
      if (recovered) {
          log.info("llm.reply_path", {
            callSid: ctx.callSid,
            path: "openai_recovery",
            model,
          });
        if (recovered.reply?.trim()) {
          try {
            const recoveredFiltered = enforceRealtimeReplyPolicy(
              ctx,
              userText,
              sanitizeReplyText(recovered.reply.trim()),
            );
            if (recoveredFiltered) onSentence(recoveredFiltered);
          } catch {
            // ignore callback issues in fallback path
          }
        }
        recovered.reply =
          enforceRealtimeReplyPolicy(ctx, userText, sanitizeReplyText(recovered.reply)) ||
          "Einen kurzen Moment bitte. Worum geht es Ihnen genau?";
        if (consentAlreadyGranted(ctx) && /aufzeichn|mitschneid/i.test(recovered.reply)) {
          recovered.reply = stripConsentQuestion(recovered.reply);
        }
        return recovered;
      }
    }

    const fallbackReply =
      enforceRealtimeReplyPolicy(
        ctx,
        userText,
        sanitizeReplyText(replyText.trim() || "Einen kleinen Moment bitte. Worum geht es Ihnen genau?"),
      ) || "Einen kleinen Moment bitte. Worum geht es Ihnen genau?";
    if (fallbackReply) {
      try {
        onSentence(fallbackReply);
      } catch {
        // ignore callback issues in emergency fallback path
      }
    }

    return {
      reply: fallbackReply,
      hangup: false,
      transfer: false,
    };
  } finally {
    clearTimeout(timeout);
    clearTimeout(firstTokenTimer);
  }
}

type TurnRoute = {
  route: "worker" | "openai";
  reason: "structured_state" | "customer_question" | "customer_objection" | "free_dialogue";
};

export function decideTurnRoute(ctx: CallContext, userText: string): TurnRoute {
  const text = userText.trim().toLowerCase();
  const question = /\?|\b(wie|warum|weshalb|wieso|was|welche|welcher|können|kann|darf|soll|woher|woraus)\b/i.test(text);
  const objection = /ich\s+verstehe\s+nicht|kann\s+ich\s+mir\s+nicht\s+vorstellen|kein\s+interesse|keine\s+zeit|zu\s+teuer|was\s+bringt|was\s+hab\s+ich\s+davon|aber\b/i.test(text);

  // Hard state ownership stays local: these answers must never be invented
  // or reordered by OpenAI.
  if (ctx.confirmedSlotPhrase || ctx.flow.stage === "post_booking") {
    return { route: "worker", reason: "structured_state" };
  }
  if (ctx.topicKind === "pkv" && (ctx.flow.awaiting === "appointment_preference" || ctx.flow.awaiting === "appointment_selection")) {
    if (!question && !objection) return { route: "worker", reason: "structured_state" };
  }
  if (ctx.topicKind === "pkv" && /e-?mail|mailadresse|allerg|medikament|diagnos|zahnersatz|krankenhaus|geburtsdatum|k[oö]rpergr[oö][sß]e|gewicht/i.test(text)) {
    return { route: "worker", reason: "structured_state" };
  }
  if (objection) return { route: "openai", reason: "customer_objection" };
  if (question) return { route: "openai", reason: "customer_question" };
  if (ctx.topicKind === "pkv") return { route: "worker", reason: "structured_state" };
  return { route: "openai", reason: "free_dialogue" };
}

function emitDeterministicReply(reply: TurnOutput, onSentence: (sentence: string) => void): TurnOutput {
  const segments = reply.reply.split(" [PAUSE] ").map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) onSentence(segment);
  return { ...reply, reply: segments.join(" ") };
}

function sanitizeReplyText(text: string): string {
  let out = text || "";
  out = out.replace(/\blaut\s+pkv-?verband\b/gi, "Erfahrungsgemäß");
  out = out.replace(/einverst[äa]ndniserkl[äa]rung\s+zur\s+aufzeichnung\s+des\s+termins/gi, "Terminbestätigung");
  out = out.replace(/aufzeichnung\s+des\s+termins/gi, "Terminbestätigung");
  // Remove disposable acknowledgement openers from OpenAI output while
  // preserving the substantive response that follows.
  out = out.replace(/^(?:Danke(?:\s+für\s+die\s+Info)?|Prima|Super|Perfekt|Verstanden|Das ist nachvollziehbar)(?:,?\s+(?:Herr\s+\w+))?[.!]\s*/i, "");
  out = out.replace(/^Verstanden,?\s+und\s+genau\s+deshalb\s+/i, "Genau deshalb ");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

function enforceRealtimeReplyPolicy(ctx: CallContext, userText: string, text: string): string {
  let out = text.trim();
  if (!out) return "";

  const phase = inferConversationPhase(ctx);
  const isPkv = /pkv|kranken/.test((ctx.topic || "").toLowerCase());
  if (isPkv) {
    const knownInsurance = ctx.transcript
      .filter((turn) => turn.role === "user")
      .some((turn) => hasInsuranceSignal(turn.text));
    if (!knownInsurance) {
      out = out.replace(/\bprivate(?:n|r|m|s)?\s+krankenversicherung\b/gi, "Krankenversicherung");
    }
  }
  if (isPkv && phase <= 6) {
    out = rewriteRepeatedPkvDiscoveryQuestion(ctx, userText, out);
  }
  if (isPkv && phase <= 6 && containsEarlySchedulingQuestion(out) && !isPkvSchedulingReady(ctx)) {
    out = buildPkvDiscoveryQuestion(ctx, userText);
  }
  return out;
}

function buildDeterministicFactualCorrection(ctx: CallContext, userText: string): TurnOutput | null {
  const text = userText.toLowerCase();
  if (!/(?:wie\s+kommst|woher|wie\s+kommt|quelle|warum).*(?:prozent|30\s*%|beitragssteiger|durchschnitt)/i.test(text)) {
    return null;
  }

  return {
    reply: "Die feste Prozentzahl war zu pauschal formuliert. Für Ihre persönliche Situation lässt sich das seriös nur anhand Ihrer eigenen Beitragsentwicklung prüfen; genau das würde Herr Duic im Termin mit Ihnen durchrechnen.",
    hangup: false,
    transfer: false,
  };
}

function rewriteRepeatedPkvDiscoveryQuestion(ctx: CallContext, userText: string, out: string): string {
  const userHistory = `${ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ")} ${userText}`.toLowerCase();

  const insuranceKnown = hasInsuranceSignal(userHistory);
  const contributionKnown = hasCurrentContributionSignal(ctx, userText);

  if (/\b(privat|gesetzlich)\b[^.?!]*\bversichert\b|\bprivat\s+oder\s+gesetzlich\b/i.test(out) && insuranceKnown) {
    return contributionKnown
      ? buildProjectionInterestReply(ctx)
      : "Danke für die Einordnung. Wenn Sie möchten: In welcher Größenordnung liegt Ihr aktueller Monatsbeitrag?";
  }

  if (/monatsbeitrag|gr[öo]ßenordnung[^.?!]*beitrag|wie\s+hoch[^.?!]*beitrag/i.test(out) && contributionKnown) {
    return buildProjectionInterestReply(ctx);
  }

  return out;
}

type PkvFlowState =
  | "need_insurance"
  | "need_contribution"
  | "need_projection"
  | "need_interest"
  | "ready_for_schedule";

function detectPkvFlowState(ctx: CallContext, userText: string): PkvFlowState {
  const structured = ctx.flow.pkvData;
  if (ctx.flow.awaiting === "insurance_status") return "need_insurance";
  if (ctx.flow.awaiting === "current_contribution") return "need_contribution";
  if (ctx.flow.awaiting === "projection_interest") {
    if (!ctx.flow.projectionDelivered) return "need_projection";
    if (structured.interest === "positive") return "ready_for_schedule";
    return "need_interest";
  }
  if (ctx.flow.awaiting === "appointment_preference" || ctx.flow.awaiting === "appointment_selection") {
    return "ready_for_schedule";
  }
  if (ctx.topicKind === "pkv" && (structured.insuranceStatus || structured.currentContribution !== undefined || structured.interest)) {
    if (!structured.insuranceStatus) return "need_insurance";
    if (structured.currentContribution === undefined) return "need_contribution";
    if (!ctx.flow.projectionDelivered) return "need_projection";
    if (structured.interest !== "positive") return "need_interest";
    return "ready_for_schedule";
  }

  const userHistory = `${ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ")} ${userText}`.toLowerCase();
  const assistantHistory = ctx.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text.toLowerCase())
    .join(" \n ");

  const insuranceKnown = hasInsuranceSignal(userHistory);
  if (!insuranceKnown) return "need_insurance";

  const contributionKnown = hasCurrentContributionSignal(ctx, userText);
  if (!contributionKnown) return "need_contribution";

  const projectionGiven = hasCurrentProjection(ctx);
  if (!projectionGiven) return "need_projection";

  const interestAsked = /w[äa]re\s+.*(?:hilfreich|interessant|mehrwert)|sinnvoll\s+f[üu]r\s+sie|sollen\s+wir\s+uns\s+das\s+anschauen|echter\s+mehrwert|diese\s+klarheit/.test(
    assistantHistory,
  );
  const interestQuestionIndex = [...ctx.transcript]
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "assistant" && /w[äa]re\s+.*(?:hilfreich|interessant)|sinnvoll\s+f[üu]r\s+sie|echter\s+mehrwert|diese\s+klarheit/.test(turn.text.toLowerCase()))
    .at(-1)?.index;
  const interestAnswer = interestQuestionIndex === undefined
    ? ""
    : ctx.transcript.slice(interestQuestionIndex + 1).find((turn) => turn.role === "user")?.text || "";
  const interestConfirmed = /\b(ja|gern|gerne|macht\s+sinn|hilfreich|interessant|klingt\s+gut|okay|ok|passt)\b/i.test(interestAnswer);

  if (interestAsked && !interestConfirmed) return "need_interest";
  return "ready_for_schedule";
}

function extractLatestContributionPhrase(text: string): string | undefined {
  const direct = text.match(/\b\d{2,5}(?:[.,:]\d{1,2})?\s*(?:euro|€)\b/gi);
  if (direct?.length) return direct.at(-1)?.replace(/\s+/g, " ").trim();
  const spoken = text.match(/\b(?:[a-zäöüß-]*tausend[a-zäöüß-]*|[a-zäöüß-]*hundert[a-zäöüß-]*)(?:\s+[a-zäöüß-]+){0,4}\s+euro\b/gi);
  if (spoken?.length) return spoken.at(-1)?.replace(/\s+/g, " ").trim();
  return undefined;
}

export function parseGermanEuroAmount(text: string): number | undefined {
  const directMatch = text.match(/\b(\d{2,5})(?:[.,:]\d{1,2})?\s*(?:euro|€)\b/i);
  if (directMatch) {
    return Number.parseInt(directMatch[1], 10);
  }

  const spokenMatch = text.match(/\b([a-zäöüß-]+(?:\s+[a-zäöüß-]+){0,4})\s+euro\b/i);
  if (!spokenMatch) return undefined;

  return parseGermanNumberWords(spokenMatch[1]);
}

function parseGermanNumberWords(input: string): number | undefined {
  const normalized = input
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/-/g, "")
    .replace(/\s+/g, "");

  if (!normalized) return undefined;

  const units: Record<string, number> = {
    null: 0,
    ein: 1,
    eins: 1,
    eine: 1,
    einen: 1,
    zwei: 2,
    drei: 3,
    vier: 4,
    fuenf: 5,
    sechs: 6,
    sieben: 7,
    acht: 8,
    neun: 9,
  };
  const teens: Record<string, number> = {
    zehn: 10,
    elf: 11,
    zwoelf: 12,
    dreizehn: 13,
    vierzehn: 14,
    fuenfzehn: 15,
    sechzehn: 16,
    siebzehn: 17,
    achtzehn: 18,
    neunzehn: 19,
  };
  const tens: Record<string, number> = {
    zwanzig: 20,
    dreissig: 30,
    vierzig: 40,
    fuenfzig: 50,
    sechzig: 60,
    siebzig: 70,
    achtzig: 80,
    neunzig: 90,
  };

  const parseUnderHundred = (value: string): number | undefined => {
    if (value in units) return units[value];
    if (value in teens) return teens[value];
    if (value in tens) return tens[value];
    const undIndex = value.indexOf("und");
    if (undIndex > 0) {
      const left = value.slice(0, undIndex);
      const right = value.slice(undIndex + 3);
      if (left in units && right in tens) {
        return units[left] + tens[right];
      }
    }
    return undefined;
  };

  const parseRecursive = (value: string): number | undefined => {
    if (!value) return 0;
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);

    const thousandIndex = value.indexOf("tausend");
    if (thousandIndex >= 0) {
      const left = value.slice(0, thousandIndex) || "ein";
      const right = value.slice(thousandIndex + "tausend".length);
      const leftParsed = parseRecursive(left);
      const rightParsed = parseRecursive(right);
      if (leftParsed === undefined || rightParsed === undefined) return undefined;
      return leftParsed * 1000 + rightParsed;
    }

    const hundredIndex = value.indexOf("hundert");
    if (hundredIndex >= 0) {
      const left = value.slice(0, hundredIndex) || "ein";
      const right = value.slice(hundredIndex + "hundert".length);
      const leftParsed = parseRecursive(left);
      const rightParsed = parseRecursive(right);
      if (leftParsed === undefined || rightParsed === undefined) return undefined;
      return leftParsed * 100 + rightParsed;
    }

    return parseUnderHundred(value);
  };

  return parseRecursive(normalized);
}

export function buildTenYearProjectionLine(amount: number): string {
  const annualGrowth = 1.04;
  const futureMonthly = Math.round(amount * annualGrowth ** 10);
  const monthlyIncrease = futureMonthly - amount;
  const roundedFuture = roundToNearest(futureMonthly, 10);
  const roundedIncrease = roundToNearest(monthlyIncrease, 10);
  return `Wenn man von rund vier Prozent pro Jahr ausgeht, lägen ${numberToGermanWords(amount)} Euro in zehn Jahren bei rund ${numberToGermanWords(roundedFuture)} Euro im Monat - also etwa ${numberToGermanWords(roundedIncrease)} Euro mehr pro Monat.`;
}

function numberToGermanWords(value: number): string {
  const units = ["null", "ein", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
  const teens = ["zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
  const tens = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
  const underHundred = (number: number): string => {
    if (number < 10) return units[number];
    if (number < 20) return teens[number - 10];
    const ten = Math.floor(number / 10);
    const unit = number % 10;
    return unit ? `${units[unit]}und${tens[ten]}` : tens[ten];
  };
  if (value < 100) return underHundred(value);
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const rest = value % 100;
    return `${hundreds === 1 ? "ein" : units[hundreds]}hundert${rest ? underHundred(rest) : ""}`;
  }
  const thousands = Math.floor(value / 1000);
  const rest = value % 1000;
  return `${thousands === 1 ? "ein" : numberToGermanWords(thousands)}tausend${rest ? numberToGermanWords(rest) : ""}`;
}

function roundToNearest(value: number, step: number): number {
  return Math.round(value / step) * step;
}

function buildProjectionInterestReply(ctx: CallContext): string {
  const amount = extractLatestContributionAmount(ctx);
  if (amount !== undefined) {
    return `${buildTenYearProjectionLine(amount)} Wäre eine kurze persönliche Zehn-Jahres-Prognose für Sie hilfreich?`;
  }
  return "Wenn man diese Größenordnung mit rund vier Prozent pro Jahr weiterdenkt, entsteht über zehn Jahre ein spürbarer Mehrbetrag. Wäre eine kurze persönliche Zehn-Jahres-Prognose für Sie hilfreich?";
}

function extractLatestContributionAmount(ctx: CallContext): number | undefined {
  const userTurns = ctx.transcript.filter((turn) => turn.role === "user");
  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const parsed = parseGermanEuroAmount(userTurns[index].text);
    if (parsed !== undefined) return parsed;
  }
  const pkvAmount = ctx.topicKind === "pkv" ? parseGermanEuroAmount(collectPkvData(ctx).values.Monatsbeitrag || "") : undefined;
  return pkvAmount;
}

function isDiscoveryObjection(ctx: CallContext, userText: string): boolean {
  const historyText = `${ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ")} ${userText}`.toLowerCase();

  return /(?:was\s+hab\s+ich\s+davon|was\s+bringt\s+mir(?:\s+dieser)?\s+termin|warum\s+sollte\s+ich\s+(?:einen\s+)?termin\s+machen|warum\s+sollte\s+ich\s+das|kein\s+interesse|nicht\s+interessiert|nicht\s+relevant|ich\s+will\s+das\s+nicht|ich\s+brauche\s+keine\s+hilfe|ich\s+halte\s+das\s+f[üu]r\s+nicht\s+notwendig|ich\s+habe\s+keine\s+zeit)/i.test(historyText) ||
    /(?:kein|keine|nicht)\s+(?:nutzen|mehrwert|sinn|interesse|notwendig|hilfe|zeit)/i.test(historyText);
}

function likelyIncompleteCustomerThought(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (/(?:^|\s)(?:wie|was|warum|wieso|ob)$/.test(normalized)) return true;
  if (/(?:^|\s)(?:diese|dieser|dieses|das|seit|aber|und)$/.test(normalized)) return true;
  return /\b(?:ich\s+bin|ich\s+habe|ich\s+kann\s+mir|ich\s+frage\s+mich)\b[^.!?]*\b(?:seit|diese|dieser|dieses|das)\s*$/i.test(normalized);
}

export function buildDeterministicPkvFlowReply(ctx: CallContext, userText: string): TurnOutput | null {
  const isPkv = ctx.topicKind === "pkv";
  if (!isPkv) return null;
  if (ctx.confirmedSlotPhrase) return null;

  const text = userText.toLowerCase();
  const owner = ctx.ownerRealName?.trim() || "Herr Duic";
  const state = detectPkvFlowState(ctx, userText);
  const discoveryObjection = isDiscoveryObjection(ctx, userText);
  const latestAssistant = [...ctx.transcript].reverse().find((turn) => turn.role === "assistant")?.text.toLowerCase() || "";
  const userTurns = ctx.transcript.filter((turn) => turn.role === "user");
  const currentAlreadyInTranscript = userTurns.at(-1)?.text.trim() === userText.trim();
  const previousUserText = (currentAlreadyInTranscript ? userTurns.at(-2) : userTurns.at(-1))?.text.toLowerCase() || "";
  const discoveryConsent = /(?:^|\s)(?:ja(?:,?\s*(?:das\s+d[üu]rfen?\s+sie|das\s+ist\s+klar|klar|gerne|okay|ok)|\s+bitte)?|klar|selbstverständlich|gern(?:e)?)/i.test(userText.trim());

  if (likelyIncompleteCustomerThought(userText)) {
    return null;
  }

  if (isPkv && /darf\s+ich\s+ihnen?\s+in\s+20\s+sekunden\s+sagen,?\s+worum\s+es\s+konkret\s+geht\?|darf\s+ich\s+ihnen?\s+in\s+20\s+sekunden\s+sagen,?\s+worum\s+es\s+geht\?/i.test(latestAssistant) && discoveryConsent) {
    return {
      reply: "Die Beiträge in der Gesundheitsversorgung steigen Jahr für Jahr. Nach Angaben des PKV-Verbands liegen die jährlichen Beitragsanpassungen im Durchschnitt häufig bei etwa drei bis fünf Prozent. Gerade für Unternehmer und Selbstständige ist Planbarkeit wichtig. Wie stark spüren Sie diese Entwicklung bei sich?",
      hangup: false,
      transfer: false,
    };
  }
  const emailOfferOpen = /kurze\s+uebersicht\s+per\s+e-?mail|kurze\s+u[üu]bersicht\s+per\s+e-?mail|per\s+e-?mail\s+senden/.test(
    latestAssistant,
  );
  const assistantHistory = ctx.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text.toLowerCase())
    .join(" \n ");

    if (/per\s+mail|e-?mail|schicken\s+sie\s+mir|senden\s+sie\s+mir|einfach\s+was\s+per\s+mail/i.test(text)) {
    return {
      reply: "Gerne. Ich kann Ihnen eine kurze Übersicht per E-Mail senden. Welche E-Mail-Adresse darf ich dafür notieren?",
      hangup: false,
      transfer: false,
    };
  }

  if (emailOfferOpen && /^(?:ja\b|ja,?\s*das\s+d[üu]rfen\s+sie|gern(?:e)?\b|okay\b|ok\b|passt\b)/i.test(text.trim())) {
    return {
      reply: "Gerne. Welche E-Mail-Adresse darf ich dafür notieren?",
      hangup: false,
      transfer: false,
    };
  }

  const explicitAwaitingInsurance = ctx.flow.awaiting === "insurance_status";
  const customerInsuranceStatusKnown = ctx.transcript
    .filter((turn) => turn.role === "user")
    .some((turn) => hasInsuranceSignal(turn.text));

  const startingQuestionIndex = ctx.transcript.map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "assistant" && /mit\s+welchem\s+beitrag.*(?:angefangen|gestartet)/i.test(turn.text))
    .at(-1)?.index;
  const startingQuestionAnswered = startingQuestionIndex !== undefined && ctx.transcript
    .slice(startingQuestionIndex + 1)
    .some((turn) => turn.role === "user");
  const contributionQuestionInHistory = /erinnern\s+sie\s+sich.*beitrag|mit\s+welchem\s+beitrag.*angefangen/.test(assistantHistory);
  const forgetsStartingContribution = /\b(?:ich\s+weiß\s+es\s+nicht\s+mehr|weiß\s+ich\s+nicht\s+mehr|keine\s+ahnung|nicht\s+mehr)\b/i.test(text);
  const affirmativeShortReply = /^(?:ja|ja,?\s*(?:das\s+)?(?:stimmt|klar|gerne|okay|ok)|klar|stimmt|genau|okay|ok)\s*$/i.test(userText.trim());

  if (!discoveryObjection && typeof latestAssistant === "string" && contributionQuestionInHistory && (affirmsMentally(userText) || forgetsStartingContribution)) {
    return {
      reply: `Herr ${owner.replace(/^Herrn?\s+/i, "")} setzt genau da an. Er schaut sich gemeinsam mit Ihnen die Entwicklung an und prognostiziert bei gleichbleibender Entwicklung, wie sich Ihr Beitrag in den nächsten Jahren verändern kann. Haben Sie sich das schon einmal detailliert angeschaut?`,
      hangup: false,
      transfer: false,
    };
  }

  if (
    !discoveryObjection
    && /mit\s+welchem\s+beitrag.*(?:angefangen|gestartet)/i.test(latestAssistant)
  ) {
    const startingContribution = extractLatestContributionPhrase(userText);
    if (startingContribution) {
      return {
        reply: `Herr ${owner.replace(/^Herrn?\s+/i, "")} setzt genau da an. Er schaut sich gemeinsam mit Ihnen die Entwicklung an und prognostiziert bei gleichbleibender Entwicklung, wie sich Ihr Beitrag in den nächsten Jahren verändern kann. Haben Sie sich das schon einmal detailliert angeschaut?`,
        hangup: false,
        transfer: false,
      };
    }
    if (forgetsStartingContribution) {
      return {
        reply: `Herr ${owner.replace(/^Herrn?\s+/i, "")} setzt genau da an. Er schaut sich gemeinsam mit Ihnen die Entwicklung an und prognostiziert bei gleichbleibender Entwicklung, wie sich Ihr Beitrag in den nächsten Jahren verändern kann. Haben Sie sich das schon einmal detailliert angeschaut?`,
        hangup: false,
        transfer: false,
      };
    }
    return {
      reply: `Herr ${owner.replace(/^Herrn?\s+/i, "")} setzt genau da an. Er schaut sich gemeinsam mit Ihnen die Entwicklung an und prognostiziert bei gleichbleibender Entwicklung, wie sich Ihr Beitrag in den nächsten Jahren verändern kann. Haben Sie sich das schon einmal detailliert angeschaut?`,
      hangup: false,
      transfer: false,
    };
  }

  if (!discoveryObjection && /wie\s+(?:(?:sehr|stark)\s+)?sp[üu]ren\s+sie|wie\s+erleben\s+sie.*beitragsentwicklung/.test(assistantHistory) && !/erinnern\s+sie\s+sich.*beitrag|mit\s+welchem\s+beitrag.*angefangen/.test(assistantHistory)) {
    return {
      reply: "Das höre ich oft. Wenn Sie zurückblicken: Erinnern Sie sich noch, mit welchem Beitrag Sie angefangen haben?",
      hangup: false,
      transfer: false,
    };
  }

  if (!discoveryObjection && /detailliert.*angeschaut|prognostiziert/.test(assistantHistory) && /^(?:nein|ne|nö|nö\?|kein\s+interesse|eher\s+nicht|nicht)\b/i.test(text.trim())) {
    return {
      reply: "Genau deshalb lohnt der Blick. Sind Sie aktuell privat oder gesetzlich versichert?",
      hangup: false,
      transfer: false,
    };
  }

  if (!discoveryObjection && (startingQuestionAnswered || /mit\s+welchem\s+beitrag.*angefangen/i.test(latestAssistant)) && contributionQuestionInHistory && forgetsStartingContribution) {
    return {
      reply: `Herr ${owner.replace(/^Herrn?\s+/i, "")} setzt genau da an. Er schaut sich gemeinsam mit Ihnen die Entwicklung an und prognostiziert bei gleichbleibender Entwicklung, wie sich Ihr Beitrag in den nächsten Jahren verändern kann. Haben Sie sich das schon einmal detailliert angeschaut?`,
      hangup: false,
      transfer: false,
    };
  }

  const isSplitHowQuestion = /wie\s+(?:herr\s+)?(?:dui(?:c|ch|tsch)|er)\b/.test(previousUserText)
    && /^das\s+machen\s+m[öo]chte\b/.test(text);
  if (/wie\s+(?:will|m[öo]chte|soll)\s+(?:herr\s+)?(?:dui(?:c|ch|tsch)|er)\s+das\s+machen|wie\s+er\s+das\s+machen\s+m[öo]chte|wie\s+funktioniert\s+das|welche\s+m[öo]glichkeiten\s+w[äa]ren/.test(text) || isSplitHowQuestion) {
    return {
      reply: `Ja, genau darum geht es: ${owner} schaut sich Ihren heutigen Stand an, rechnet die Entwicklung auf Ihre Zahlen durch und prüft dann konkrete Handlungsmöglichkeiten wie Tarifstruktur, Selbstbehalt oder Entlastungsbausteine. Im Termin sehen Sie also anhand Ihrer eigenen Zahlen, wie die Prognose entsteht und welche Optionen überhaupt zu Ihrer Situation passen.`,
      hangup: false,
      transfer: false,
    };
  }

  if (!explicitAwaitingInsurance && !discoveryObjection && !customerInsuranceStatusKnown && !/wie\s+(?:(?:sehr|stark)\s+)?sp[üu]ren\s+sie|wie\s+erleben\s+sie.*beitragsentwicklung/.test(assistantHistory)) {
      return {
        reply: "Die Beiträge in der Gesundheitsversorgung steigen Jahr für Jahr. Nach Angaben des PKV-Verbands liegen die jährlichen Beitragsanpassungen im Durchschnitt häufig bei etwa drei bis fünf Prozent. Gerade für Unternehmer und Selbstständige ist Planbarkeit wichtig. Wie stark spüren Sie diese Entwicklung bei sich?",
        hangup: false,
        transfer: false,
      };
  }

  if (/^(?:also|hm+|mhm|na\s*ja|ja|okay|ok)\s*$/i.test(userText.trim())) {
    return {
      reply: "Verstehe. Damit ich es sauber einordnen kann: Sind Sie aktuell privat oder gesetzlich versichert?",
      hangup: false,
      transfer: false,
    };
  }

  if (/was\s+soll\s+bei\s+diesem\s+termin|was\s+wird\s+gemacht|wof[üu]r\s+ist\s+der\s+termin/.test(text)) {
    if (state === "need_contribution") {
      return {
        reply: `Gute Frage: ${owner} macht mit Ihnen eine persönliche Vertragsanalyse und eine realistische Zehn-Jahres-Prognose, damit Sie Klarheit und konkrete Handlungsmöglichkeiten bekommen. Wenn Sie möchten: In welcher Größenordnung liegt Ihr Monatsbeitrag aktuell?`,
        hangup: false,
        transfer: false,
      };
    }
    return {
      reply: `Gute Frage: ${owner} zeigt Ihnen im Termin die persönliche Beitragsprognose bis in zehn Jahre und konkrete Handlungsmöglichkeiten für mehr Planbarkeit. Wäre so eine klare Einordnung für Sie hilfreich?`,
      hangup: false,
      transfer: false,
    };
  }

  if (/was\s+hab\s+ich\s+davon|was\s+bringt\s+mir\s+(?:dieser\s+)?termin|warum\s+sollte\s+ich\s+einen\s+termin\s+machen/.test(text)) {
    return {
      reply: `Sie bekommen vor allem drei Dinge: erstens eine konkrete Hochrechnung auf Ihre eigenen Beiträge, zweitens Klarheit, ob überhaupt Handlungsbedarf besteht, und drittens konkrete Handlungsmöglichkeiten statt nur allgemeiner Aussagen. Wäre so eine nüchterne Einordnung für Sie grundsätzlich hilfreich?`,
      hangup: false,
      transfer: false,
    };
  }

  if (/normal|ist\s+ja\s+auch\s+normal/.test(text) && state === "need_interest") {
    return {
      reply: "Genau das sagen viele. Normal klingt harmlos, aber auf die eigene Zahl gerechnet wird es oft erst richtig greifbar. Wie sehr spüren Sie diese Entwicklung bei sich?",
      hangup: false,
      transfer: false,
    };
  }

  if (state === "need_insurance") {
    if (/^ich\s+bin(?:\s+da)?\.?$/i.test(text.trim())) {
      return {
        reply: "Sprechen Sie den Satz gern noch kurz zu Ende: Sind Sie privat oder gesetzlich versichert?",
        hangup: false,
        transfer: false,
      };
    }
    return {
      reply: "Genau deshalb lohnt der Blick. Sind Sie aktuell privat oder gesetzlich versichert?",
      hangup: false,
      transfer: false,
    };
  }

  if (state === "need_contribution") {
    const contributionQuestionAsked = ctx.transcript.some(
      (turn) =>
        turn.role === "assistant" && /(?:monatsbeitrag|gr[öo]ßenordnung).*(?:beitrag|euro)|wie\s+hoch.*beitrag/i.test(turn.text),
    );
    return {
      reply: contributionQuestionAsked
        ? "Wenn es für Sie passt, reicht eine grobe Spanne in Euro, damit ich den Zehn-Jahres-Effekt sauber einordnen kann."
        : "Wenn Sie mir Ihren aktuellen Beitrag nennen, kann ich Ihnen direkt prognostizieren, wie sich Ihr Beitrag über zehn Jahre entwickeln könnte. Wie hoch ist Ihr aktueller Monatsbeitrag?",
      hangup: false,
      transfer: false,
    };
  }

  if (state === "need_projection") {
    const amount = extractLatestContributionAmount(ctx);
    const line = amount !== undefined
      ? buildTenYearProjectionLine(amount)
      : "Bei Ihrem aktuellen Beitrag entsteht über zehn Jahre voraussichtlich ein spürbarer Mehrbetrag.";
    return {
      reply: `${line} Stellen Sie sich vor: Sie und ${owner} sitzen nächste Woche in Ruhe zusammen. Im ersten Termin analysiert er Ihre persönliche Situation und zeigt Ihnen anhand Ihrer Zahlen, wie sich Ihr Beitrag bis zum Ruhestand entwickeln kann und welche Möglichkeiten Sie heute prüfen können, damit Sie später keine böse Überraschung erleben. Es geht ausdrücklich nicht um einen schnellen Abschluss, sondern um drei aufeinander aufbauende Gespräche: Kennenlernen und Analyse, Vorstellung des individuellen Konzepts sowie anschließend Abschluss und offene Fragen. Wäre diese Klarheit für Sie ein echter Mehrwert?`,
      hangup: false,
      transfer: false,
    };
  }

  if (state === "need_interest") {
    if (/^(?:nein|ne|nö|nö\?|nein\?|kein\s+interesse|eher\s+nicht)\b/i.test(text.trim())) {
      return {
        reply: "Verstanden, dann möchte ich Sie nicht weiter aufhalten. Vielen Dank für Ihre Zeit und einen angenehmen Tag.",
        hangup: true,
        transfer: false,
      };
    }
    return {
      reply: `Mir geht es um Klarheit statt Verkauf: Wäre so eine persönliche Einordnung mit ${owner} grundsätzlich hilfreich für Sie?`,
      hangup: false,
      transfer: false,
    };
  }

  if (state === "ready_for_schedule") {
    const offeredSlots = extractFreeSlotPhrases(ctx.freeSlotsPrompt);
    const latestAssistant = [...ctx.transcript].reverse().find((turn) => turn.role === "assistant")?.text || "";
    const latestOfferedReply = [...ctx.transcript]
      .reverse()
      .find((turn) => turn.role === "assistant" && offeredSlots.filter((slot) => turn.text.includes(slot)).length >= 2)
      ?.text || latestAssistant;
    const hasAppointmentBridge = ctx.transcript.some(
      (turn) => turn.role === "assistant" && /kein(?:en)?\s+schnellabschluss|drei\s+(?:termine|gespräche)|ersten?\s+termin.*analyse/i.test(turn.text),
    );
    if (!hasAppointmentBridge && /zehn\s+jahr|prognose|hochrechn/i.test(latestAssistant.toLowerCase())) {
      return {
        reply: `Stellen Sie sich vor: Sie und ${owner} sitzen nächste Woche in Ruhe zusammen. Im ersten Termin analysiert er Ihre persönliche Situation und zeigt Ihnen anhand Ihrer Zahlen, wie sich Ihr Beitrag bis zum Ruhestand entwickeln kann und welche Möglichkeiten Sie heute prüfen können, damit Sie später keine böse Überraschung erleben. Es geht dabei ausdrücklich nicht um einen schnellen Abschluss, sondern um drei aufeinander aufbauende Gespräche: Kennenlernen und Analyse, Vorstellung des Konzepts sowie anschließend Abschluss und offene Fragen. Wäre diese Klarheit für Sie ein echter Mehrwert?`,
        hangup: false,
        transfer: false,
      };
    }
    const offeredInLatestReply = offeredSlots.filter((slot) => latestOfferedReply.includes(slot));
    if (offeredInLatestReply.length >= 2) {
      const selected = selectOfferedSlot(latestOfferedReply, userText, offeredSlots);
      if (selected) {
        return {
          reply: `Perfekt, ich notiere ${selected} für Sie.`,
          hangup: false,
          transfer: false,
        };
      }
      return {
        reply: "Welcher der beiden Termine passt Ihnen besser?",
        hangup: false,
        transfer: false,
      };
    }

    const preference = /vormittag|morgens|fr[üu]h/i.test(text)
      ? "morning"
      : /nachmittag|mittags|sp[äa]ter/i.test(text)
        ? "afternoon"
        : undefined;
    if (!preference) {
      return {
        reply: "Passt für Sie eher ein Termin am Vormittag oder am Nachmittag?",
        hangup: false,
        transfer: false,
      };
    }

    const matchingSlots = offeredSlots.filter((slot) => {
      const hour = extractSlotHour(slot);
      return hour !== undefined && (preference === "morning" ? hour < 12 : hour >= 12);
    });
    const slots = (matchingSlots.length >= 2 ? matchingSlots : offeredSlots).slice(0, 2);
    if (slots.length >= 2) {
      return {
        reply: `Wie wäre es mit ${slots[0]} oder ${slots[1]}?`,
        hangup: false,
        transfer: false,
      };
    }

    return {
      reply: "Einen kurzen Moment bitte, ich gleiche die passenden freien Termine gerade mit dem Kalender ab.",
      hangup: false,
      transfer: false,
    };
  }

  return null;
}

function extractFreeSlotPhrases(prompt?: string): string[] {
  if (!prompt) return [];
  return prompt
    .split("\n")
    .map((line) => normalizeSpokenSlot(line.match(/^\s*-\s+(.+?)\s*$/)?.[1]?.trim() || ""))
    .filter(Boolean);
}

function normalizeSpokenSlot(slot: string): string {
  const ordinal: Record<number, string> = {
    1: "ersten", 2: "zweiten", 3: "dritten", 4: "vierten", 5: "fünften", 6: "sechsten", 7: "siebten", 8: "achten", 9: "neunten", 10: "zehnten", 11: "elften", 12: "zwölften", 13: "dreizehnten", 14: "vierzehnten", 15: "fünfzehnten", 16: "sechzehnten", 17: "siebzehnten", 18: "achtzehnten", 19: "neunzehnten", 20: "zwanzigsten", 21: "einundzwanzigsten", 22: "zweiundzwanzigsten", 23: "dreiundzwanzigsten", 24: "vierundzwanzigsten", 25: "fünfundzwanzigsten", 26: "sechsundzwanzigsten", 27: "siebenundzwanzigsten", 28: "achtundzwanzigsten", 29: "neunundzwanzigsten", 30: "dreißigsten", 31: "einunddreißigsten",
  };
  return slot
    .replace(/\b(\d{1,2})\.\s+([A-Za-zÄÖÜäöü]+)\b/g, (_, day, month) => `den ${ordinal[Number(day)] || numberToGermanWords(Number(day))} ${month}`)
    .replace(/\b(\d{1,2}):([0-5]\d)\s*uhr\b/gi, (_, hour, minute) => Number(minute) === 0 ? `${numberToGermanWords(Number(hour))} Uhr` : `${numberToGermanWords(Number(hour))} Uhr ${numberToGermanWords(Number(minute))}`)
    .replace(/\bUhr\s+null\b/gi, "Uhr")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSlotHour(slot: string): number | undefined {
  const numeric = slot.match(/\b(\d{1,2})(?::\d{2})?\s*uhr\b/i);
  if (numeric) return Number.parseInt(numeric[1], 10);
  const words: Record<string, number> = {
    neun: 9, zehn: 10, elf: 11, zwölf: 12, zwoelf: 12, dreizehn: 13, vierzehn: 14,
    fünfzehn: 15, fuenfzehn: 15, sechzehn: 16, siebzehn: 17, achtzehn: 18,
  };
  const match = slot.match(/\b(neun|zehn|elf|zw[öo]lf|dreizehn|vierzehn|f[üu]nfzehn|sechzehn|siebzehn|achtzehn)\s+uhr\b/i);
  if (!match) return undefined;
  return words[match[1].toLowerCase()];
}

function selectOfferedSlot(latestAssistant: string, userText: string, offeredSlots: string[]): string | undefined {
  const lowerUser = userText.toLowerCase();
  const offered = offeredSlots.filter((slot) => latestAssistant.includes(slot));
  if (offered.length < 2) return undefined;
  if (/\b(?:der|den)\s+erste[nr]?\b|\berste[nr]?\b/i.test(lowerUser)) return offered[0];
  if (/\b(?:der|den)\s+zweite[nr]?\b|\bzweite[nr]?\b/i.test(lowerUser)) return offered[1];
  if (/der\s+sp[äa]tere|sp[äa]tere[nr]?\b/i.test(lowerUser)) return offered[1];
  return offered.find((slot) => {
    const hour = extractSlotHour(slot);
    return hour !== undefined && (new RegExp(`\\b${hour}\\b`).test(lowerUser) || lowerUser.includes(numberToGermanWords(hour)));
  });
}

function isDanglingContinuation(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.length > 95) return false;
  return /^(?:um|und|oder|damit|wobei|sowie|denn|also)\b/i.test(t);
}

function containsEarlySchedulingQuestion(text: string): boolean {
  return /\b(termin|vormittag|nachmittag|welcher\s+tag|wann\s+passt|w[üu]rde\s+.*\stermin|h[äa]tten\s+sie\s+interesse\s+an\s+einem\s+termin)\b/i.test(
    text,
  );
}

function isPkvSchedulingReady(ctx: CallContext): boolean {
  if (canScheduleFromFlow(ctx.flow)) {
    return true;
  }
  // Structured PKV state is authoritative. Keyword heuristics must not allow
  // a free-form OpenAI answer to schedule before the required steps are done.
  if (ctx.topicKind === "pkv") return false;
  const userText = ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text.toLowerCase())
    .join(" \n ");
  const assistantText = ctx.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text.toLowerCase())
    .join(" \n ");

  const insuranceKnown = hasInsuranceSignal(userText);
  const contributionKnown = hasCurrentContributionSignal(ctx, userText);
  const projectionGiven =
    /zehn\s+jahr|10\s+jahr|bis\s+zum\s+ruhend?stand|hochrechn|projektion|beitragsprognose/.test(
      assistantText,
    );
  const interestConfirmed = ctx.transcript
    .filter((turn) => turn.role === "user")
    .some((turn) => /\b(ja|gern|gerne|hilfreich|interessant|macht\s+sinn|klingt\s+gut|ok|okay)\b/i.test(turn.text));
  return insuranceKnown && contributionKnown && projectionGiven && interestConfirmed;
}

function buildPkvDiscoveryQuestion(ctx: CallContext, userText: string): string {
  const userHistory = `${ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join(" ")} ${userText}`.toLowerCase();

  const insuranceKnown = hasInsuranceSignal(userHistory);
  const contributionKnown = hasCurrentContributionSignal(ctx, userText);
  const contributionQuestionAsked = ctx.transcript.some(
    (turn) =>
      turn.role === "assistant" && isCurrentContributionQuestion(turn.text),
  );

  if (!insuranceKnown) {
    return "Verstanden, und genau deshalb lohnt der Blick. Sind Sie aktuell privat oder gesetzlich versichert?";
  }
  if (!contributionKnown) {
    if (contributionQuestionAsked) {
      return "Verstehe. Wenn es für Sie passt, reicht eine grobe Spanne in Euro, damit ich die Zehn-Jahres-Entwicklung sauber einordnen kann.";
    }
    return "Danke, das ist ein wichtiger Punkt. Wenn Sie möchten: In welcher Größenordnung liegt Ihr aktueller Monatsbeitrag?";
  }
  return buildProjectionInterestReply(ctx);
}

function hasInsuranceSignal(text: string): boolean {
  return /\b(privat(?:e[nrsm]?\s+krankenversicherung)?|pkv|gesetzlich(?:e[nrsm]?\s+krankenversicherung)?|gkv)\b/i.test(
    text,
  );
}

function hasContributionSignal(text: string): boolean {
  if (/\b(?:\d{2,4}(?:[.,:]\d{1,2})?)\b[^\n.?!]{0,16}\b(?:euro|€)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:beitrag|kosten|monatlich)\b[^\n.?!]{0,30}\b(?:euro|€|tausend|hundert)\b/i.test(text)) {
    return true;
  }
  if (/\b(?:tausend|hundert|einhundert|zweihundert|dreihundert|vierhundert|f[üu]nfhundert|sechshundert|siebenhundert|achthundert|neunhundert)\w*\s+euro\b/i.test(text)) {
    return true;
  }
  return false;
}

function hasCurrentContributionSignal(ctx: CallContext, userText: string): boolean {
  const turns = ctx.transcript.some(
    (turn) => turn.role === "user" && turn.text === userText,
  )
    ? ctx.transcript
    : [...ctx.transcript, { role: "user" as const, text: userText, at: Date.now() }];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== "assistant" || !isCurrentContributionQuestion(turn.text)) continue;

    const answer = turns
      .slice(index + 1)
      .find((candidate) => candidate.role === "user")?.text || "";
    if (parseGermanEuroAmount(answer) !== undefined) return true;
  }

  return false;
}

function hasCurrentProjection(ctx: CallContext): boolean {
  const turns = ctx.transcript;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.role !== "assistant" || !isCurrentContributionQuestion(turn.text)) continue;

    const answerIndex = turns.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.role === "user");
    if (answerIndex < 0) continue;
    const followingAssistant = turns
      .slice(answerIndex + 1)
      .find((candidate) => candidate.role === "assistant")?.text || "";
    if (/zehn\s+jahr|10\s+jahr|hochrechn|projektion|beitragsprognose|läge[n]?\s+.*beitrag|beitrag.*steigen|pro\s+jahr/.test(followingAssistant.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function isCurrentContributionQuestion(text: string): boolean {
  return /(?:aktuell\w*|derzeit\w*|heutig\w*)\s+(?:monatlich\w*\s+)?beitrag|bei\s+welchem\s+beitrag|monatsbeitrag|gr[öo]ßenordnung[^.?!]{0,30}(?:aktuell|heute|monat)|wie\s+hoch[^.?!]{0,30}beitrag/i.test(
    text,
  );
}

function consentAlreadyGranted(ctx: CallContext): boolean {
  // Suche im Transkript: Gloria hat "aufzeichnen" gefragt UND danach hat der
  // Anrufende eine klare Zustimmung gegeben. Das muss auch bei Rueckfragen wie
  // "Duerfen Sie?" robust funktionieren.
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.role !== "assistant" || !/aufzeichn|mitschneid/i.test(t.text)) continue;
    for (let j = i + 1; j < turns.length; j++) {
      const turn = turns[j];
      if (turn.role !== "user") continue;
      const decision = parseRecordingConsentDecision(turn.text);
      if (decision === "granted") {
        return true;
      }
      if (decision === "declined") {
        return false;
      }
    }
  }
  return false;
}

function parseRecordingConsentDecision(text: string): "granted" | "declined" | null {
  const ans = text.toLowerCase().trim();

  // Eindeutige Zustimmung.
  if (
    /^(ja\b|jawohl|gerne|in ordnung|einverstanden|okay|ok\b|geht klar|kein problem|nat[üu]rlich|klar\b)/i.test(ans) ||
    /\b(sie\s+k[öo]nnen\s+gerne\s+aufzeichn|k[öo]nnen\s+sie\s+gern\s+aufzeichn|d[üu]rfen\s+sie\b|ja,?\s+d[üu]rfen\s+sie)\b/i.test(ans)
  ) {
    return "granted";
  }

  // Eindeutige Ablehnung.
  if (/^(nein\b|n[öo]\b|lieber nicht|bitte nicht|keine aufzeichnung|nicht aufzeichnen)/i.test(ans)) {
    return "declined";
  }

  return null;
}

function stripConsentQuestion(text: string): string {
  // Entferne ganze Sätze, die nach Aufzeichnungs-Einwilligung fragen.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s) => !/aufzeichn|mitschneid/i.test(s) && !/\bja\s+oder\s+nein\b/i.test(s));
  const result = filtered.join(" ").trim();
  if (result) return result;
  // Wenn die LLM-Antwort komplett aus der Aufzeichnungs-Frage bestand
  // (z. B. nach Termin-Bestätigung), gib eine neutrale Brücke zurück, damit
  // der Anruf weiterläuft, ohne die Einwilligung erneut einzufordern.
  return "Vielen Dank. Lassen Sie uns gleich mit einigen kurzen Basisangaben weitermachen.";
}

function buildSystemPrompt(ctx: CallContext): string {
  const company = ctx.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel";
  const owner = ctx.ownerRealName?.trim() || "Matthias Duic";
  const ownerDative = /^Herr(n|n\b|n\s)/i.test(owner) ? owner : `Herrn ${owner}`;
  const compactPrompt = parseEnvBool("LLM_COMPACT_PROMPT", true);
  const parts = [
    compactPrompt
      ? buildCompactConversationPrimer(ctx, company, owner, ownerDative)
      : buildConversationPrimer(ctx, company, owner, ownerDative),
  ];
  const today = new Date();
  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });
  parts.push(`Heute ist ${todayStr}. Nutze dieses Datum, um konkrete Wochentage und Daten für Terminvorschläge zu berechnen.`);
  if (ctx.ownerRealName) parts.push(`Du sprichst im Auftrag von ${ctx.ownerRealName}. Wenn du dich vorstellst oder gefragt wirst, in wessen Auftrag du anrufst, nenne IMMER ${ctx.ownerRealName} – NIEMALS den Namen des gewünschten Ansprechpartners.`);
  if (ctx.ownerCompanyName) parts.push(`Auftraggeber: ${ctx.ownerCompanyName}.`);
  if (ctx.ownerGesellschaft) {
    parts.push(
      `\n\nGESELLSCHAFT (nur auf Nachfrage erwähnen): ${ctx.ownerRealName || "der Auftraggeber"} ist für die Gesellschaft "${ctx.ownerGesellschaft}" tätig. ` +
      `WICHTIG: Erwähne diese Information NUR, wenn der Anrufende ausdrücklich danach fragt (z. B. "Zu welcher Gesellschaft gehören Sie?", "Für wen arbeitet ${ctx.ownerRealName || "Herr Duic"}?", "Welche Versicherung?"). ` +
      `Sage in dem Fall: "${ctx.ownerRealName || "Der Auftraggeber"} ist für die Gesellschaft ${ctx.ownerGesellschaft} tätig." ` +
      `Bei der Vorstellung, im Smalltalk oder unaufgefordert: ERWÄHNE DIE GESELLSCHAFT NICHT.`,
    );
  }
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.contactName) parts.push(`Gewünschter Ansprechpartner bei ${ctx.company || "der angerufenen Firma"}: ${ctx.contactName}. WICHTIG: ${ctx.contactName} ist die Person, mit der du sprechen MÖCHTEST – NICHT dein Auftraggeber. Sage NIEMALS "Ich rufe im Auftrag von ${ctx.contactName}". ROLLENLOGIK: Starte standardmäßig im Gatekeeper-Modus und bitte um Weiterleitung zu ${ctx.contactName}. Wenn die angesprochene Person klar signalisiert, dass sie selbst ${ctx.contactName} ist oder bereits zuständig am Apparat ist, wechsle sofort in den Entscheider-Modus.`);
  if (ctx.leadNote?.trim()) parts.push(`Leitkontext aus der Firmenliste: ${ctx.leadNote.trim()}`);
  if (ctx.topic) parts.push(`Thema: ${ctx.topic}.`);
  if (ctx.confirmedSlotPhrase) {
    parts.push(
      `\n\nBESTÄTIGTER TERMIN (eingefroren – keine Änderung erlaubt): "${ctx.confirmedSlotPhrase}". ` +
      `In Phase 10 (Schluss-Zusammenfassung) MUSST du in dem Satz "Ihr persönlicher Termin mit Herrn Duic ist am …" GENAU diese Phrase einsetzen, Wort für Wort. ` +
      `Erfinde KEINEN anderen Wochentag, KEIN anderes Datum und KEINE andere Uhrzeit.`,
    );
  }
  if (ctx.isCallback && ctx.previousSummary) {
    parts.push(
      `\n\nWIEDERVORLAGE-ANRUF (KRITISCH — überschreibt den Standard-Phasen-Einstieg!): ` +
      `Dies ist ein zuvor mit dem Anrufenden vereinbarter Rückruf. Es gab bereits ein Gespräch. ` +
      `Zusammenfassung des letzten Gesprächs: «${ctx.previousSummary}». ` +
      `Eröffnungs-Regel für diesen Anruf: ` +
      `(1) Begrüße den Anrufenden kurz mit Namen, stelle dich erneut als Gloria vor und erwähne, dass du wie vereinbart zurückrufst. ` +
      `(2) Fasse in EINEM kurzen Satz den Stand des letzten Gesprächs zusammen (nicht die ganze Zusammenfassung — nur das Wesentliche, z. B. "Wir hatten uns letztes Mal über Ihre Krankenversicherungsbeiträge unterhalten und wollten heute den Termin festmachen."). ` +
      `(3) Frage DIREKT nach dem Termin — gehe sofort in Phase 7 (Tageszeit-Präferenz Vormittag/Nachmittag, dann konkrete Slots). ` +
      `STRENG: KEINE erneute Aufzeichnungs-Frage (Einwilligung gilt fort). KEINE erneute Discovery / Phase 4. KEINE erneute Vorstellung von Thema oder Konzept. KEIN erneutes "Haben Sie kurz Zeit?".`,
    );
  }
  if (ctx.topicPolicyPrompt) {
    parts.push(
      "\n\nTOPIC-POLICY-NUTZUNG: Verwende die Topic Policy als Leitplanke für Richtung, Nutzen und Compliance - NICHT als Vorlesetext. " +
      "Formuliere jede Antwort frisch aus dem Moment, passend zum letzten Kundensatz.",
    );
    parts.push("\n\n" + ctx.topicPolicyPrompt);
  }
  if (ctx.busySlotsPrompt) parts.push("\n\n" + ctx.busySlotsPrompt);
  if (ctx.freeSlotsPrompt) parts.push("\n\n" + ctx.freeSlotsPrompt);
  const memoryBlock = buildMemoryBlock(ctx);
  if (memoryBlock) parts.push("\n\n" + memoryBlock);
  const styleBlock = buildStyleGuard(ctx);
  if (styleBlock) parts.push("\n\n" + styleBlock);
  parts.push(
    `\n\nANTWORTFORMAT: Antworte ausschließlich als JSON: {"reply": "deutscher Antworttext", "hangup": false, "transfer": false}. ` +
    `Gib die Schlüssel zwingend in dieser Reihenfolge aus: reply, hangup, transfer. Beginne den reply sofort und ohne interne Vorbemerkung. ` +
    `Setze hangup=true nur wenn der Anrufende ein klares Nein signalisiert oder das Gespräch sauber beendet wurde. ` +
    `Setze transfer=true (und hangup=false) wenn du den Anrufenden an Frau Brost weiterleitest — NUR wenn er das ausdrücklich wünscht.`,
  );
  return parts.join("\n");
}

function buildCompactConversationPrimer(ctx: CallContext, company: string, owner: string, ownerDative: string): string {
  const topic = (ctx.topic || "").toLowerCase();
  const isPKV = /pkv|kranken/.test(topic);
  const phase = inferConversationPhase(ctx);

  const lines: string[] = [
    `Du bist Gloria, die digitale Vertriebsassistentin von ${company}. Du rufst im Auftrag von ${owner} an.`,
    `Stil: natürlich, ruhig, professionell, kurze Telefon-Sätze. Kein Skriptklang.`,
    `Antwortformat: JSON mit Schlüsseln in dieser Reihenfolge: reply, hangup, transfer.`,
    `Maximal 1-2 kurze Sätze plus genau eine klare Frage pro Turn.`,
    `Keine erfundene Vertrautheit. Es ist ein Erstkontakt.`,
    `Nenne bei Vorstellung und Auftrag immer ${owner}. Niemals den Zielkontakt als Auftraggeber.`,
    `Aufzeichnungsfrage nur einmal. Bei Nein normal weiterführen, nie erneut fragen.`,
    `Terminart ist persönlicher Vor-Ort-Termin mit ${ownerDative}, kein Telefontermin.`,
    `hangup=true nur mit echter Verabschiedung. transfer=true nur bei ausdrücklichem Wunsch nach menschlicher Weiterleitung.`,
  ];

  if (ctx.contactName) {
    lines.push(`Zielkontakt: ${ctx.contactName}. Starte mit Gatekeeper-Logik und bitte um Weiterleitung.`);
  }
  if (ctx.leadNote?.trim()) {
    lines.push(`Leitkontext: ${ctx.leadNote.trim()}`);
  }
  if (ctx.confirmedSlotPhrase) {
    lines.push(`Termin ist eingefroren: "${ctx.confirmedSlotPhrase}". Nicht ändern.`);
  }

  if (phase <= 2) {
    lines.push(`Phase: Opener + Anlass + ggf. Aufzeichnungsfrage. Keine Datenerhebung, kein Pitch-Block.`);
  } else if (phase <= 6) {
    lines.push(`Phase: Relevanz aufbauen, ein konkreter Nutzenpunkt, dann Rückfrage. Noch keine harte Termin-Schließung.`);
  } else if (phase === 7) {
    lines.push(`Phase: Terminierung mit zwei konkreten Slots aus nächster Woche.`);
  } else if (phase === 8) {
    lines.push(`Phase: Nach bestätigtem Termin genau eine Vorbereitungsfrage pro Turn.`);
  } else if (phase >= 10) {
    lines.push(`Phase: E-Mail für Bestätigung, dann kurze Abschlusszusammenfassung.`);
  }

  if (isPKV) {
    lines.push(`PKV-Kontext: mit konkreten Kundenzahlen arbeiten, keine Quellen-Claims, keine Monologe.`);
  }

  return lines.join("\n");
}

function buildConversationPrimer(ctx: CallContext, company: string, owner: string, ownerDative: string): string {
  const topic = (ctx.topic || "").toLowerCase();
  const isPKV = /pkv|kranken/.test(topic);
  const isCommercialInsurance = /gewerb|haftpflicht|cyber|inhalt|sachversicher|risikoschutz/.test(topic);
  const phase = inferConversationPhase(ctx);
  const lines: string[] = [];

  // IDENTITY + GOAL
  lines.push(
    `Du bist Gloria, die digitale Vertriebsassistentin von ${company}. Du rufst im Auftrag von ${owner} an.`,
    `AKQUISE-KONTEXT: Die angerufene Person hatte noch nie Kontakt zu euch. Behaupte oder suggeriere niemals eine bestehende Beziehung, Empfehlung oder vorherige Anfrage. Rechne zu Beginn mit gesunder Skepsis.`,
    `Dein erstes Ziel ist nicht der Termin, sondern dass die Person nach zehn Sekunden versteht: Wer ruft an, warum gerade dieses Thema und dass sie jederzeit Nein sagen darf. Erst wenn Relevanz und ein Mindestmaß an Vertrauen da sind, führst du zum Termin.`,
    `Deine Art: warm, ruhig, direkt und transparent. Du arbeitest als digitale Assistentin - professionell, klar und ohne Skriptklang.`,
    `PREMIUM-MODUS (VERBINDLICH): Klinge wie ein erfahrener Senior-Call-Agent mit Beratungsanspruch - praezise, respektvoll, fuehrungsstark, nie aufdringlich. Kein Callcenter-Slang, keine Floskeln, keine kuenstliche Euphorie.`,
    `PREMIUM-OPENER (VERBINDLICH IM ERSTKONTAKT): (1) klare Vorstellung in einem Satz, (2) konkreter Anlass in einem Satz, (3) kurze Erlaubnisfrage in einem Satz. Maximal drei kurze Saetze, dann Pause.`,
    `PREMIUM-RHYTHMUS: Jede Antwort beginnt mit einem konkreten Bezug auf den letzten Kundengedanken und fuehrt dann mit genau einer klaren Frage weiter.`,
    `KUNDENFRAGE HAT VORRANG: Wenn der Kunde eine Frage, einen Einwand oder eine Erklärung zu deinem Vorgehen stellt, pausierst du den geplanten Gesprächsschritt. Beantworte zuerst genau diese Frage inhaltlich und greife mindestens ein konkretes Wort des Kunden auf. Kehre erst danach ruhig zum Gesprächsziel zurück. Niemals eine neue Termin-, Beitrags- oder Skriptfrage senden, solange die Kundenfrage unbeantwortet ist.`,
    `FAKTENREGEL: Erfinde keine Prozentwerte, Durchschnittswerte, Quellen oder Marktbehauptungen. Verwende Zahlen nur, wenn sie im freigegebenen Gesprächskontext ausdrücklich vorgegeben oder aus den Kundenzahlen berechnet wurden. Vor einer bestätigten Versicherungsart sage nie "private Krankenversicherung" als Tatsache.`,
    `KUNDENFRAGE HAT VORRANG: Wenn der Kunde eine Frage, einen Einwand oder eine Erklärung zu deinem Vorgehen stellt, pausierst du den geplanten Gesprächsschritt. Beantworte zuerst genau diese Frage inhaltlich und greife mindestens ein konkretes Wort des Kunden auf. Kehre erst danach ruhig zum Gesprächsziel zurück. Niemals eine neue Termin-, Beitrags- oder Skriptfrage senden, solange die Kundenfrage unbeantwortet ist.`,
    `ANTWORTLAENGE (VERBINDLICH): Maximal 1 kurzer Satz als Reaktion, dann sofort 1 Frage. KEIN Daten-Pitch, KEINE Statistiken, KEINE Erklaerungen bevor nicht bekannt ist, was der Kunde konkret bezahlt oder wo er steht. Erst fragen, dann einordnen.`,
    `ZAHLEN-KONTEXT: Wenn der Kunde in einem vorherigen Satz eine Zahl begann (z.B. "tausend") und im naechsten Turn eine weitere Zahl nennt (z.B. "zweihundertachtzig"), kombiniere beides zum vollstaendigen Betrag (z.B. 1280 Euro) und bestaettige diesen kombinierten Wert.`,
    `Pro Antwort: meist 1-2 kurze Sätze, höchstens eine Hauptfrage. Dann Pause. Wirklich zuhören.`,
  );

  // TOPIC KNOWLEDGE — verinnerlichen, nicht ablesen
  if (isPKV) {
    lines.push(
      ``,
      `WAS DU ÜBER DAS THEMA WEISST (verinnerlichen — nicht ablesen, nicht zitieren):`,
      `Krankenversicherungsbeiträge steigen seit Jahrzehnten — im Schnitt 3–5% jährlich. Wer heute 800 Euro zahlt, landet in zehn Jahren oft bei 1.100 oder mehr. Das ist kein Ausnahmefall, das ist der Regelfall.`,
      `Jede Gesundheitsreform kostet Geld. Dieses Geld landet am Ende fast immer beim Beitragszahler — nicht beim Staat, nicht bei der Kasse.`,
      `Die meisten Menschen ahnen das irgendwie — aber sie haben es noch nie jemand mit ihren eigenen Zahlen ehrlich vorgerechnet. Genau das ist die Lücke, in die du gehst.`,
      `${owner} macht genau das: persönliche Vertragsanalyse, realistische Beitragsprognose bis zum Ruhestand, konkrete Handlungsmöglichkeiten — Altersrückstellungen, Entlastungsbausteine, Tarifoptimierung. Schwarz auf weiß, keine Schönfärberei.`,
      `Deine Aufgabe im Gespräch: nicht erklären, nicht pitchen. Bewusstsein wecken, echte Neugier erzeugen, Vertrauen aufbauen. Der Anrufende soll nach dem Gespräch denken: "Das hätte ich früher wissen sollen."`,
    );
  }

  if (isCommercialInsurance) {
    lines.push(
      ``,
      `WAS DU UEBER GEWERBLICHE VERSICHERUNGEN WEISST (verinnerlichen - nicht ablesen):`,
      `Das Thema ist ein strukturierter Vergleich bestehender Policen und ein Check-up, ob die Absicherung heute noch marktkonform ist.`,
      `Der Ersttermin ist ein Analyse-Termin: ${owner} stellt sich und seine Arbeitsweise vor, nimmt die noetigen Daten fuer den Vergleich auf und vereinbart direkt einen zweiten Termin zur Ergebnisvorstellung.`,
      `Der Zweittermin ist der Ergebnis-Termin: Dort werden Einsparpotenziale, Leistungsverbesserungen und moegliche Deckungsluecken transparent praesentiert.`,
      `Realistischer Nutzenanker: In vielen Faellen lassen sich bis zu dreißig Prozent Beitrag einsparen - oft bei gleichzeitig besseren Leistungen.`,
      `Zusatznutzen: Hauefig werden Risiken sichtbar, die bisher gar nicht oder nicht ausreichend abgesichert sind.`,
      `Typisches Kundenmuster: Viele Betriebe schliessen Policen einmal ab und pruefen sie jahrelang nicht mehr. Probleme fallen oft erst im Schadenfall auf.`,
      `Weiteres Muster: Manche verlassen sich voll auf den Makler und haben keinen klaren Ueberblick, was konkret versichert ist und was nicht.`,
      `Deine Aufgabe im Gespraech: Nicht druecken, sondern Struktur und Klarheit geben. Der Kunde soll verstehen, dass der erste Termin eine saubere Bestandsaufnahme ist - kein Produktverkaufstermin.`,
    );
  }

  const pkvData = isPKV ? collectPkvData(ctx) : null;
  if (pkvData) {
    const captured = Object.entries(pkvData.values)
      .map(([field, value]) => `${field}: ${value}`)
      .join(" | ");
    lines.push(
      ``,
      `BEREITS ERFASSTE BASISANGABEN: ${captured || "noch keine"}.`,
      `Vom Kunden ausdrücklich übersprungen: ${pkvData.skipped.join(", ") || "keine"}. Diese Punkte nicht erneut fragen.`,
      `Noch offen: ${pkvData.missing.join(", ") || "keine"}.`,
      `Verbindlich: Bereits erfasste Angaben NICHT erneut fragen. Wenn eine Antwort mehrere Angaben enthält, gelten alle erkannten Angaben als erfasst. VOR dem bestätigten Termin sind diese Angaben nur Gesprächskontext und dürfen nicht als Datenliste abgefragt werden. Erst in Phase 8 fragst du das erste noch offene Feld.`,
    );
    if (pkvData.email) {
      lines.push(`Erkannte E-Mail-Adresse: ${pkvData.email}. Wiederhole sie bei der Bestätigung vollständig inklusive Domain-Endung.`);
    }
  }

  // CONVERSATION STATE — observational, not commanding
  lines.push(``, `WO IHR GERADE SEID:`);

  if (phase <= 1) {
    lines.push(
      `Echter Erstkontakt. Stell dich transparent als digitale Vertriebsassistentin vor, nenne ${owner} und sage offen, dass ihr bisher noch keinen Kontakt hattet. Diese Ehrlichkeit baut mehr Vertrauen auf als künstliche Vertrautheit.`,
      `Formuliere den Erstkontakt aktiv und klar, z. B.: "Wir hatten bisher noch keinen direkten Kontakt, deshalb kurz transparent der Anlass meines Anrufs."`,
      `Wenn Gatekeeper: freundlich um Weiterleitung bitten. Beim Entscheider: Anlass in einem konkreten Satz, dann eine kleine Erlaubnisfrage wie "Darf ich Ihnen in zwei Sätzen sagen, weshalb ich anrufe?" Keine persönliche Versicherungsfrage im Opener.`,
    );
  } else if (phase === 2) {
    lines.push(
      `Du hast dich vorgestellt. Wenn der Kunde "Worum geht es?", "Warum rufen Sie an?" oder sinngleich fragt, beantworte ZUERST konkret den Anlass und Nutzen in einem kurzen Satz. Erst danach darfst du um Aufzeichnung bitten. Weiche der Frage niemals mit der Aufzeichnungsfrage aus.`,
      `Falls "Erstkontakt" noch nicht explizit gefallen ist: sage vor der Aufzeichnungsfrage einmal transparent, dass dies euer erster Kontakt ist und du deshalb kurz und klar durch den Anlass führst.`,
      `Bevor du nach Aufzeichnung fragst, gib der Person einen nachvollziehbaren Grund: ${owner} soll das Gespräch später korrekt nachvollziehen können. Sage ausdrücklich, dass ihr bei einem Nein selbstverständlich ohne Aufzeichnung weitersprecht. Das Nein darf keinerlei Druck oder Nachteil auslösen.`,
      `Natürliche Form: "Damit Herr Duic später nichts falsch zugeordnet bekommt: Darf ich unser Gespräch kurz aufzeichnen? Wenn nicht, sprechen wir natürlich ohne Aufnahme weiter." Dann warten.`,
      `Ein Gruß oder eine Namensmeldung ist noch keine Einwilligung — warte auf eine echte Antwort.`,
    );
  } else if (phase === 4) {
    if (isPKV) {
      lines.push(
        `Aufzeichnung ist geklärt. Ziel jetzt: ein echtes Gespräch und Relevanz aufbauen, noch KEINE Terminfrage.`,
        `Beginne mit einer leicht beantwortbaren Wahrnehmungsfrage, nicht mit persönlichen Daten: "Wie erleben Sie die Beitragsentwicklung bei sich – eher auffällig oder läuft das bisher nebenher?"`,
        `Kläre die Versicherungsart erst, wenn die Antwort einen natürlichen Anschluss bietet. Frage nie mehrere Fakten hintereinander ab.`,
        `Nenne NIEMALS "private Krankenversicherung" als Tatsache, bevor der Kunde das selbst bestätigt hat. Nutze bis dahin neutrale Formulierungen wie "Krankenversicherung" oder "Gesundheitsversorgung".`,
        `REAKTION VOR FRAGE: Greife den Sinn der Antwort in eigenen Worten auf und gib einen kurzen hilfreichen Gedanken. Stelle erst danach die nächste Frage. Keine Abfolge aus Bestätigung plus sofortiger Formularfrage.`,
        `Gib in jedem zweiten Zug zunächst Substanz: eine kurze Einordnung, eine transparente Erklärung oder eine vorsichtige Beispielrechnung. Der Kunde soll auch etwas bekommen, nicht nur Auskunft geben.`,
        `Frage nach dem aktuellen Beitrag nur permission-based und begründe den Nutzen: "Wenn Sie die Größenordnung nennen möchten, kann ich den Zehn-Jahres-Effekt grob einordnen." Ein "möchte ich nicht sagen" sofort akzeptieren.`,
        `Wenn er seinen Beitrag nennt (z.B. 900 €): mit genau dieser Zahl rechnen und danach eine Denkfrage stellen, z.B. "Hat sich das schon einmal jemand mit Ihnen bis zum Rentenalter sauber durchgerechnet?"`,
        `Wenn er sagt "hab ich mir keine Gedanken gemacht": Das ist dein Moment. Nicht weiterpitchen — kurz innehalten: "Genau das ist das Tückische daran. Das merkt man erst, wenn der nächste Bescheid kommt." Dann Pause.`,
        `Nenne in der Sensibilisierung höchstens einmal einen vorsichtig formulierten Zahlenanker: "Nach Angaben des PKV-Verbands liegen Beitragsanpassungen im langjährigen Durchschnitt häufig bei etwa drei bis fünf Prozent jährlich." Keine Zahlenkette und keine Garantie. Danach mit den persönlichen Zahlen des Kunden arbeiten.`,
        `Erst wenn er selbst sagt "das ist viel" oder ähnliches — dann die Brücke: "Genau dafür ist das Gespräch mit Herrn Duic da."`,
        `GKV-Versicherte: Beitragsentwicklung ist genauso ihr Thema. Nie nach Mitarbeitern oder Unternehmenskosten fragen.`,
        `WICHTIG: Frag pro Turn GENAU EINE Frage. Kein Doppeln.`,
      );
    } else {
      lines.push(
        `Aufzeichnung ist geklärt. Jetzt zuerst Vertrauen vor Terminierung: kurz auf die letzte Aussage eingehen, Nutzen greifbar machen und dann eine einzige offene Frage stellen.`,
        `Nicht-PKV Leitlinie: Kein Termin-Push in den ersten Zügen nach Einwilligung. Erst Relevanz und Verständnis aufbauen, dann behutsam zur Terminfrage überleiten.`,
        isCommercialInsurance
          ? `Setze frueh den Rahmen fuer die 2-Termin-Logik: Der erste Termin dient der Bestandsaufnahme und Datenerhebung fuer den Vergleich, der zweite Termin praesentiert die Analyseergebnisse.`
          : ``,
        isCommercialInsurance
          ? `GEWERBE-LEITFRAGEN (eine pro Turn, nie als Dreierblock): (1) "Wann wurde Ihre Absicherung zuletzt als Gesamtbild geprüft?" (2) "Hat sich bei Ihnen in den letzten Jahren etwas verändert – z. B. Wachstum, neue Tätigkeiten oder mehr Mitarbeitende?" (3) "Wo hätten Sie heute den größten Klärungsbedarf: Deckungslücken oder Beitrag-Leistung?"`
          : ``,
        `Wenn die Person skeptisch ist: validieren, konkretisieren, rückfragen (Dreischritt) statt pitchen.`,
        `Halte den Ton wie im Erstkontakt: transparent, respektvoll, ohne Vertrautheits-Behauptung.`,
      );
    }
  } else if (phase === 5) {
    if (isPKV) {
      lines.push(
        `SENSIBILISIERUNGSPHASE: Kein Fragenkatalog. Vertiefe nur den Punkt, den der Kunde selbst geöffnet hat.`,
        `Nutze mindestens einen konkreten Zahlenanker und benenne den Reformdruck in einem klaren Satz, aber halte die Einordnung kurz und lade danach zu einer Reaktion ein.`,
        `DER Reformdruck und die Kostenentwicklung gehören genau hier hin - nicht in den Abschluss.`,
        `Keine Angstkommunikation und kein künstliches Dramatisieren. Sprich über Planbarkeit und Entscheidungsfreiheit.`,
        `Wenn der Kunde einen konkreten Beitrag nennt, arbeite mit GENAU dieser Zahl. Keine Runterrechnung und keine frei erfundenen Korrekturen.`,
        `Beende diese Phase mit einer aktivierenden Denkfrage, die Bedarf sichtbar macht (z. B. "Hat sich das schon jemand mit Ihnen bis zur Rente sauber durchgerechnet?").`,
      );
    } else {
      lines.push(
        `SENSIBILISIERUNGSPHASE: Kein Fragenkatalog. Vertiefe nur den Punkt, den der Kunde selbst geöffnet hat.`,
        `Nutze mindestens einen konkreten Zahlenanker aus dem Thema (z. B. Beitrag/Leistung, Deckungslücken, Überschneidungen) und halte die Einordnung kurz.`,
        isCommercialInsurance
          ? `Bei gewerblichen Versicherungen bleib in der Sache bei Betriebskontext: gewachsenes Unternehmen, neue Tätigkeiten, verändertes Risikoprofil, Aktualität der Policen.`
          : ``,
        isCommercialInsurance
          ? `Wirkungsanker fuer Gewerbe: Viele Unternehmen zahlen seit Jahren zu viel oder haben gleichzeitig Leistungsluecken. Formuliere das als pruefbare Arbeitshypothese, nicht als Behauptung.`
          : ``,
        isCommercialInsurance
          ? `Nutze Einspar- und Leistungsnutzen vorsichtig konkret: "In vielen Faellen lassen sich deutliche Beitragsvorteile erzielen, teils bis zu dreißig Prozent - haeufig mit besserem Schutz."`
          : ``,
        `Keine Angstkommunikation und kein künstliches Dramatisieren. Sprich über Planbarkeit, Schutzniveau und Entscheidungsfreiheit.`,
        `Beende diese Phase mit einer aktivierenden Denkfrage ohne Themenwechsel, z. B. "Wurde das bei Ihnen schon einmal strukturiert gegengeprüft?"`,
      );
    }
  } else if (phase === 6) {
    lines.push(
      `KONZEPT-BRIDGE: Knüpfe ausdrücklich an die letzte Aussage des Kunden an und erkläre in 1-2 Sätzen, was ${ownerDative} konkret liefert: persönliche Analyse, realistische Prognose, konkrete Handlungsmöglichkeiten, kein Verkaufsdruck.`,
      isCommercialInsurance
        ? `Bei gewerblichen Versicherungen muss klar sein: Termin 1 = Datenaufnahme und Vergleichsgrundlage, Termin 2 = Ergebnisvorstellung mit konkreten Optionen und Empfehlung.`
        : ``,
      `Mache einen Verständnisschritt vor dem Termin: "Wäre so eine nüchterne Einordnung grundsätzlich hilfreich für Sie?" Erst bei Offenheit terminieren.`,
    );
  } else if (phase === 7) {
    lines.push(
      `Das Interesse ist da. Wiederhole keinen Pitch und keinen Reformdruck. Bestätige knapp, was dem Kunden wichtig war, und gehe ruhig zur Terminabstimmung.`,
      isCommercialInsurance
        ? `Rahme den Ersttermin fuer Gewerbe als strukturierten Analyse-Termin: Vorstellung, Sichtung der aktuellen Absicherung, Aufnahme der Vergleichsdaten, danach Termin 2 zur Ergebnisbesprechung.`
        : ``,
      `Dann Termin schließen: erst fragen ob eher Vormittag oder Nachmittag passt, dann genau zwei konkrete Slots aus der NÄCHSTEN WOCHE anbieten (nicht am nächsten Tag). Wenn beide nicht passen: zwei weitere Slots aus der darauffolgenden freien Woche anbieten, keinen bereits abgelehnten Slot wiederholen.`,
      `Rahme den Termin als persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic, nicht als Telefontermin.`,
      `Wenn der Kunde einen Slot auswählt: bestätige NUR den Termin in einem kurzen Satz und stelle höchstens die Frage, ob noch zwei Minuten für die Vorbereitung passen. KEINE Verabschiedung, KEIN hangup, KEINE Abschluss-Zusammenfassung und nicht behaupten, es sei nichts vorzubereiten.`,
    );
  } else if (phase === 8) {
    const basisDataConsent = getBasisDataConsentState(ctx);
    lines.push(
      `Termin bestätigt. Jetzt Vertrauen schützen: Die Terminbestätigung ist wichtiger als ein vollständiger Datensatz.`,
      basisDataConsent === "not-asked"
        ? `ERSTER SCHRITT: Frage genau einmal: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?" NOCH KEINE Datenfrage stellen.`
        : basisDataConsent === "pending"
          ? `Du hast um Erlaubnis für die Fragerunde gebeten. Werte ausschließlich die aktuelle Antwort aus. Bei Zustimmung beginne mit der ersten noch offenen Frage. Bei Ablehnung gehe zur E-Mail-Adresse. Stelle die Erlaubnisfrage nicht erneut.`
          : `Die Erlaubnis für die Fragerunde liegt vor. Bleibe ab jetzt strikt im Fragenkatalog und stelle genau eine noch offene Frage pro Turn.`,
      `Die Freiwilligkeit wurde vor der Fragerunde bereits geklärt. Sage bei den einzelnen Fragen NICHT mehr "wenn Sie möchten", "falls Sie das sagen wollen", "freiwillig", "oder lieber später" und biete nicht von dir aus an, einzelne Punkte zu überspringen. Stelle die Frage freundlich und direkt.`,
      `Nur wenn der Kunde VON SICH AUS eine konkrete Frage nicht beantworten möchte: Sage knapp "Kein Problem, dann überspringen wir diesen Punkt." und stelle direkt die nächste noch offene Frage. Nicht nach dem Grund fragen.`,
      `Reihenfolge der noch offenen Fragen: ${pkvData?.missing.join(" → ") || "keine"}.`,
      `KATALOG-SPERRE: Ausschließlich die erste noch offene Frage aus dieser Reihenfolge stellen. Keine Beitragsprognose, keine Sensibilisierung, keine Konzept-Erklärung, keine Terminfrage und keine Wiederholung bereits erfasster oder übersprungener Felder.`,
      `Gesundheitsdaten ruhig und neutral abfragen. Die einmalige Zustimmung gilt für den gesamten Katalog; keine erneute Erlaubnis vor jeder Gesundheitsfrage einholen.`,
      `In Phase 8 NIEMALS nach einer Aufzeichnung des Termins oder nach einer Einverständniserklärung fragen. Es geht nur um Vorbereitung und anschließend Terminbestätigung per E-Mail.`,
      `ABSOLUT VERBOTEN in Phase 8: Gespräch zusammenfassen, sich verabschieden, hangup=true setzen oder sagen, Herr Duic kläre alles erst im Termin. Solange Angaben offen sind und der Kunde sie nicht auf Mail verschoben hat, bleibst du in diesem Fragenblock.`,
      `WICHTIG: Bei den Gesundheitsfragen (Diagnosen/Behandlungen, Medikamente, stationäre Aufenthalte, psychische Behandlungen, Zähne/Zahnersatz, Allergien) gilt ein "Nein" als VOLLSTÄNDIGE und gültige Antwort. Kein Nachhaken, keine Umformulierung derselben Frage - sofort zur nächsten Frage übergehen.`,
      `Körpergröße und Gewicht als getrennte Fragen stellen. Nennt der Kunde freiwillig beides in einer Antwort, beide übernehmen und Gewicht NICHT erneut fragen.`,
    );
  } else if (phase === 10) {
    lines.push(
      `Der Fragenkatalog ist abgeschlossen oder wurde vom Kunden abgelehnt. Frag JETZT als einzige Aktion nach der E-Mail-Adresse für die Terminbestätigung.`,
      `Beispiel: "Darf ich noch kurz Ihre E-Mail-Adresse für die Terminbestätigung notieren?"`,
      `Kein hangup. Kein Zusammenfassen. Nur diese eine Frage.`,
    );
  } else if (phase >= 11) {
    lines.push(
      `E-Mail ist abgehakt. Jetzt SOFORT die Abschluss-Zusammenfassung und Verabschiedung.`,
      `ABSOLUT VERBOTEN: Keine weiteren Fragen. Nicht nach Ansprechpartner, nicht nach Basisangaben, nicht nach irgendetwas.`,
      `ABSOLUT VERBOTEN: Keine neue Sensibilisierung mehr, keine Reform- oder Kostendiskussion mehr, kein Nachschub an Argumenten.`,
      `Schreibe 3–4 Sätze:`,
      `(1) Termin: VERWENDE WORT FÜR WORT die eingefrorene Slot-Phrase aus dem System-Prompt. Kein anderes Datum, kein anderer Wochentag. Formuliere ihn als persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic - niemals als Telefontermin.`,
      `(2) Was passiert beim Termin: kurze persönliche Vertragsanalyse, Beitragsprognose, konkrete Handlungsmöglichkeiten.`,
      `(3) Hinweis auf Terminbestätigung per E-Mail.`,
      `(4) Freundliche Vor-Verabschiedung im Namen des Owners OHNE Abschlussformel, z. B. "Herr Duic freut sich auf das Gespräch. Vielen Dank für Ihre Zeit." — NICHT "Ich freue mich".`,
      `(5) hangup=false in DIESER Antwort. Wenn der Kunde sich danach verabschiedet, antworte im nächsten Turn ausschließlich mit "Auf Wiederhören!" und setze dann hangup=true.`,
    );
  }

  // HARD RULES — nur das wirklich Nicht-Verhandelbare
  lines.push(
    ``,
    `WAS IMMER GILT:`,
    `- Meist 1-2 kurze Sätze pro Antwort, höchstens 1 Hauptfrage. Kein Monolog. (Ausnahme: Phase 11 Abschluss-Zusammenfassung — dort bis zu 4 Sätze erlaubt.)`,
    `- ERSTKONTAKT: Nie so sprechen, als kenne der Kunde euch bereits. Keine erfundene Nähe, keine erfundene Empfehlung, keine manipulative Verknappung.`,
    `- PERMISSION-BASED: Bevor du persönliche oder finanzielle Angaben erfragst, erkläre knapp, welchen konkreten Nutzen die Antwort für den Kunden hat, und mache die Freiwilligkeit sprachlich klar.`,
    `- AUSNAHME FRAGENKATALOG: Nach der einmaligen Zustimmung zu Phase 8 keine Freiwilligkeits- oder Überspringen-Hinweise mehr an jede Einzelfrage hängen. Nur auf eine vom Kunden selbst geäußerte Ablehnung reagieren.`,
    `- DIALOG STATT INTERVIEW: Stelle nie mehr als zwei Informationsfragen hintereinander. Dazwischen muss eine echte Reaktion mit Bezug auf das Gesagte oder ein hilfreicher Substanzsatz stehen.`,
    `- AUSSPRECHEN-LASSEN: Unterbrich den Anrufenden nie. Reagiere erst, wenn ein Gedanke erkennbar abgeschlossen ist. Bei Fragmenten oder stockendem Satz lieber kurz warten als zu früh antworten.`,
    `- KUNDENFRAGEN SIND EIN EIGENER GESPRÄCHSSCHRITT: Eine Frage wie "Wie genau machen Sie das?" oder "Wie will Herr Duic das machen?" wird direkt beantwortet. Danach höchstens eine kurze Anschlussfrage, kein unveränderter Skriptblock.`,
    `- FLOSKELVERBOT: Beginne nicht automatisch mit "Danke", "Verstanden", "Das ist ein guter Punkt", "Perfekt", "Super" oder "Das ist nachvollziehbar". Nutze solche Wörter nur, wenn sie im konkreten Moment wirklich passen; oft ist ein direkter, menschlicher Anschluss besser.`,
    `- Keine leeren Bestätigungen wie "prima", "perfekt", "super" oder "alles klar" in Serie. Besonders bei sensiblen Angaben neutral und respektvoll reagieren.`,
    `- Natürlicher Sprachfluss vor Skriptklang: keine starren Wiederholungen wie "Vielen Dank" in jedem Turn, keine identischen Satzanfange in Folge.`,
    `- Wenn der Kunde knapp oder in Fragmenten antwortet, erst kurz den Sinn sichern und dann weiterführen - nicht vorschnell in den nächsten Pitch springen.`,
    `- EINWAND-QUALITÄT: Bei Einwänden in genau dieser Reihenfolge antworten: (1) kurz validieren, (2) ein konkreter Substanzsatz, (3) eine klare Rückfrage.`,
    `- KONKRET STATT GENERISCH: Greife mindestens ein konkretes Wort aus der letzten Kundenantwort auf (z. B. "Beitrag", "Zeit", "gesetzlich"), bevor du weiterführst.`,
    `- RHYTHMUS: Vermeide Füllsätze wie "Ich verstehe" in Serie. Variiere Bestätigungen natürlich (z. B. "guter Punkt", "verständlich", "das höre ich oft").`,
    `- AUFZEICHNUNGSFRAGE: Natürlich formulieren, z.B. "Darf ich kurz mitschneiden?" oder "Darf ich das Gespräch aufzeichnen?" — NIEMALS "Bitte antworten Sie mit JA oder NEIN" sagen.`,
    `- Aufzeichnungsfrage nur einmal. Bei Nein: normal weiterführen. Frage NIEMALS erneut nach Aufzeichnung oder Mitschnitt — auch nicht mit anderen Formulierungen wie "damit Herr X sich vorbereiten kann".`,
    `- WICHTIGER GESPRÄCHSFLUSS: Nach Aufzeichnung erst Relevanz/Sensibilisierung (allgemein -> persönlich -> Denkfrage), dann Konzept-Bridge, dann Terminfrage.`,
    `- TERMINART: Es geht um einen persönlichen Vor-Ort-Termin beim Interessenten mit Herrn Duic. Nenne niemals einen Telefontermin für den eigentlichen Fachtermin. Die Telefonie ist nur der Erstkontakt zur Terminvereinbarung.`,
    `- Kein Geschlecht aus Nachnamen ableiten.`,
    `- Termine nur Mo–Fr, 09:00–19:00 Uhr. Schlage NIEMALS einen Slot an oder vor dem heutigen Datum vor.`,
    `- Vor Phase 7 MUSS Phase 5 (Sensibilisierung) und Phase 6 (Konzept-Bridge) erfolgt sein. Keine direkte Terminierung aus dem Opener heraus.`,
    `- Biete in der Terminphase immer genau zwei Optionen aus der NÄCHSTEN WOCHE an. Kein Folgetag-Termin als Erstvorschlag.`,
    `- UHRZEIT-FORMAT (KRITISCH für Sprachausgabe): Schreibe Uhrzeiten IMMER in Worten — "zehn Uhr dreißig", "vierzehn Uhr" — NIEMALS als Ziffern ("10:30", "14:00").`,
    `- ZAHLEN-SPRACHE: Vermeide Dezimalschreibweisen wie "2,5" im gesprochenen Satz. Nutze natürliche Formen wie "zweieinhalb Prozent" oder "zwei Komma fünf Prozent".`,
    `- DATUM-FORMAT (KRITISCH): Schreibe Datum immer ausgeschrieben — "Dienstag, den elften Mai" — NIEMALS "11. Mai" oder "11.05.".`,
    `- SLOT EINGEFROREN: Sobald du einen Termin bestätigt hast, ist dieser Slot gesperrt. Nenne NUR diesen Slot. Berechne NIE neu. Erfinde KEINEN anderen Wochentag oder Datum.`,
    `- Den gewünschten Gesprächspartner nie als deinen Auftraggeber bezeichnen.`,
    `- QUELLEN: Keine pauschalen oder erfundenen Quellen-Claims. Im PKV-Kontext darf höchstens der ausdrücklich freigegebene Zahlenanker nach Angaben des PKV-Verbands verwendet werden; keine zusätzlichen 5-%-, 30-%- oder Bestandskundenbehauptungen. Danach zurück zu den persönlichen Zahlen des Kunden.`,
    `- THEMENTRENNUNG: Begriffe wie "Rente" oder "Ruhestand" nur im PKV-/Krankenversicherungs-Kontext verwenden. Bei gewerblichen Versicherungen NIEMALS erwähnen.`,
    `- Bei Skepsis zuerst transparent beantworten, nicht kontern. Bei "kein Interesse" höchstens eine kurze Relevanzfrage ohne Druck; jedes weitere Nein beendet das Gespräch würdevoll.`,
    `- hangup=true NUR wenn du in DIESER Antwort eine Verabschiedung ("Auf Wiederhören", "Schönen Tag", "Tschüss" o.ä.) sagst — NICHT beim Zusammenfassen, NICHT beim E-Mail-Fragen.`,
    `- WEITERLEITUNG ZU FRAU BROST: Wenn der Anrufende ausdrücklich mit einem Menschen sprechen möchte, sagst du: "Gerne, ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin. Falls die Verbindung nicht sofort klappt, meldet sie sich kurzfristig bei Ihnen." Dann transfer=true setzen. Biete die Weiterleitung NICHT ungefragt an — nur wenn der Kunde danach fragt oder explizit ablehnt, mit einer KI zu sprechen.`,
    `- TRANSPARENZ OHNE SELBSTSABOTAGE: Erwaehne nicht ungefragt "KI", "Bot" oder "Roboter". Wenn direkt gefragt wird, antworte offen und professionell: du arbeitest als digitale Assistentin im Auftrag von ${owner} und kannst auf Wunsch sofort an einen Menschen weiterleiten.`,
  );
  if (ctx.confirmedSlotPhrase) {
    lines.push(`- EINGEFROREN: "${ctx.confirmedSlotPhrase}" — nur diese Terminphrase verwenden.`);
  }

  return lines.join("\n");
}
function inferConversationPhase(ctx: CallContext): number {
  const turns = ctx.transcript;
  if (!turns.length) return 1;

  const all = turns.map((t) => t.text.toLowerCase()).join(" \n ");
  const assistantText = turns
    .filter((t) => t.role === "assistant")
    .map((t) => t.text.toLowerCase())
    .join(" \n ");
  const hasConsentQuestion = /aufzeichn|mitschneid/.test(all);
  const hasConsentAnswer = recordingConsentResolved(ctx);

  // Termin-Hinweis: Mehrere Signale nötig, damit ein einzelnes Schlüsselwort
  // (z. B. "Montag" in einem anderen Kontext) keinen Phase-Sprung auslöst.
  // Mindestens ZWEI der folgenden Signale müssen zusammen auftreten:
  //   (a) Tageszeit-Präferenz: "Vormittag" / "Nachmittag"
  //   (b) konkrete Uhrzeit mit "Uhr"
  //   (c) Wochentag + "Uhr" in unmittelbarer Nähe (Kontextfenster 5 Wörter)
  //   (d) direkte Terminanfrage von Gloria ("wann passt", "welcher Tag", "wie wäre")
  const hasTimePreference = /\b(vormittag|nachmittag)\b/.test(all);
  const hasClockTime = /\b\d{1,2}\s*uhr|\buhr\s+\w+\b/.test(all);
  const hasWeekdayWithTime = /\b(montag|dienstag|mittwoch|donnerstag|freitag)\b.{0,40}\buhr\b/.test(all);
  const hasAppointmentRequest = /\b(wann passt|welcher tag|wie w[äa]re|haben sie [a-z]+ zeit|schreiben sie|kann ich ihnen|soll ich ihnen)\b/.test(all);
  const termSignals = [hasTimePreference, hasClockTime, hasWeekdayWithTime, hasAppointmentRequest].filter(Boolean).length;
  const hasTermHint = termSignals >= 2;

  // Sensibilisierung + Konzept-Bridge vor der Terminphase erzwingen.
  const hasSensitization =
    /beitragssteiger|anpassung|wie hoch.*beitrag|monatsbeitrag|bemerkt.*beitrag/.test(all);
  const hasNumericProof =
    /vier prozent|hochrechnen|zehn jahre|f[üu]nfzigtausend|1300|1\.300/.test(all);
  const hasConceptBridge =
    /vertragsanalyse|prognose|stellschrauben|ohne verkaufsdruck|gespr[aä]ch mit herrn duic|herr duic schaut/.test(all);

  const hasConfirmedSlot = Boolean(ctx.confirmedSlotPhrase);
  const pkvData = collectPkvData(ctx);
  const hasDataCollection = pkvData.missing.length === 0;
  const basisDataConsent = getBasisDataConsentState(ctx);
  // Kunde hat Basisangaben abgelehnt: Gloria hat "Terminbestätigungsmail" oder "in Ruhe beantworten" gesagt
  const hasBasisdatenRefused = /terminbest[äa]tigungsmail|in ruhe (?:beantworten|erg[äa]nzen)|per mail beantworten|bleibt es (?:jetzt )?bei der terminbest[äa]tigung|angaben.*sp[äa]ter/i.test(assistantText);
  const hasEmailAsked = /(?:ihre|welche|an welche)\s+e-?mail(?:-adresse)?|e-?mail(?:-adresse)?[^.?!]{0,50}(?:nennen|notieren|best[äa]tigung|schicken)/i.test(assistantText);
  const hasSummary = /ich fasse kurz zusammen|auf wiederhören|auf wiedersehen|schönen tag noch/.test(assistantText);

  if (!hasConsentQuestion) return 2;
  if (!hasConsentAnswer) return 2;

  // Vor Terminbestätigung: erst Sensibilisierung, dann Konzept-Bridge, dann Terminierung.
  if (!hasSensitization) return 4;
  if (!hasNumericProof) return 5;
  if (!hasConceptBridge) return 6;
  if (!hasTermHint) return 6;
  if (!hasConfirmedSlot) return 7;

  // Termin ist bestätigt: dann Basisdaten -> E-Mail -> Abschluss.
  const skipBasisData = basisDataConsent === "declined" || hasBasisdatenRefused;
  if (!skipBasisData && !hasDataCollection) return 8;
  if (!hasEmailAsked) return 10;  // E-Mail fragen
  if (!hasSummary) return 11;     // Zusammenfassung + Verabschiedung
  return 11;
}

type PkvField =
  | "Geburtsdatum"
  | "Körpergröße"
  | "Gewicht"
  | "Versicherer"
  | "Monatsbeitrag"
  | "Diagnosen/Behandlungen"
  | "Medikamente"
  | "stationäre Aufenthalte"
  | "psychische Behandlungen"
  | "Zähne/Zahnersatz"
  | "Allergien";

const PKV_FIELDS: PkvField[] = [
  "Geburtsdatum", "Körpergröße", "Gewicht", "Versicherer", "Monatsbeitrag",
  "Diagnosen/Behandlungen", "Medikamente", "stationäre Aufenthalte",
  "psychische Behandlungen", "Zähne/Zahnersatz", "Allergien",
];

const PKV_QUESTIONS: Record<PkvField, string> = {
  Geburtsdatum: "Wie lautet Ihr Geburtsdatum?",
  Körpergröße: "Wie groß sind Sie?",
  Gewicht: "Verraten Sie mir noch Ihr aktuelles Gewicht?",
  Versicherer: "Bei welchem Krankenversicherer sind Sie aktuell versichert?",
  Monatsbeitrag: "Wie hoch ist Ihr aktueller Monatsbeitrag?",
  "Diagnosen/Behandlungen": "Gibt es aktuell bekannte Diagnosen oder laufende Behandlungen?",
  Medikamente: "Nehmen Sie aktuell regelmäßig Medikamente ein?",
  "stationäre Aufenthalte": "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
  "psychische Behandlungen": "Gab es in den letzten zehn Jahren psychische Behandlungen oder entsprechende Diagnosen?",
  "Zähne/Zahnersatz": "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
  Allergien: "Sind bei Ihnen Allergien bekannt?",
};

const PKV_FOLLOW_UP_QUESTIONS: Partial<Record<PkvField, string>> = {
  "Diagnosen/Behandlungen": "Welche Diagnosen oder laufenden Behandlungen liegen aktuell vor?",
  Medikamente: "Welche Medikamente nehmen Sie regelmäßig ein?",
  "stationäre Aufenthalte": "Weshalb waren Sie stationär im Krankenhaus und wann war das?",
  "psychische Behandlungen": "Um welche Behandlung oder Diagnose ging es dabei und wann war das?",
  "Zähne/Zahnersatz": "Welche Zähne oder welcher Zahnersatz sind konkret betroffen?",
  Allergien: "Welche Allergien sind bei Ihnen bekannt?",
};

export function buildDeterministicPostBookingReply(ctx: CallContext): TurnOutput | null {
  if (!ctx.confirmedSlotPhrase) return null;

  const summarySentWithoutFinalFarewell = ctx.transcript.some(
    (turn) =>
      turn.role === "assistant" &&
      /ihr pers[öo]nlicher termin mit herrn duic ist am/i.test(turn.text) &&
      !/auf wiederh[öo]ren/i.test(turn.text),
  );
  if (summarySentWithoutFinalFarewell) {
    const latestUserTurn = [...ctx.transcript].reverse().find((turn) => turn.role === "user");
    if (latestUserTurn && /\b(auf wiederh[öo]ren|wiederh[öo]ren|auf wiedersehen|tsch[üu]ss|tsch[üu]s|ciao|bis dann|bis bald|einen sch[öo]nen tag)\b/i.test(latestUserTurn.text)) {
      return {
        reply: "Auf Wiederhören!",
        hangup: true,
        transfer: false,
      };
    }
    return null;
  }

  const pkvData = collectPkvData(ctx);
  const isPkvCall = /pkv|kranken/.test((ctx.topic || "").toLowerCase());
  if (isPkvCall) {
    const basisDataConsent = getBasisDataConsentState(ctx);
    if (basisDataConsent === "not-asked") {
      return {
        reply: "Für die Vorbereitung würde ich Ihnen jetzt noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?",
        hangup: false,
        transfer: false,
      };
    }

    if (basisDataConsent === "granted") {
      const incompleteHealthQuestion = getIncompletePkvHealthQuestion(ctx);
      if (incompleteHealthQuestion) {
        return {
          reply: incompleteHealthQuestion,
          hangup: false,
          transfer: false,
        };
      }
      const followUpQuestion = getPkvHealthFollowUpQuestion(ctx);
      if (followUpQuestion) {
        return {
          reply: followUpQuestion,
          hangup: false,
          transfer: false,
        };
      }

      if (pkvData.missing.length > 0) {
        return {
          reply: PKV_QUESTIONS[pkvData.missing[0]],
          hangup: false,
          transfer: false,
        };
      }
    }
  }

  let emailQuestionIndex = -1;
  for (let index = ctx.transcript.length - 1; index >= 0; index -= 1) {
    const turn = ctx.transcript[index];
    if (turn.role === "assistant" && /e-?mail(?:-adresse)?.*(?:terminbest[äa]tigung|best[äa]tigung)|terminbest[äa]tigung.*e-?mail/i.test(turn.text)) {
      emailQuestionIndex = index;
      break;
    }
  }
  if (emailQuestionIndex < 0) {
    return {
      reply: "Welche E-Mail-Adresse darf ich für die Terminbestätigung notieren?",
      hangup: false,
      transfer: false,
    };
  }

  const emailAnswer = ctx.transcript
    .slice(emailQuestionIndex + 1)
    .find((turn) => turn.role === "user")?.text.trim() || "";
  const emailTurnsSinceQuestion = ctx.transcript
    .slice(emailQuestionIndex + 1)
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text);
  // Do not fall back to the complete call history here. Earlier ordinary
  // words can otherwise be assembled into a fake email address.
  const resolvedEmail = resolveSpokenEmailTurns(emailTurnsSinceQuestion);
  const emailConfirmationAsked = ctx.transcript
    .slice(emailQuestionIndex + 1)
    .some((turn) => turn.role === "assistant" && /ist diese.*(?:richtig|korrekt)|habe ich sie richtig verstanden/i.test(turn.text));
  const emailConfirmationAnswer = emailConfirmationAsked
    ? [...ctx.transcript].reverse().find((turn) => turn.role === "user")?.text || ""
    : "";
  const emailDeclined = /^(?:nein\b|keine e-?mail|ohne e-?mail|m[öo]chte ich nicht|lieber nicht)/i.test(emailAnswer);
  if (!resolvedEmail && !emailDeclined) {
    return {
      reply: "Ich habe die E-Mail-Adresse noch nicht vollständig verstanden. Bitte nennen Sie sie noch einmal, gern mit At und Punkt.",
      hangup: false,
      transfer: false,
    };
  }

  if (resolvedEmail && isSuspiciousSpokenEmail(resolvedEmail) && !emailConfirmationAsked) {
    return {
      reply: `Ich habe ${resolvedEmail} verstanden. Ist diese E-Mail-Adresse korrekt?`,
      hangup: false,
      transfer: false,
    };
  }

  if (resolvedEmail && isSuspiciousSpokenEmail(resolvedEmail) && emailConfirmationAsked && !/^(?:ja|ja,?\s*(?:das\s+)?stimmt|korrekt|richtig|genau|passt|okay|ok)\b/i.test(emailConfirmationAnswer.trim())) {
    return {
      reply: "Dann nennen Sie mir die E-Mail-Adresse bitte noch einmal vollständig.",
      hangup: false,
      transfer: false,
    };
  }

  const confirmationSentence = resolvedEmail
    ? `Die Terminbestätigung sende ich an ${resolvedEmail}.`
    : "Die Terminbestätigung erfolgt wie besprochen ohne E-Mail.";
  return {
    reply: `Ihr persönlicher Termin mit Herrn Duic ist am ${ctx.confirmedSlotPhrase}. Herr Duic bereitet die Vertragsanalyse und Beitragsprognose für Sie vor. ${confirmationSentence} Herr Duic freut sich auf das Gespräch. Vielen Dank für Ihre Zeit.`,
    hangup: false,
    transfer: false,
  };
}

function getPkvHealthFollowUpQuestion(ctx: CallContext): string | undefined {
  const healthFields = new Set<PkvField>([
    "Diagnosen/Behandlungen",
    "Medikamente",
    "stationäre Aufenthalte",
    "psychische Behandlungen",
    "Zähne/Zahnersatz",
    "Allergien",
  ]);

  for (let index = ctx.transcript.length - 1; index >= 0; index -= 1) {
    const turn = ctx.transcript[index];
    if (turn.role !== "assistant") continue;

    const field = detectAskedPkvField(turn.text.toLowerCase());
    if (!field || !healthFields.has(field)) continue;

    const answer = ctx.transcript
      .slice(index + 1)
      .find((entry) => entry.role === "user")?.text.trim() || "";
    if (!answer || !isAffirmativeHealthAnswer(answer)) return undefined;

    const followUp = PKV_FOLLOW_UP_QUESTIONS[field];
    if (!followUp) return undefined;

    const followUpAlreadyAsked = ctx.transcript
      .slice(index + 1)
      .some((entry) => entry.role === "assistant" && entry.text.includes(followUp));
    return followUpAlreadyAsked ? undefined : followUp;
  }

  return undefined;
}

function getIncompletePkvHealthQuestion(ctx: CallContext): string | undefined {
  for (let index = ctx.transcript.length - 1; index >= 0; index -= 1) {
    const turn = ctx.transcript[index];
    if (turn.role !== "assistant") continue;
    const field = detectAskedPkvField(turn.text.toLowerCase());
    if (!field || !PKV_FOLLOW_UP_QUESTIONS[field] && !PKV_QUESTIONS[field]) continue;
    const answer = ctx.transcript
      .slice(index + 1)
      .find((entry) => entry.role === "user")?.text.trim() || "";
    if (!answer || !isIncompletePkvHealthAnswer(answer)) return undefined;
    return PKV_QUESTIONS[field];
  }
  return undefined;
}

function isIncompletePkvHealthAnswer(answer: string): boolean {
  return /^(?:nehmen\s+sie\s+aktuell|ich\s+nehme|ich\s+bin|es\s+gibt|bei\s+mir|ja,?\s+ich\s+|nein,?\s+ich\s+|seit)\b/i.test(answer.trim());
}

function isAffirmativeHealthAnswer(answer: string): boolean {
  return /^(?:ja|jawohl|ja[,!\s]|doch|leider\s+ja|einige|mehrere|ein paar)\b/i.test(answer.trim());
}

function isSuspiciousSpokenEmail(email: string): boolean {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return true;
  const labels = domain.split(".").filter(Boolean);
  if (labels.length < 2) return true;
  if (labels.some((label) => label.length <= 1 && !/^xn--/.test(label))) return true;
  // Repeated spoken fragments commonly create addresses such as
  // neumann@musterbau.d.neumann. Do not send those without confirmation.
  return labels.at(-1) === local || labels.some((label) => label === local);
}

function affirmsMentally(text: string): boolean {
  return /^(?:ja|ja,?\s*(?:das\s+)?(?:stimmt|klar|gerne|okay|ok)|klar|stimmt|genau|okay|ok)\s*$/i.test(text.trim());
}

function recordingConsentResolved(ctx: CallContext): boolean {
  const turns = ctx.transcript;
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].role !== "assistant" || !/aufzeichn|mitschneid/i.test(turns[i].text)) continue;
    for (let j = i + 1; j < turns.length; j += 1) {
      const turn = turns[j];
      if (turn.role !== "user") continue;
      const decision = parseRecordingConsentDecision(turn.text);
      if (decision) return true;
    }
    return false;
  }
  return false;
}

function getBasisDataConsentState(ctx: CallContext): "not-asked" | "pending" | "granted" | "declined" {
  const turns = ctx.transcript;
  const askIndex = turns.findIndex(
    (turn) =>
      turn.role === "assistant" &&
      /(?:einige|ein paar|kurze)\s+(?:fragen|basisangaben|eckdaten)|fragen.*(?:vorbereitung|in ordnung)|angaben.*(?:vorbereitung|kl[äa]ren)/i.test(turn.text),
  );
  if (askIndex < 0) return "not-asked";

  const answer = turns.slice(askIndex + 1).find((turn) => turn.role === "user")?.text.trim().toLowerCase();
  // Die kurze Vorbereitungsankündigung ist keine Zustimmungsschranke. Wenn
  // der Kunde dazu nichts sagt, geht Gloria direkt mit der ersten Frage weiter.
  if (!answer) return "granted";
  if (/^(?:ja\b|jawohl|gerne\b|klar\b|okay\b|ok\b|(?:das\s+)?ist(?:\s+f[üu]r mich)?\s+in ordnung|passt\b|k[öo]nnen wir|machen wir|von mir aus)/i.test(answer)) {
    return "granted";
  }
  if (/^(?:nein\b|nö\b|lieber nicht|nicht jetzt|per mail|sp[äa]ter|ungern|(?:das\s+)?m[öo]chte ich nicht)/i.test(answer)) {
    return "declined";
  }
  return "pending";
}

function collectPkvData(ctx: CallContext): {
  values: Partial<Record<PkvField, string>>;
  missing: PkvField[];
  skipped: PkvField[];
  email?: string;
} {
  const values: Partial<Record<PkvField, string>> = {};
  const skipped = new Set<PkvField>();
  const turns = ctx.transcript;

  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role !== "assistant") continue;
    const question = turn.text.toLowerCase();
    const answers: string[] = [];
    for (let j = i + 1; j < turns.length && turns[j].role === "user"; j += 1) answers.push(turns[j].text);
    const answer = answers.join(" ").replace(/\s+/g, " ").trim();
    if (!answer) continue;

    const refusedField = detectAskedPkvField(question);
    if (refusedField && isExplicitFieldRefusal(answer)) {
      skipped.add(refusedField);
      continue;
    }

    if (/geburtsdatum|wann.*geboren/.test(question)) values.Geburtsdatum = answer;
    if (/k[öo]rpergr[öo][ßs]e|wie gro[ßs]/.test(question)) values.Körpergröße = answer;
    if (/gewicht|wie viel wiegen/.test(question)) values.Gewicht = answer;
    if (/krankenversicherer|welcher.*(?:kasse|versicherung)/.test(question)) values.Versicherer = answer;
    if (/monatsbeitrag|wie hoch.*beitrag/.test(question)) values.Monatsbeitrag = answer;
    if (/diagnos|laufende behandlung/.test(question)) values["Diagnosen/Behandlungen"] = answer;
    if (/medikament/.test(question)) {
      const medicationOnly = /^(?:eine?|einen?)\s+medikamente?[.!?]?$/i.test(answer);
      if (!medicationOnly) values.Medikamente = answer;
    }
    if (/station[äa]re|krankenhaus/.test(question)) values["stationäre Aufenthalte"] = answer;
    if (/psychisch/.test(question)) values["psychische Behandlungen"] = answer;
    if (/z[äa]hne|zahnersatz/.test(question)) values["Zähne/Zahnersatz"] = answer;
    if (/allerg/.test(question)) values.Allergien = answer;

    // Freiwillige Kombi-Antworten übernehmen, auch wenn nur nach einem Feld gefragt wurde.
    if (
      /\b(?:1|ein(?:s|en)?)\s*(?:meter|m)\b/i.test(answer) ||
      /\b(?:meter|komma)\s+[a-zäöüß\d-]+(?:\s+gro[ßs])?/i.test(answer) ||
      /\b\d[,.]\d{2}\s*(?:meter|m)?\b/i.test(answer)
    ) {
      values.Körpergröße = answer;
    }
    if (
      /\b(?:kilo\s*gramm|kilogramm|kilo|kg)\b/i.test(answer) ||
      /\b(?:1[,.]\d{2}|ein(?:s|en)?\s+meter(?:\s+\w+)?)\b[^.?!]{0,35}\b(?:[3-9]\d|1\d{2}|2[0-4]\d)\b/i.test(answer)
    ) {
      values.Gewicht = answer;
    }
    if (/\b(?:euro|€)\b/i.test(answer) && /beitrag|zahl|kost/i.test(`${question} ${answer}`)) values.Monatsbeitrag = answer;
  }

  const email = extractSpokenEmail(turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" "));
  return {
    values,
    missing: PKV_FIELDS.filter((field) => !values[field] && !skipped.has(field)),
    skipped: [...skipped],
    email,
  };
}

function buildDeterministicTrustReply(ctx: CallContext, userText: string): TurnOutput | null {
  const text = userText.toLowerCase();
  const owner = ctx.ownerRealName?.trim() || "Herrn Duic";
  const isPkv = /pkv|kranken/.test((ctx.topic || "").toLowerCase());
  const phase = inferConversationPhase(ctx);
  const latestAssistant = [...ctx.transcript].reverse().find((turn) => turn.role === "assistant")?.text.toLowerCase() || "";

  const askedBriefPermission =
    /in\s+20\s+sekunden|in\s+zwei\s+s[aä]tzen|kurz\s+sagen\s*,?\s*worum\s+es\s+geht|sprechen\s+sie\s+kurz\s+mit\s+mir/.test(
      latestAssistant,
    );
  const hadOwnerIntro = /ich\s+rufe\s+im\s+auftrag\s+von/.test(ctx.transcript.map((turn) => turn.text.toLowerCase()).join(" "));

  const shortAssent = /^(?:gut|ok(?:ay)?|ja|gern(?:e)?|passt|in\s+ordnung|mhm|joa?)\.?\s*$/i.test(userText.trim());
  if (askedBriefPermission && shortAssent && phase <= 4) {
    return {
      reply: isPkv
        ? "Danke. Wie Sie sicherlich gemerkt haben, steigen die Beiträge in der Gesundheitsversorgung Jahr für Jahr. Nach Angaben des PKV-Verbands liegen die jährlichen Beitragsanpassungen im Durchschnitt häufig bei etwa drei bis fünf Prozent. Wie stark spüren Sie diese Entwicklung bei sich?"
        : "Danke. Was ist bei diesem Thema für Sie aktuell der wichtigste Punkt?",
      hangup: false,
      transfer: false,
    };
  }

  if (isPkv && /beitr[aä]g(?:e)?\s+steig|steig(?:en|t)\s+.*beitr[aä]g/.test(text) && phase <= 6) {
    return null;
  }

  if (isPkv && /was\s+soll\s+bei\s+diesem\s+termin|was\s+wird\s+gemacht|wof[üu]r\s+ist\s+der\s+termin/.test(text)) {
    return {
      reply: `Gute Frage: ${owner} macht mit Ihnen eine persönliche Vertragsanalyse und eine realistische Zehn-Jahres-Prognose, damit Sie Klarheit und konkrete Handlungsmöglichkeiten bekommen. Wenn Sie möchten: In welcher Größenordnung liegt Ihr Monatsbeitrag aktuell?`,
      hangup: false,
      transfer: false,
    };
  }

  const confirmsConversation = /\b(k[öo]nnen\s+gerne\s+miteinander\s+sprechen|wir\s+k[öo]nnen\s+gerne\s+miteinander\s+sprechen|ja\s*,?\s*gerne|gern\b|nat[üu]rlich\b|klar\b)\b/i.test(text);
  if (confirmsConversation && askedBriefPermission) {
    const shortTopic = ctx.topic?.trim() ? `zum Thema ${ctx.topic.trim()}` : "zum Anliegen";
    const followup = hadOwnerIntro
      ? `Danke. Dann kurz ${shortTopic}: Welche Rolle haben Sie dabei aktuell im Unternehmen?`
      : `Danke. Ich rufe im Auftrag von ${owner} an ${shortTopic}. Darf ich mit einem kurzen Überblick starten?`;
    return {
      reply: followup,
      hangup: false,
      transfer: false,
    };
  }

  const asksIfAi = /(bist|sind)\s+(du|sie)\s+(eine\s+)?(ki|ai|bot|roboter)|mit\s+(einer\s+)?ki|sprich(e|en)\s+ich\s+mit\s+(einer\s+)?(ki|ai|bot|roboter)/i.test(text);
  const rejectsAi = /(keine?\s+ki|nicht\s+mit\s+(einer\s+)?ki|nur\s+(mit\s+)?(einem\s+)?menschen|echten?\s+menschen|kein\s+bot|nicht\s+mit\s+bot|keinen\s+roboter)/i.test(text);
  const asksHuman = /(mit\s+(einem\s+)?menschen\s+sprechen|mitarbeiter(in)?\s+sprechen|verbinden\s+sie\s+mich|stellen\s+sie\s+durch|durchstellen)/i.test(text);

  if (rejectsAi || asksHuman) {
    return {
      reply: "Verstanden, das respektiere ich. Ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin.",
      hangup: false,
      transfer: true,
    };
  }

  if (asksIfAi) {
    return {
      reply: `Ja, ich arbeite als digitale Assistentin im Auftrag von ${owner}. Wenn Ihnen lieber ist, verbinde ich Sie sofort mit Jutta Brost.`,
      hangup: false,
      transfer: false,
    };
  }

  return null;
}

function isExplicitFieldRefusal(answer: string): boolean {
  return /\b(?:m[öo]chte|will|werde)\s+(?:ich\s+)?(?:nicht|nichts)\s+(?:beantworten|sagen|angeben)|\b(?:keine angabe|sage ich nicht|beantworte ich nicht|geht sie nichts an|[üu]berspringen wir|lassen wir (?:das|die frage))\b/i.test(answer);
}

function detectAskedPkvField(question: string): PkvField | undefined {
  const patterns: Array<[PkvField, RegExp]> = [
    ["Geburtsdatum", /geburtsdatum|wann.*geboren/i],
    ["Körpergröße", /k[öo]rpergr[öo][ßs]e|wie gro[ßs]/i],
    ["Gewicht", /gewicht|wie viel wiegen/i],
    ["Versicherer", /krankenversicherer|welcher.*(?:kasse|versicherung)/i],
    ["Monatsbeitrag", /monatsbeitrag|wie hoch.*beitrag/i],
    ["Diagnosen\/Behandlungen", /diagnos|laufende behandlung/i],
    ["Medikamente", /medikament/i],
    ["stationäre Aufenthalte", /station[äa]re|krankenhaus/i],
    ["psychische Behandlungen", /psychisch/i],
    ["Zähne\/Zahnersatz", /z[äa]hne|zahnersatz/i],
    ["Allergien", /allerg/i],
  ];
  let detected: { field: PkvField; index: number } | undefined;
  for (const [field, pattern] of patterns) {
    const match = pattern.exec(question);
    if (match && (!detected || match.index > detected.index)) detected = { field, index: match.index };
  }
  return detected?.field;
}

function extractSpokenEmail(text: string): string | undefined {
  const directEmail = text.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)?.at(-1);
  if (directEmail) return directEmail;

  const candidates = text.toLowerCase().match(/[a-z0-9_%+-]+(?:\s*(?:punkt|dot|\.)\s*[a-z0-9_%+-]+)*\s*(?:at|ät|@)\s*[a-z0-9-]+(?:\s*(?:punkt|dot|\.)\s*[a-z0-9-]+)+/gi);
  const raw = candidates?.at(-1);
  if (raw) {
    const normalized = raw
      .toLowerCase()
      .replace(/\s+(?:at|ät)\s+/g, "@")
      .replace(/\s*@\s*/g, "@")
      .replace(/\s*(?:punkt|dot|\.)\s*/g, ".")
      .replace(/\.\s*([a-z])\s+([a-z])\b/g, ".$1$2")
      .replace(/\s+/g, "");
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) return normalized;
  }

  // Fallback for spelled addresses like "info at firma punkt d e" spread across turns.
  const normalizedAcrossTurns = text
    .toLowerCase()
    .replace(/\b(?:klammeraffe|at|ät|aett?)\b/g, "@")
    .replace(/\s*@\s*/g, "@")
    .replace(/\b(?:punkt|dot)\b/g, ".")
    .replace(/[<>()[\],;:"']/g, "")
    .replace(/\s+/g, "");
  const fallbackEmail = normalizedAcrossTurns.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g)?.at(-1);
  if (!fallbackEmail) return undefined;

  const [local, domain] = fallbackEmail.split("@");
  const labels = domain.split(".").filter(Boolean);
  if (!local || !domain || labels.length < 2 || labels.some((label) => label.length <= 1 && !/^xn--/.test(label))) {
    return undefined;
  }
  return fallbackEmail;
}

function resolveSpokenEmailTurns(turns: string[]): string | undefined {
  const normalizedTurns = turns.map((turn) => turn.trim()).filter(Boolean);

  // A complete address in a newer answer replaces an earlier correction.
  for (let index = normalizedTurns.length - 1; index >= 0; index -= 1) {
    const candidate = extractSpokenEmail(normalizedTurns[index]);
    if (candidate) return candidate;
  }

  // ASR may deliver only a suffix such as "d e." in a separate turn. Append
  // it only to the immediately preceding answer, never to the full history.
  const latest = normalizedTurns.at(-1) || "";
  const previous = normalizedTurns.at(-2) || "";
  if (previous && latest && !/\b(?:at|ät|klammeraffe)\b|@/i.test(latest)) {
    const combined = extractSpokenEmail(`${previous} ${latest}`);
    if (combined) return combined;
  }

  return undefined;
}

function buildMemoryBlock(ctx: CallContext): string {
  const lines: string[] = [];
  if (ctx.memory.concerns.length > 0) {
    lines.push(`- Wichtige Bedenken: ${ctx.memory.concerns.slice(-5).join(" | ")}`);
  }
  if (ctx.memory.preferences.length > 0) {
    lines.push(`- Präferenzen: ${ctx.memory.preferences.slice(-5).join(" | ")}`);
  }
  if (ctx.memory.facts.length > 0) {
    lines.push(`- Chronik wichtiger Kundenaussagen: ${ctx.memory.facts.slice(-6).join(" | ")}`);
  }
  if (!lines.length) return "";
  return [
    "GESPRÄCHS-MERKER (aus diesem Call):",
    ...lines,
    "Nutze diese Chronik aktiv für Anschlussfragen und Begründungen. Greife passende frühere Aussagen natürlich auf, frage bereits beantwortete Punkte nicht erneut ab und erfinde nichts hinzu.",
  ].join("\n");
}

function buildStyleGuard(ctx: CallContext): string {
  const recentStarters = ctx.transcript
    .filter((t) => t.role === "assistant")
    .slice(-4)
    .map((t) => firstWords(t.text, 3))
    .filter(Boolean);
  const uniqueStarters = Array.from(new Set(recentStarters));

  const toneInstruction =
    ctx.memory.tone === "rushed"
      ? "Das Gegenüber wirkt in Eile: antworte ultrakurz (1 Satz + 1 Frage), ohne Vorrede."
      : ctx.memory.tone === "skeptical"
        ? "Das Gegenüber wirkt skeptisch: valide Bedenken konkret, dann ein belastbarer Fakt, dann eine kurze Rückfrage."
        : "";

  const lines = [
    "NATÜRLICHKEITS-GUARDRAIL:",
    "- Antworte wie im echten Telefonat, nicht wie ein Skript. Variiere Satzanfänge und Rhythmus.",
    "- Vermeide wiederkehrende Standard-Opener. Nutze nicht zweimal hintereinander denselben Einstieg.",
    "- Nutze sparsame Höflichkeitsmarker: ein kurzes Danke ist okay, aber nicht als Pflicht in jeder Zeile.",
    "- Priorität hat Anschlussfähigkeit: zuerst kurz auf den letzten Kundengedanken eingehen, dann sauber weiterführen.",
    "- GESPRÄCHSGEDÄCHTNIS: Behalte wichtige Aussagen, Zahlen, Fragen, Einwände, Wünsche und bereits beantwortete Punkte über den gesamten Call. Wenn der Kunde später daran anknüpft, nimm den früheren Kontext auf statt neu zu beginnen.",
    "- Verwende in Einwandmomenten kurze Dreischritt-Antworten: validieren, konkretisieren, rückfragen.",
    "- Halte den Ton charmant und auf Augenhöhe: klar führen, aber niemals belehrend.",
  ];

  if (uniqueStarters.length > 0) {
    lines.push(`- Zuletzt verwendete Einstiege (nicht direkt wiederholen): ${uniqueStarters.join(" | ")}`);
  }
  if (toneInstruction) lines.push(`- ${toneInstruction}`);

  return lines.join("\n");
}

function firstWords(text: string, count: number): string {
  return text
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(" ")
    .toLowerCase();
}

