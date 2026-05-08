/**
 * sipgate Record-Loop: Recording → Whisper STT → LLM → ElevenLabs TTS → sipgate XML
 *
 * sipgate POSTs here after every <Record> action completes, with form fields:
 *   recordingUrl – HTTPS URL to the audio file (WAV or MP3)
 *   callId        – unique call identifier
 *   duration      – recording duration in seconds
 *   (+ any extra sipgate fields)
 *
 * We respond with sipgate XML: <Play> the AI reply + <Record> for the next turn,
 * or <Hangup> when the conversation is done.
 */

import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/twilio";
import {
  buildSipgateRecordXml,
  buildSipgatePlayHangupXml,
  buildSipgateHangupXml,
  getSipgateAuthHeader,
} from "@/lib/sipgate";
import {
  encodeCallStateToken,
  decodeCallStateToken,
  type TokenizedCallState,
  type ContactRole,
  type RoleState,
} from "@/lib/call-state-token";
import { buildCallSystemPrompt } from "@/lib/gloria";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildSignedAudioUrl } from "@/lib/audio-url";
import { appendCallTranscriptEventToPostgres } from "@/lib/report-db";
import { AI_CONFIG } from "@/lib/ai-config";
import { log } from "@/lib/log";
import { z } from "zod";
import type { Topic, ReportOutcome, ScriptConfig } from "@/lib/types";
import { TOPICS } from "@/lib/types";
import {
  normalizeContactName,
  normalizeDirectDial,
  extractDirectDialFromText,
} from "@/lib/phone-utils";
import { buildInternalHeaders } from "@/lib/internal-auth";

export const runtime = "nodejs"; // needs fetch + streaming + Buffer
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const AI_MODEL = AI_CONFIG.chatModel;
const AI_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.SIPGATE_AI_TIMEOUT_MS || process.env.LIVE_AI_TIMEOUT_MS || "5000", 10), 3000),
  10000,
);
const AI_RETRY_ATTEMPTS = Math.min(
  3,
  Math.max(parseInt(process.env.LIVE_AI_RETRY_ATTEMPTS || "2", 10), 1),
);
const RECORD_MAX_LENGTH = Math.min(
  90,
  Math.max(10, parseInt(process.env.SIPGATE_RECORD_MAX_LENGTH || "60", 10)),
);
const RECORD_TIMEOUT = Math.min(
  20,
  Math.max(3, parseInt(process.env.SIPGATE_RECORD_TIMEOUT || "6", 10)),
);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function verifyWebhookSecret(request: Request): boolean {
  const expected = process.env.SIPGATE_WEBHOOK_SECRET?.trim();
  if (!expected) return true;
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret") || "";
  return provided === expected;
}

// ---------------------------------------------------------------------------
// LLM schema
// ---------------------------------------------------------------------------
const GloriaDecisionSchema = z.object({
  detectedRole: z.enum(["gatekeeper", "decision-maker", "unknown"]).catch("unknown"),
  reply: z
    .string()
    .trim()
    .min(1)
    .catch("Entschuldigung, ich hatte kurz eine Verbindungsstörung. Ich bin gleich wieder da."),
  action: z
    .enum(["continue", "end_success", "end_rejection", "end_callback"])
    .catch("continue"),
  appointmentNote: z.string().catch(""),
  appointmentAtISO: z.string().transform((v) => v.trim()).catch(""),
  directDial: z.string().transform((v) => v.trim()).catch(""),
  consentGiven: z.boolean().nullable().catch(null),
});

type GloriaDecision = z.infer<typeof GloriaDecisionSchema>;

