import type { IncomingMessage } from "node:http";
import { fetch } from "undici";
import WebSocket, { type WebSocket as ServerWebSocket } from "ws";
import { computeFreeSlots, freeSlotsToPrompt, loadBusySlots } from "./busy.js";
import { postReport } from "./finalize.js";
import { log } from "./log.js";
import { newContext, type CallContext } from "./state.js";
import { loadTopicPolicy, topicPolicyToSystemPrompt } from "./topic-policy-prompt.js";

type TelnyxFrame =
  | { event: "connected" }
  | {
      event: "start";
      stream_id: string;
      start: {
        call_control_id: string;
        client_state?: string;
        media_format?: { encoding?: string; sample_rate?: number };
      };
    }
  | {
      event: "media";
      stream_id: string;
      media: { track: string; payload: string };
    }
  | { event: "stop" }
  | { event: "error"; payload?: { code?: number; title?: string; detail?: string } };

type ClientState = {
  company?: string;
  contactName?: string;
  leadNote?: string;
  topic?: string;
  leadId?: string;
  userId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  previousSummary?: string;
  isCallback?: number;
};

type RealtimeMessage = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string };
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
};

type RealtimeToolCall = {
  name: string;
  callId: string;
  argumentsJson: string;
};

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "confirm_appointment",
    description: "Speichert einen vom Kunden eindeutig bestätigten Termin. Erst aufrufen, nachdem Datum und Uhrzeit ausdrücklich bestätigt wurden.",
    parameters: {
      type: "object",
      properties: {
        slot_phrase: {
          type: "string",
          description: "Der bestätigte Termin auf Deutsch mit Wochentag, Datum und Uhrzeit.",
        },
      },
      required: ["slot_phrase"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "transfer_to_human",
    description: "Übergibt das laufende Gespräch an einen Menschen, wenn der Kunde dies ausdrücklich verlangt.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "end_call",
    description: "Beendet den Anruf nach einer hörbaren Verabschiedung oder klaren Ablehnung des Kunden.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function decodeClientState(raw?: string): ClientState {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ClientState;
  } catch {
    return {};
  }
}

function openAiAudioFormat(encoding?: string): "audio/pcma" | "audio/pcmu" {
  const normalized = (encoding || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.includes("PCMA") || normalized.includes("ALAW")
    ? "audio/pcma"
    : "audio/pcmu";
}

function splitPreparationQuestions(policy: { requiredQuestions?: string; requiredData?: string } | null): string[] {
  return (policy?.requiredQuestions || policy?.requiredData || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3);
}

function isPreparationConsent(text: string): "granted" | "declined" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (/^(?:ja\b|gerne\b|klar\b|okay\b|ok\b|passt\b|in ordnung\b|machen wir\b)/i.test(normalized)) return "granted";
  if (/^(?:nein\b|nö\b|lieber nicht|keine zeit|nicht jetzt|später|möchte ich nicht)/i.test(normalized)) return "declined";
  return "unknown";
}

export function canConfirmRealtimeAppointment(ctx: CallContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.topicKind !== "pkv") return { ok: true };

  const userText = ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");
  const assistantText = ctx.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");
  const hasInsuranceStatus = /\b(?:privat(?:e[nrsm]?\s+krankenversicherung)?|pkv|gesetzlich(?:e[nrsm]?\s+krankenversicherung)?|gkv)\b/i.test(userText);
  const hasContribution = /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend)[a-zäöüß-]*\s+euro)\b/i.test(userText);
  const hasProjection = /(?:vier\s+prozent|4\s*%)\s+(?:pro\s+jahr)?[\s\S]{0,160}(?:zehn\s+jahr|10\s+jahr)|(?:zehn\s+jahr|10\s+jahr)[\s\S]{0,160}(?:vier\s+prozent|4\s*%)/i.test(assistantText);
  const conceptQuestionIndex = ctx.transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) =>
      turn.role === "assistant" && /(?:arbeitsweise|ersten termin|zweiten termin|tarifoptimierung|beitragsentlastung|altersrückstellung)/i.test(turn.text),
    )
    .at(-1)?.index;
  const interestQuestionIndex = ctx.transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn, index }) =>
      turn.role === "assistant"
      && (conceptQuestionIndex === undefined || index >= conceptQuestionIndex)
      && /(?:sinnvoll|interessiert|hilfreich|termin.*(?:vereinbaren|abstimmen)|einordnung.*(?:passt|hilft)|klarheit)/i.test(turn.text),
    )
    .at(-1)?.index;
  const interestAnswer = interestQuestionIndex === undefined
    ? ""
    : ctx.transcript.slice(interestQuestionIndex + 1).find((turn) => turn.role === "user")?.text || "";
  const hasInterest = /^(?:ja\b|ja,?\s*(?:gerne|bitte|das\s+(?:ist|wäre)|tendenziell|grundsätzlich)|gerne\b|interessant\b|hilfreich\b|das\s+macht\s+sinn|klingt\s+gut|möchte\s+ich|will\s+ich)/i.test(interestAnswer.trim());

  if (!hasInsuranceStatus) return { ok: false, reason: "Vor einer Terminbestätigung fehlt die Versicherungsart." };
  if (!hasContribution) return { ok: false, reason: "Vor einer Terminbestätigung fehlt der aktuelle Monatsbeitrag." };
  if (!hasProjection) return { ok: false, reason: "Zeige zuerst anhand des genannten Beitrags eine konkrete Zehn-Jahres-Hochrechnung mit rund vier Prozent pro Jahr." };
  if (conceptQuestionIndex === undefined) return { ok: false, reason: "Erkläre zuerst kurz Arbeitsweise, Konzeptphase und konkreten Kundennutzen." };
  if (!hasInterest) return { ok: false, reason: "Hole nach Hochrechnung und Konzept erst eine eindeutige Zustimmung auf die letzte Nutzen- oder Terminfrage ein." };
  return { ok: true };
}