// ---------------------------------------------------------------------------
// Whisper STT
// ---------------------------------------------------------------------------
async function transcribeAudio(audioUrl: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY fehlt für Whisper STT.");

  const authForRecording = process.env.SIPGATE_TOKEN_ID?.trim()
    ? getSipgateAuthHeader()
    : undefined;

  const downloadHeaders: Record<string, string> = authForRecording
    ? { Authorization: authForRecording }
    : {};

  const audioResp = await fetch(audioUrl, { headers: downloadHeaders });
  if (!audioResp.ok) {
    throw new Error(`Recording download failed: ${audioResp.status} ${audioUrl}`);
  }

  const audioBuffer = await audioResp.arrayBuffer();
  const contentType = audioResp.headers.get("content-type") || "audio/wav";
  const ext = contentType.includes("mp3") ? "mp3" : "wav";
  const filename = `sipgate_recording.${ext}`;

  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: contentType }), filename);
  formData.append("model", "whisper-1");
  formData.append("language", "de");
  formData.append("response_format", "text");

  const whisperResp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!whisperResp.ok) {
    const details = await whisperResp.text().catch(() => "");
    throw new Error(`Whisper error (${whisperResp.status}): ${details}`);
  }

  const text = await whisperResp.text();
  return text.trim();
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------
async function askOpenAI(
  systemPrompt: string,
  contactName: string | undefined,
  transcript: string,
  latestSpeech: string,
  currentRole: ContactRole,
  currentStep: TokenizedCallState["step"],
): Promise<GloriaDecision> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY fehlt.");

  const roleLabel =
    currentRole === "decision-maker"
      ? "Entscheider (bereits bestätigt)"
      : "Empfang/Gatekeeper (oder noch unbekannt)";

  const nowIso = new Date().toISOString();
  const userContent = [
    `Aktuelles Datum/Uhrzeit (UTC): ${nowIso}. Verwende dieses Datum als Referenz für alle Terminvorschläge.`,
    transcript
      ? `Bisheriger Gesprächsverlauf:\n${transcript}`
      : "(Gesprächsbeginn – erste Äußerung der anderen Seite)",
    "",
    `Angerufener sagt jetzt: "${latestSpeech}"`,
    `Zuletzt erkannte Rolle: ${roleLabel}`,
    `Erwartete Gesprächsphase: ${currentStep}`,
  ].join("\n");

  const nameGuidance =
    contactName
      ? `\n\nWICHTIG: Der Name des Ansprechpartners lautet "${contactName}". Verwende diesen Namen sparsam und natürlich.`
      : "";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  const started = Date.now();

  try {
    const isGpt5Family = /^gpt-5/i.test(AI_MODEL);
    const body: Record<string, unknown> = {
      model: AI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${systemPrompt}${nameGuidance}` },
        { role: "user", content: userContent },
      ],
    };
    if (isGpt5Family) {
      body.max_completion_tokens = 260;
    } else {
      body.max_tokens = 220;
      body.temperature = 0.3;
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`OpenAI error (${response.status}): ${details}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    log.info("sipgate.openai.reply", {
      latencyMs: Date.now() - started,
      step: currentStep,
      role: currentRole,
    });

    const rawContent = payload.choices?.[0]?.message?.content || "{}";
    let parsed: unknown = {};
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      throw new Error("OpenAI response was not valid JSON");
    }

    const validation = GloriaDecisionSchema.safeParse(parsed);
    if (!validation.success) {
      throw new Error("OpenAI response failed schema validation");
    }

    return validation.data;
  } finally {
    clearTimeout(timer);
  }
}