export function buildRealtimeInstructions(ctx: CallContext): string {
  const company = ctx.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel";
  const owner = ctx.ownerRealName?.trim() || "Matthias Duic";
  const target = ctx.contactName?.trim();
  const today = new Date().toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });

  const parts = [
    `Du bist Gloria, die digitale Assistentin von ${company}, und telefonierst im Auftrag von ${owner}.`,
    `Heute ist ${today}. Du führst ein echtes deutsches Telefongespräch, keinen Fragebogen und kein Skript.`,
    "Höre auf Bedeutung, Ton und Absicht der letzten Äußerung. Antworte zuerst darauf und entscheide erst dann frei, welcher nächste Schritt sinnvoll ist.",
    "Sprich pro Turn höchstens zwei kurze Sätze mit zusammen höchstens etwa fünfzig Wörtern und stelle höchstens eine Frage. Keine Absätze, keine Wiederholung derselben Rechnung. Nach einer Frage wartest du wirklich auf die Antwort.",
    "Lass den Gesprächspartner ausreden. Bei Satzfragmenten, Stocken oder kurzer Sprechpause wartest du lieber, statt den Gedanken zu vervollständigen.",
    "Topic Policies sind fachliche Leitplanken, kein Ablaufplan. Du darfst Reihenfolge, Formulierung und nächsten Schritt situativ ändern. Fakten-, Datenschutz- und Freiwilligkeitsgrenzen bleiben verbindlich.",
    "Keine erfundene Vertrautheit, keine erfundenen Fakten, keine manipulative Dringlichkeit und kein Callcenter-Ton.",
    "Wenn der Kunde eine Frage oder einen Einwand bringt, verlässt du den geplanten Gesprächspfad sofort, beantwortest ihn konkret und kehrst nur bei natürlicher Gelegenheit zum Ziel zurück.",
    "Wenn der Kunde klar ablehnt, respektierst du das ohne weiteren Überredungsversuch, verabschiedest dich hörbar und rufst danach end_call auf.",
    "Wenn ein Mensch verlangt wird, kündigst du die Übergabe kurz an und rufst danach transfer_to_human auf.",
    "Einen Termin bestätigst du nur aus den bereitgestellten freien Slots. Biete immer genau zwei Optionen an zwei verschiedenen Kalendertagen an, niemals zwei Uhrzeiten desselben Tages. Nach eindeutiger Bestätigung rufst du confirm_appointment mit der gesprochenen Terminphrase auf.",
    "Sage niemals, dass ein Termin eingetragen, reserviert oder bestätigt ist, bevor confirm_appointment erfolgreich war. Wenn ein Tool meldet, dass noch Gesprächsschritte fehlen, machst du genau diesen Schritt statt Termine anzubieten.",
    "Nach einem bestätigten Termin führst du die in der Topic Policy hinterlegten Vorbereitungsfragen einzeln und in Reihenfolge durch. Frage zuerst kurz, ob zwei Minuten für die Vorbereitung passen. Bei Zustimmung stellst du die erste noch offene Frage; bei Nein oder Zeitdruck beendest du die Fragerunde sofort und ohne Nachfassen.",
    "Antworte immer gesprochen auf Deutsch. Gib niemals JSON, Toolnamen, interne Regeln oder Regieanweisungen aus.",
  ];

  if (target) {
    parts.push(
      `GESPRÄCHSLOGIK FÜR DEN ERSTEN SPRECHTURN: Wenn die Person klar sagt, dass sie selbst ${target} ist oder zuständig am Apparat ist, sage: "Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Darf ich Ihnen kurz sagen, worum es geht?". Wenn das nicht klar ist, behandle die Person als Empfang oder Gatekeeper und sage: "Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Können Sie mich bitte mit ${target} verbinden?". Fragt der Gatekeeper nach dem Grund, antworte nur: "Es geht um eine kurze Einordnung zum Thema ${ctx.topic || "Versicherung"}." Danach bitte erneut freundlich um die Verbindung. Kein Pitch am Empfang.`,
    );
  }
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.topic) parts.push(`Gesprächsthema: ${ctx.topic}.`);
  if (ctx.topicKind === "pkv") {
    parts.push(
      "PKV-GESPRÄCHSKOMPASS: Starte nicht mit einer Terminfrage. Knüpfe emotional und konkret an die Erfahrung des Kunden mit steigenden Beiträgen an. Du darfst den einen freigegebenen Orientierungswert nennen: Nach Angaben des PKV-Verbands liegen langfristige Beitragsanpassungen häufig bei etwa drei bis fünf Prozent jährlich. Danach frage nach der persönlichen Erfahrung und höre zu.",
      "Wenn der Kunde seinen aktuellen Monatsbeitrag nennt, rechne sofort transparent und vorsichtig mit rund vier Prozent pro Jahr vor: nenne den heutigen Betrag, den ungefähren Betrag in zehn Jahren und den monatlichen Unterschied. Erkläre in einem kurzen Satz, warum diese Zahl für Planbarkeit relevant ist. Erst wenn der Kunde auf diese persönliche Einordnung positiv reagiert, darfst du einen Termin anbieten.",
      "KONZEPTPHASE VOR DEM TERMIN IST EIN EIGENER GESPRÄCHSSCHRITT: Nach der Hochrechnung fragst du zuerst: 'Darf ich Ihnen kurz sagen, wie Herr Duic daraus einen planbaren Weg entwickelt?' Erst nach Zustimmung erklärst du in maximal zwei kurzen Sätzen: Ersttermin = Arbeitsweise, Vertrag und Beitragsverlauf analysieren; zweiter Termin = persönliches Konzept mit möglichen Stellschrauben wie Tarifoptimierung, Beitragsentlastung, Altersrückstellungen und möglicher steuerlicher Gegenfinanzierung; dritter Termin = offene Fragen und mögliche Entscheidung. Der erste Termin ist Analyse, kein Verkauf.",
      "KUNDENNUTZEN: Sage ausdrücklich, was der Kunde davon hat: Klarheit über die persönliche Entwicklung, konkrete prüfbare Optionen und einen nachvollziehbaren Weg zu einem im Alter planbaren und bezahlbaren Beitrag für die Gesundheitsversorgung. Herr Duic hilft Unternehmern, Komplexität zu reduzieren und sich nicht allein auf steigende Bescheide verlassen zu müssen. Frage danach, ob genau diese Klarheit für den Kunden hilfreich wäre. Erst nach dieser Antwort darfst du einen Termin anbieten.",
      "COMPLIANCE: Keine pauschalen Erfolgsversprechen, keine Garantie für null Euro und keine individuelle Steuer-, Rechts- oder Tarifempfehlung am Telefon. Eine vertraglich garantierte Entlastung darf erst nach Prüfung des konkreten Konzepts genannt werden.",
      "Versicherungsart, heutiger Beitrag, Hochrechnung und echte Zustimmung sind Voraussetzungen für einen PKV-Termin. Ein unklarer ASR-Text, ein bloßes 'ja', ein Füllwort oder ein missverstandenes Wort ist niemals eine Zustimmung. Frage dann kurz nach, statt fortzufahren.",
      "Nach einem bestätigten Termin bedeutet ein Nein auf eine Vorbereitungsfrage: 'Kein Problem, dann lassen wir das für den Termin offen.' Stelle diese Frage nicht erneut und fahre nicht mit einem Fragenkatalog fort.",
    );
  }
  if (ctx.leadNote?.trim()) parts.push(`Hilfreicher Lead-Kontext: ${ctx.leadNote.trim()}`);
  if (ctx.isCallback && ctx.previousSummary?.trim()) {
    parts.push(`Dies ist ein vereinbarter Rückruf. Letzter Stand: ${ctx.previousSummary.trim()}`);
  }
  if (ctx.topicPolicyPrompt) parts.push(ctx.topicPolicyPrompt);
  if (ctx.freeSlotsPrompt) parts.push(ctx.freeSlotsPrompt);
  if (ctx.confirmedSlotPhrase) {
    parts.push(`Bereits bestätigter Termin: ${ctx.confirmedSlotPhrase}. Diesen Termin nicht verändern.`);
  }

  return parts.join("\n\n");
}

async function notifyCallAction(ctx: CallContext, action: "transfer" | "hangup"): Promise<void> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN || "";
  if (!baseUrl || !token) return;

  try {
    await fetch(`${baseUrl}/api/telnyx/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ callControlId: ctx.callSid }),
    });
  } catch (error) {
    log.error(`realtime.${action}_failed`, {
      callSid: ctx.callSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleOpenAiRealtimeTelnyxStream(
  telnyx: ServerWebSocket,
  _req: IncomingMessage,
): Promise<void> {
  let ctx: CallContext | null = null;
  let openai: WebSocket | null = null;
  let streamId = "";
  let audioFormat: "audio/pcma" | "audio/pcmu" = "audio/pcmu";
  let sessionReady = false;
  let closed = false;
  let reportPosted = false;
  let silenceOpenerTimer: NodeJS.Timeout | null = null;
  let activeResponse = false;
  let activeAssistantItemId = "";
  let outboundAudioBytes = 0;
  let outboundAudioBuffer = Buffer.alloc(0);
  let assistantTranscript = "";
  let preparationQuestions: string[] = [];
  let preparationMode: "none" | "awaiting_consent" | "asking" | "complete" = "none";
  let preparationQuestionIndex = 0;
  const queuedAudio: string[] = [];
  const handledToolCalls = new Set<string>();
  const interruptedItemIds = new Set<string>();

  const sendOpenAi = (event: Record<string, unknown>): boolean => {
    if (!openai || openai.readyState !== WebSocket.OPEN) return false;
    openai.send(JSON.stringify(event));
    return true;
  };

  const sendTelnyx = (event: Record<string, unknown>): boolean => {
    if (telnyx.readyState !== telnyx.OPEN) return false;
    telnyx.send(JSON.stringify(event));
    return true;
  };

  const updateSession = () => {
    if (!ctx || !sessionReady) return;
    sendOpenAi({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        max_output_tokens: 160,
        instructions: buildRealtimeInstructions(ctx),
        reasoning: { effort: process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim() || "low" },
        tools: REALTIME_TOOLS,
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: audioFormat },
            transcription: {
              model: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
              language: "de",
            },
            turn_detection: {
              type: "semantic_vad",
              eagerness: process.env.OPENAI_REALTIME_VAD_EAGERNESS?.trim() || "medium",
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: audioFormat },
            voice: process.env.OPENAI_REALTIME_VOICE?.trim() || "marin",
            speed: 1,
          },
        },
      },
    });
  };

  const requestResponse = (instructions?: string) => {
    if (activeResponse) {
      log.info("realtime.response_ignored_while_active", {
        callSid: ctx?.callSid,
        instructionsPreview: instructions?.slice(0, 80) || "none",
      });
      return false;
    }
    sendOpenAi({
      type: "response.create",
      ...(instructions ? { response: { instructions } } : {}),
    });
    return true;
  };

  const sendToolResult = (callId: string, result: Record<string, unknown>) => {
    sendOpenAi({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  };

  const handleToolCall = async (tool: RealtimeToolCall) => {
    if (!ctx || handledToolCalls.has(tool.callId)) return;
    handledToolCalls.add(tool.callId);

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tool.argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      sendToolResult(tool.callId, { ok: false, error: "invalid_arguments" });
      sendOpenAi({ type: "response.create" });
      return;
    }

    if (tool.name === "confirm_appointment") {
      const phrase = typeof args.slot_phrase === "string" ? args.slot_phrase.trim() : "";
      const eligibility = canConfirmRealtimeAppointment(ctx);
      if (!phrase) {
        sendToolResult(tool.callId, { ok: false, error: "missing_slot_phrase" });
      } else if (!eligibility.ok) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: "appointment_not_ready", instruction: eligibility.reason });
      } else {
        ctx.confirmedSlotPhrase = phrase;
        log.info("realtime.slot_locked", { callSid: ctx.callSid, slot: phrase });
        sendToolResult(tool.callId, { ok: true, confirmed_slot: phrase });
        updateSession();
        if (preparationQuestions.length > 0) {
          preparationMode = "awaiting_consent";
          requestResponse(
            `Bestätige nur den Termin ${phrase}. Frage danach exakt: "Für die Vorbereitung würde ich Ihnen noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?"`,
          );
          return;
        }
      }
      requestResponse();
      return;
    }

    if (tool.name === "transfer_to_human") {
      sendToolResult(tool.callId, { ok: true });
      log.info("realtime.transfer", { callSid: ctx.callSid });
      await notifyCallAction(ctx, "transfer");
      return;
    }

    if (tool.name === "end_call") {
      sendToolResult(tool.callId, { ok: true });
      log.info("realtime.hangup", { callSid: ctx.callSid });
      await notifyCallAction(ctx, "hangup");
    }
  };

  const connectOpenAi = () => {
    if (!ctx || openai) return;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1";

    openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    openai.on("open", () => {
      sessionReady = true;
      updateSession();
      for (const payload of queuedAudio.splice(0)) {
        sendOpenAi({ type: "input_audio_buffer.append", audio: payload });
      }
      log.info("realtime.connected", { callSid: ctx?.callSid, model, audioFormat });
    });

    openai.on("message", (data: WebSocket.RawData) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(data.toString()) as RealtimeMessage;
      } catch {
        return;
      }

      if (message.type === "error") {
        const errorMessage = message.error?.message || "unknown_realtime_error";
        if (/cancellation failed: no active response found/i.test(errorMessage)) {
          return;
        }
        log.error("realtime.session_error", {
          callSid: ctx?.callSid,
          error: errorMessage,
        });
        return;
      }

      if (message.type === "input_audio_buffer.speech_started") {
        if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
        silenceOpenerTimer = null;
        if (activeResponse && assistantTranscript.trim().length > 0) {
          const hasMeaningfulUserTurn = /[a-zäöüß]/i.test((message.transcript || "").trim()) || assistantTranscript.trim().length > 0;
          if (hasMeaningfulUserTurn) {
            sendOpenAi({ type: "response.cancel" });
            if (activeAssistantItemId && outboundAudioBytes > 0) {
              interruptedItemIds.add(activeAssistantItemId);
              sendOpenAi({
                type: "conversation.item.truncate",
                item_id: activeAssistantItemId,
                content_index: 0,
                audio_end_ms: Math.floor(outboundAudioBytes / 8),
              });
            }
            sendTelnyx({ event: "clear", stream_id: streamId });
            activeResponse = false;
            outboundAudioBuffer = Buffer.alloc(0);
            assistantTranscript = "";
            log.info("realtime.barge_in", { callSid: ctx?.callSid });
          }
        }
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = message.transcript?.trim();
        if (ctx && transcript) {
          ctx.lastUserFinalAt = Date.now();
          ctx.transcript.push({ role: "user", text: transcript, at: Date.now() });
          log.info("realtime.user_said", { callSid: ctx.callSid, text: transcript });

          if (preparationMode === "awaiting_consent") {
            const consent = isPreparationConsent(transcript);
            if (consent === "granted") {
              preparationMode = "asking";
              preparationQuestionIndex = 0;
              requestResponse(`Stelle ausschließlich diese Vorbereitungsfrage: "${preparationQuestions[0]}"`);
            } else if (consent === "declined") {
              preparationMode = "complete";
              requestResponse("Akzeptiere die Absage an die Vorbereitungsfragen ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.");
            } else {
              requestResponse("Die Antwort war unklar. Frage freundlich noch einmal nur, ob zwei Minuten für kurze Vorbereitungsfragen passen.");
            }
          } else if (preparationMode === "asking") {
            preparationQuestionIndex += 1;
            const nextQuestion = preparationQuestions[preparationQuestionIndex];
            if (nextQuestion) {
              requestResponse(`Bedanke dich knapp und stelle ausschließlich die nächste Vorbereitungsfrage: "${nextQuestion}"`);
            } else {
              preparationMode = "complete";
              requestResponse("Die Vorbereitungsfragen sind vollständig. Bedanke dich kurz und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.");
            }
          } else if (!activeResponse) {
            requestResponse();
          }
        }
        return;
      }

      if (message.type === "response.created") {
        activeResponse = true;
        activeAssistantItemId = "";
        outboundAudioBytes = 0;
        outboundAudioBuffer = Buffer.alloc(0);
        assistantTranscript = "";
        return;
      }

      if (message.type === "response.output_audio.delta" || message.type === "response.audio.delta") {
        if (message.delta) {
          activeAssistantItemId = message.item_id || activeAssistantItemId;
          outboundAudioBuffer = Buffer.concat([outboundAudioBuffer, Buffer.from(message.delta, "base64")]);
          while (outboundAudioBuffer.length >= 160) {
            const frame = outboundAudioBuffer.subarray(0, 160);
            outboundAudioBuffer = outboundAudioBuffer.subarray(160);
            outboundAudioBytes += frame.length;
            sendTelnyx({ event: "media", stream_id: streamId, media: { payload: frame.toString("base64") } });
          }
        }
        return;
      }

      if (message.type === "response.output_audio.done") {
        if (outboundAudioBuffer.length > 0) {
          const silenceByte = audioFormat === "audio/pcma" ? 0xd5 : 0xff;
          const frame = Buffer.concat([
            outboundAudioBuffer,
            Buffer.alloc(160 - outboundAudioBuffer.length, silenceByte),
          ]);
          outboundAudioBytes += frame.length;
          sendTelnyx({ event: "media", stream_id: streamId, media: { payload: frame.toString("base64") } });
          outboundAudioBuffer = Buffer.alloc(0);
        }
        return;
      }

      if (message.type === "response.output_audio_transcript.delta" || message.type === "response.audio_transcript.delta") {
        assistantTranscript += message.delta || "";
        return;
      }

      if (message.type === "response.output_audio_transcript.done" || message.type === "response.audio_transcript.done") {
        if (message.item_id && interruptedItemIds.delete(message.item_id)) {
          assistantTranscript = "";
          return;
        }
        const transcript = (message.transcript || assistantTranscript).trim();
        if (ctx && transcript) {
          const latencyMs = ctx.lastUserFinalAt ? Date.now() - ctx.lastUserFinalAt : undefined;
          ctx.transcript.push({ role: "assistant", text: transcript, at: Date.now(), latencyMs });
          log.info("realtime.gloria_said", { callSid: ctx.callSid, text: transcript, latencyMs });
        }
        assistantTranscript = "";
        return;
      }

      if (message.type === "response.function_call_arguments.done" && message.name && message.call_id) {
        void handleToolCall({
          name: message.name,
          callId: message.call_id,
          argumentsJson: message.arguments || "{}",
        });
        return;
      }

      if (message.type === "response.done") {
        activeResponse = false;
        for (const item of message.response?.output || []) {
          if (item.type === "function_call" && item.name && item.call_id) {
            void handleToolCall({
              name: item.name,
              callId: item.call_id,
              argumentsJson: item.arguments || "{}",
            });
          }
        }
      }
    });

    openai.on("close", (code, reason) => {
      sessionReady = false;
      log.info("realtime.closed", { callSid: ctx?.callSid, code, reason: reason.toString() });
    });

    openai.on("error", (error) => {
      log.error("realtime.socket_error", { callSid: ctx?.callSid, error: error.message });
    });
  };

  telnyx.on("message", (raw) => {
    let frame: TelnyxFrame;
    try {
      frame = JSON.parse(raw.toString()) as TelnyxFrame;
    } catch {
      return;
    }

    if (frame.event === "start") {
      const state = decodeClientState(frame.start.client_state);
      streamId = frame.stream_id;
      audioFormat = openAiAudioFormat(frame.start.media_format?.encoding);
      ctx = newContext({
        callSid: frame.start.call_control_id,
        streamSid: frame.stream_id,
        userId: state.userId,
        leadId: state.leadId,
        company: state.company,
        contactName: state.contactName,
        leadNote: state.leadNote,
        topic: state.topic,
        ownerRealName: state.ownerRealName,
        ownerCompanyName: state.ownerCompanyName,
        ownerGesellschaft: state.ownerGesellschaft,
        previousSummary: state.previousSummary,
        isCallback: state.isCallback === 1,
      });
      log.info("realtime.call_started", {
        callSid: ctx.callSid,
        streamSid: streamId,
        audioFormat,
        topic: ctx.topic,
      });
      connectOpenAi();

      void loadTopicPolicy({ userId: ctx.userId, topic: ctx.topic }).then((policy) => {
        if (!ctx || !policy) return;
        ctx.topicPolicyPrompt = topicPolicyToSystemPrompt(policy);
        preparationQuestions = splitPreparationQuestions(policy);
        updateSession();
        log.info("realtime.topic_policy_applied", { callSid: ctx.callSid, topic: policy.topic });
      });

      void loadBusySlots({ userId: ctx.userId }).then((slots) => {
        if (!ctx) return;
        const busySlots = slots || [];
        const free = computeFreeSlots(busySlots, {
          daysAhead: 14,
          maxCount: 8,
          bufferMinutes: 90,
          minLeadDays: 7,
        });
        ctx.freeSlotsPrompt = freeSlotsToPrompt(free);
        updateSession();
        log.info("realtime.calendar_applied", { callSid: ctx.callSid, busy: busySlots.length, free: free.length });
      }).catch(() => undefined);

      const silenceMs = Math.max(2500, Number.parseInt(process.env.TELNYX_SILENCE_OPENER_MS || "4200", 10));
      silenceOpenerTimer = setTimeout(() => {
        if (!ctx || activeResponse) return;
        sendOpenAi({
          type: "response.create",
          response: {
            instructions: "Am anderen Ende ist noch niemand hörbar. Begrüße jetzt kurz, stelle dich transparent vor und frage nach dem gewünschten Ansprechpartner. Dann warte.",
          },
        });
      }, silenceMs);
      return;
    }

    if (frame.event === "media") {
      if (frame.media.track === "outbound" || frame.media.track === "outbound_track") return;
      if (!sessionReady) {
        queuedAudio.push(frame.media.payload);
        if (queuedAudio.length > 500) queuedAudio.shift();
      } else {
        sendOpenAi({ type: "input_audio_buffer.append", audio: frame.media.payload });
      }
      return;
    }

    if (frame.event === "stop") {
      try {
        openai?.close(1000, "call_finished");
      } catch {
        /* ignore */
      }
      try {
        telnyx.close(1000, "stop");
      } catch {
        /* ignore */
      }
    }
  });

  telnyx.on("close", async (code, reason) => {
    if (closed) return;
    closed = true;
    if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
    try {
      openai?.close(1000, "telnyx_closed");
    } catch {
      /* ignore */
    }
    log.info("realtime.telnyx_closed", { callSid: ctx?.callSid, code, reason: reason.toString() });
    if (ctx && !reportPosted) {
      reportPosted = true;
      await postReport(ctx).catch((error) => {
        log.error("realtime.finalize_failed", {
          callSid: ctx?.callSid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  telnyx.on("error", (error) => {
    log.error("realtime.telnyx_error", { callSid: ctx?.callSid, error: error.message });
  });
}