async function askOpenAIWithRetry(
  systemPrompt: string,
  contactName: string | undefined,
  transcript: string,
  latestSpeech: string,
  currentRole: ContactRole,
  currentStep: TokenizedCallState["step"],
): Promise<GloriaDecision> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= AI_RETRY_ATTEMPTS; attempt++) {
    try {
      return await askOpenAI(systemPrompt, contactName, transcript, latestSpeech, currentRole, currentStep);
    } catch (err) {
      lastError = err;
      log.warn("sipgate.openai.retry", {
        attempt,
        reason: err instanceof Error ? err.message : String(err),
      });
      if (attempt < AI_RETRY_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OpenAI retry failed");
}

// ---------------------------------------------------------------------------
// Script loader (playbook)
// ---------------------------------------------------------------------------
const scriptsCacheByUser: Record<string, Partial<Record<Topic, ScriptConfig>>> = {};
const scriptsCacheAtByUser: Record<string, number> = {};
const SCRIPT_CACHE_MS = 60_000;

async function loadScript(
  baseUrl: string,
  topic: Topic,
  userId?: string,
): Promise<ScriptConfig | undefined> {
  const cacheKey = userId || "global";
  const now = Date.now();
  const cachedAt = scriptsCacheAtByUser[cacheKey] ?? 0;

  if (now - cachedAt < SCRIPT_CACHE_MS && scriptsCacheByUser[cacheKey]) {
    return scriptsCacheByUser[cacheKey]?.[topic];
  }

  try {
    const qs = userId ? `?userId=${encodeURIComponent(userId)}` : "";
    const resp = await fetch(`${baseUrl}/api/twilio/playbooks${qs}`, {
      headers: buildInternalHeaders(),
      cache: "no-store",
    });
    if (!resp.ok) return undefined;
    const data = (await resp.json()) as { playbooks?: ScriptConfig[] };
    const map: Partial<Record<Topic, ScriptConfig>> = {};
    for (const pb of data.playbooks || []) {
      if (pb.topic) map[pb.topic as Topic] = pb;
    }
    scriptsCacheByUser[cacheKey] = map;
    scriptsCacheAtByUser[cacheKey] = now;
    return map[topic];
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transcript helpers
// ---------------------------------------------------------------------------
function trimTranscript(text: string, maxLen = 3500): string {
  if (text.length <= maxLen) return text;
  const lines = text.split("\n");
  const keepTail = lines.slice(-18);
  let compact = keepTail.join("\n");
  if (compact.length > maxLen) compact = compact.slice(compact.length - maxLen);
  return compact;
}

function normalizeAppointmentAt(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  const now = Date.now();
  if (parsed < now - 5 * 60_000 || parsed > now + 180 * 24 * 60 * 60_000) return undefined;
  return new Date(parsed).toISOString();
}

function detectRoleState(params: {
  currentRole: ContactRole;
  modelDetectedRole: GloriaDecision["detectedRole"];
  heardText: string;
}): { contactRole: ContactRole; roleState: RoleState } {
  const lower = params.heardText.toLowerCase();

  if (params.currentRole === "decision-maker" || params.modelDetectedRole === "decision-maker") {
    return { contactRole: "decision-maker", roleState: "decision_maker" };
  }

  if (/\b(verbinde|einen\s+moment|ich\s+stell\s+durch|ich\s+verbinde)\b/.test(lower)) {
    return { contactRole: "gatekeeper", roleState: "transfer" };
  }

  const isAlreadyDM = /\b(ich\s+bin\s+(schon\s+)?dran|ich\s+bin\s+am\s+apparat|ja,?\s*selbst\b|das\s+bin\s+ich\b|spreche\s+selbst)\b/.test(lower);
  if (isAlreadyDM) return { contactRole: "decision-maker", roleState: "decision_maker" };

  return { contactRole: "gatekeeper", roleState: "reception" };
}

// ---------------------------------------------------------------------------
// Report / transcript persistence
// ---------------------------------------------------------------------------
async function persistTranscriptChunk(params: {
  baseUrl: string;
  callSid?: string;
  userId?: string;
  leadId?: string;
  company: string;
  contactName?: string;
  topic: Topic;
  phoneNumberId?: string;
  text: string;
  speaker: "Gloria" | "Interessent";
  latencyMs?: number;
}) {
  if (!params.callSid) return;

  void appendCallTranscriptEventToPostgres({
    callSid: params.callSid,
    userId: params.userId,
    speaker: params.speaker,
    text: params.text,
    latencyMs: params.latencyMs,
  }).catch(() => {});

  void fetch(`${params.baseUrl}/api/calls/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: params.userId,
      phoneNumberId: params.phoneNumberId,
      callSid: params.callSid,
      leadId: params.leadId,
      company: params.company,
      contactName: params.contactName,
      topic: params.topic,
      summaryChunk: `${params.speaker}: ${params.text}`,
      attempts: 1,
    }),
    cache: "no-store",
  }).catch(() => {});
}

async function finalizeCall(params: {
  state: TokenizedCallState;
  outcome: ReportOutcome;
  note: string;
  appointmentAt?: string;
  nextCallAt?: string;
  directDial?: string;
  baseUrl: string;
}): Promise<void> {
  const directDialLine = params.directDial ? `\nDirekte Durchwahl: ${params.directDial}` : "";
  const callbackLine =
    params.outcome === "Wiedervorlage" && params.nextCallAt
      ? `\n\n--- Wiedervorlage ---\nGeplanter Rückruf: ${params.nextCallAt}`
      : "";
  const summary = params.note
    ? `${params.state.transcript}\n\n--- Terminnotiz ---\n${params.note}${directDialLine}${callbackLine}`
    : `${params.state.transcript}${directDialLine}${callbackLine}`;

  await fetch(`${params.baseUrl}/api/calls/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: params.state.userId,
      phoneNumberId: params.state.phoneNumberId,
      callSid: params.state.callSid,
      leadId: params.state.leadId,
      company: params.state.company,
      contactName: params.state.contactName,
      topic: params.state.topic,
      summary,
      outcome: params.outcome,
      appointmentAt: params.appointmentAt,
      nextCallAt: params.nextCallAt,
      directDial: params.directDial,
      recordingConsent: params.state.consent === "yes",
      attempts: 1,
    }),
    cache: "no-store",
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Build response XML helpers
// ---------------------------------------------------------------------------
async function buildRecordResponse(
  baseUrl: string,
  replyText: string,
  nextState: Omit<TokenizedCallState, "issuedAt" | "expiresAt">,
): Promise<NextResponse> {
  const token = await encodeCallStateToken(nextState);
  const secret = process.env.SIPGATE_WEBHOOK_SECRET?.trim();
  const actionUrl = new URL(`${baseUrl}/api/sipgate/respond`);
  actionUrl.searchParams.set("state", token);
  if (secret) actionUrl.searchParams.set("secret", secret);

  const useElevenLabs = isElevenLabsConfigured();
  let audioUrl: string | undefined;
  if (useElevenLabs) {
    try {
      audioUrl = await buildSignedAudioUrl(baseUrl, replyText);
    } catch {
      // Fall back to sipgate Say
    }
  }

  const xml = buildSipgateRecordXml({
    ...(audioUrl ? { playUrl: audioUrl } : { sayText: replyText }),
    actionUrl: actionUrl.toString(),
    maxLength: RECORD_MAX_LENGTH,
    timeout: RECORD_TIMEOUT,
  });

  return new NextResponse(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

async function buildHangupResponse(replyText: string, baseUrl: string): Promise<NextResponse> {
  const hasThanks = /danke|vielen\s+dank/i.test(replyText);
  const hasGoodbye = /auf\s+wiederh[oö]ren|tschüss|bis\s+bald/i.test(replyText);
  const outro = `${hasThanks ? "" : " Vielen Dank für das Telefonat."}${hasGoodbye ? "" : " Auf Wiederhören."}`;
  const finalText = `${replyText.trim()}${outro}`.trim();

  const useElevenLabs = isElevenLabsConfigured();
  let audioUrl: string | undefined;
  if (useElevenLabs) {
    try {
      audioUrl = await buildSignedAudioUrl(baseUrl, finalText);
    } catch {
      // Fall back to Say
    }
  }

  const xml = buildSipgatePlayHangupXml(
    audioUrl ? { playUrl: audioUrl } : { sayText: finalText },
  );
  return new NextResponse(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function POST(request: Request): Promise<NextResponse> {
  const started = Date.now();

  if (!verifyWebhookSecret(request)) {
    log.warn("sipgate.respond.secret_mismatch");
    return new NextResponse(buildSipgateHangupXml(), {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

  const url = new URL(request.url);
  const baseUrl = getAppBaseUrl(request);
  const tokenFromQuery = url.searchParams.get("state") || "";
  const noSpeech = url.searchParams.get("noSpeech") === "1";

  // Parse sipgate form body
  let form: Record<string, string> = {};
  try {
    const fd = await request.clone().formData();
    for (const [key, value] of fd.entries()) form[key] = String(value);
  } catch {
    // noop
  }

  const callId = form.callId || form.xmlCallId || url.searchParams.get("callId") || "";
  const recordingUrl = form.recordingUrl || form.RecordingUrl || "";
  const durationRaw = form.duration || form.Duration || "0";
  const duration = parseInt(durationRaw, 10) || 0;

  log.info("sipgate.respond.received", {
    callId,
    recordingUrl: recordingUrl ? "[present]" : "[missing]",
    duration,
    noSpeech,
  });

  // Decode call state token
  const state = await decodeCallStateToken(tokenFromQuery, undefined);
  if (!state) {
    log.warn("sipgate.respond.invalid_token", { callId });
    return new NextResponse(
      buildSipgateHangupXml("Entschuldigung, es gab einen technischen Fehler. Auf Wiederhören."),
      { headers: { "Content-Type": "application/xml; charset=utf-8" } },
    );
  }

  // Handle no-speech redirect (caller was silent)
  if (noSpeech || !recordingUrl || duration < 1) {
    const silentTurn = state.turn;
    if (silentTurn >= 3) {
      // Too many silent turns → end call politely
      await finalizeCall({
        state,
        outcome: "Kein Kontakt",
        note: "Anruf wurde wegen ausbleibender Antwort beendet.",
        baseUrl,
      });
      return buildHangupResponse(
        "Ich höre leider niemanden. Ich melde mich gerne zu einem anderen Zeitpunkt. Auf Wiederhören.",
        baseUrl,
      );
    }

    // Prompt again
    const nextState = { ...state, turn: state.turn + 1 };
    return buildRecordResponse(
      baseUrl,
      "Entschuldigung, ich habe Sie nicht verstanden. Bitte sprechen Sie nach dem Signal.",
      nextState,
    );
  }

  // Transcribe recording via Whisper
  let heardText = "";
  try {
    heardText = await transcribeAudio(recordingUrl);
  } catch (err) {
    log.error("sipgate.respond.stt_failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    // Graceful degradation: continue without speech
    heardText = "";
  }

  if (!heardText.trim() || heardText.length < 3) {
    const nextState = { ...state, turn: state.turn + 1 };
    return buildRecordResponse(
      baseUrl,
      "Entschuldigung, das habe ich nicht verstanden. Bitte wiederholen Sie das kurz.",
      nextState,
    );
  }

  log.info("sipgate.respond.stt", {
    callId,
    turn: state.turn,
    heardChars: heardText.length,
    heardPreview: heardText.slice(0, 80),
    latencyMs: Date.now() - started,
  });

  // Persist caller speech
  await persistTranscriptChunk({
    baseUrl,
    callSid: state.callSid || callId || undefined,
    userId: state.userId,
    leadId: state.leadId,
    company: state.company,
    contactName: state.contactName,
    topic: state.topic,
    phoneNumberId: state.phoneNumberId,
    text: heardText,
    speaker: "Interessent",
  });

  // Build transcript for LLM
  const transcriptWithSpeech = state.transcript
    ? `${state.transcript}\nInteressent: ${heardText}`
    : `Interessent: ${heardText}`;
  const trimmedTranscript = trimTranscript(transcriptWithSpeech);

  // Load playbook / script
  const script = await loadScript(baseUrl, state.topic, state.userId);
    const effectiveScript: ScriptConfig = script || {
      id: `sipgate-fallback-${state.topic}`,
      topic: state.topic,
      opener: `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn ${state.ownerRealName || "Matthias Duic"} an.`,
      discovery: `Wie ist das Thema ${state.topic} bei Ihnen aktuell aufgestellt?`,
      objectionHandling: "Kurz, souverän und ohne Druck auf Einwände reagieren.",
      close: "Natürlich in die Terminierung mit Herrn Duic überleiten.",
      gatekeeperTask: state.contactName
        ? `Freundlich um Weiterleitung zu ${state.contactName} bitten.`
        : "Freundlich um Weiterleitung zur zuständigen Person bitten.",
      decisionMakerContext: `Gespräch mit ${state.company} zum Thema ${state.topic}.`,
      receptionTopicReason: `Eine kurze fachliche Frage zum Thema ${state.topic}.`,
    };
    const systemPrompt = buildCallSystemPrompt(effectiveScript);

  // Ask LLM
  let decision: GloriaDecision;
  try {
    decision = await askOpenAIWithRetry(
      systemPrompt,
      state.contactName,
      trimmedTranscript,
      heardText,
      state.contactRole,
      state.step,
    );
  } catch (err) {
    log.error("sipgate.respond.llm_failed", {
      reason: err instanceof Error ? err.message : String(err),
    });
    decision = {
      detectedRole: "unknown",
      reply: "Entschuldigung, ich hatte kurz eine technische Störung. Könnten Sie das bitte wiederholen?",
      action: "continue",
      appointmentNote: "",
      appointmentAtISO: "",
      directDial: "",
      consentGiven: null,
    };
  }

  const llmLatencyMs = Date.now() - started;

  // Detect role transitions
  const { contactRole, roleState } = detectRoleState({
    currentRole: state.contactRole,
    modelDetectedRole: decision.detectedRole,
    heardText,
  });

  // Consent handling
  let consent = state.consent;
  if (decision.consentGiven === true) consent = "yes";
  else if (decision.consentGiven === false) consent = "no";

  // Direct dial
  const extractedDial = extractDirectDialFromText(heardText) || "";
  const directDial = normalizeDirectDial(decision.directDial || extractedDial) || undefined;

  // Appointment
  const appointmentAt = normalizeAppointmentAt(decision.appointmentAtISO);

  // Persist Gloria's reply
  await persistTranscriptChunk({
    baseUrl,
    callSid: state.callSid || callId || undefined,
    userId: state.userId,
    leadId: state.leadId,
    company: state.company,
    contactName: state.contactName,
    topic: state.topic,
    phoneNumberId: state.phoneNumberId,
    text: decision.reply,
    speaker: "Gloria",
    latencyMs: llmLatencyMs,
  });

  // Build updated state
  const updatedTranscript = `${transcriptWithSpeech}\nGloria: ${decision.reply}`;
  const nextState: Omit<TokenizedCallState, "issuedAt" | "expiresAt"> = {
    ...state,
    callSid: state.callSid || callId || undefined,
    contactRole,
    roleState,
    consent,
    turn: state.turn + 1,
    transcript: trimTranscript(updatedTranscript),
    directDial: directDial || state.directDial,
    appointmentAtDraft: appointmentAt || state.appointmentAtDraft,
    appointmentNoteDraft: decision.appointmentNote || state.appointmentNoteDraft,
  };

  // Check if we need to end the call
  if (decision.action === "end_success") {
    void finalizeCall({
      state: { ...nextState, issuedAt: 0, expiresAt: 0 },
        outcome: "Termin",
      note: decision.appointmentNote,
      appointmentAt,
      directDial: directDial || state.directDial,
      baseUrl,
    });
    return buildHangupResponse(decision.reply, baseUrl);
  }

  if (decision.action === "end_rejection") {
    void finalizeCall({
      state: { ...nextState, issuedAt: 0, expiresAt: 0 },
        outcome: "Absage",
      note: decision.appointmentNote || "Interessent hat abgelehnt.",
      directDial: directDial || state.directDial,
      baseUrl,
    });
    return buildHangupResponse(decision.reply, baseUrl);
  }

  if (decision.action === "end_callback") {
    void finalizeCall({
      state: { ...nextState, issuedAt: 0, expiresAt: 0 },
      outcome: "Wiedervorlage",
      note: decision.appointmentNote || "Rückruf erbeten.",
      directDial: directDial || state.directDial,
      baseUrl,
    });
    return buildHangupResponse(decision.reply, baseUrl);
  }

  // Safety limit: max 20 turns to prevent runaway loops
  if (state.turn >= 20) {
    void finalizeCall({
      state: { ...nextState, issuedAt: 0, expiresAt: 0 },
      outcome: "Kein Kontakt",
      note: "Gesprächslimit erreicht.",
      baseUrl,
    });
    return buildHangupResponse(
      "Vielen Dank für das Gespräch. Ich melde mich bei Bedarf erneut. Auf Wiederhören.",
      baseUrl,
    );
  }

  // Continue the conversation
  return buildRecordResponse(baseUrl, decision.reply, nextState);
}
