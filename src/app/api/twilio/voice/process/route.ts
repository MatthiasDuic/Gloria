/**
 * Gloria – Twilio voice-process handler (OpenAI-driven).
 *
 * Each call turn is handled by OpenAI (gpt-4o recommended).
 * The model detects whether Gloria is speaking to the GATEKEEPER or the
 * DECISION-MAKER and generates the next response.  No regex-based detection,
 * no hard-coded state machine.
 *
 * ENV:
 *   OPENAI_MODEL          – defaults to "gpt-4o" (strongly recommended over
 *                           gpt-4o-mini for accurate role detection)
 *   LIVE_AI_TIMEOUT_MS    – OpenAI call timeout in ms (default 3000, min 800, max 6000)
 */
import { NextResponse } from "next/server";
import twilio from "twilio";
import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { sendReportEmail } from "@/lib/mailer";
import { buildCallSystemPrompt } from "@/lib/gloria";
import { getDashboardData, storeCallReport } from "@/lib/storage";
import { getAppBaseUrl } from "@/lib/twilio";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, ScriptConfig, Topic } from "@/lib/types";

export const runtime = "nodejs";

// ─── Configuration ────────────────────────────────────────────────────────────
// Upgrade OPENAI_MODEL to "gpt-4o" in .env.local for best role detection quality.
const AI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o";
const AI_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.LIVE_AI_TIMEOUT_MS || "3000", 10), 800),
  6000,
);
const MAX_TURNS = 15;

// ─── Types ────────────────────────────────────────────────────────────────────
interface GloriaDecision {
  detectedRole: "gatekeeper" | "decision-maker" | "unknown";
  reply: string;
  action: "continue" | "end_success" | "end_rejection" | "end_callback";
  appointmentNote: string;
  consentGiven: boolean | null;
}

type StatePayload = Omit<TokenizedCallState, "issuedAt" | "expiresAt">;

// ─── OpenAI client ────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI(
  systemPrompt: string,
  transcript: string,
  latestSpeech: string,
  currentRole: ContactRole,
): Promise<GloriaDecision> {
  const roleLabel =
    currentRole === "decision-maker"
      ? "Entscheider (bereits bestätigt)"
      : "Empfang/Gatekeeper (oder noch unbekannt)";

  const userContent = [
    transcript
      ? `Bisheriger Gesprächsverlauf:\n${transcript}`
      : "(Gesprächsbeginn – erste Äußerung der anderen Seite)",
    "",
    `Angerufener sagt jetzt: "${latestSpeech}"`,
    `Zuletzt erkannte Rolle: ${roleLabel}`,
  ].join("\n");

  const raceResult = await Promise.race([
    openai.chat.completions.create({
      stream: false as const,
      model: AI_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.25,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("OpenAI timeout")), AI_TIMEOUT_MS),
    ),
  ]);
  const completion = raceResult as ChatCompletion;

  let parsed: Partial<GloriaDecision> = {};
  try {
    parsed = JSON.parse(
      completion.choices[0]?.message?.content || "{}",
    ) as Partial<GloriaDecision>;
  } catch {
    /* keep defaults below */
  }

  const validActions = [
    "continue",
    "end_success",
    "end_rejection",
    "end_callback",
  ] as const;
  const validRoles = ["gatekeeper", "decision-maker", "unknown"] as const;

  return {
    detectedRole: validRoles.includes(parsed.detectedRole as (typeof validRoles)[number])
      ? (parsed.detectedRole as GloriaDecision["detectedRole"])
      : "unknown",
    reply:
      typeof parsed.reply === "string" && parsed.reply.trim().length > 0
        ? parsed.reply.trim()
        : "Entschuldigung, ich hatte kurz eine Verbindungsstörung. Ich bin wieder da.",
    action: validActions.includes(parsed.action as (typeof validActions)[number])
      ? (parsed.action as GloriaDecision["action"])
      : "continue",
    appointmentNote:
      typeof parsed.appointmentNote === "string" ? parsed.appointmentNote : "",
    consentGiven:
      typeof parsed.consentGiven === "boolean" ? parsed.consentGiven : null,
  };
}

// ─── TwiML helpers ────────────────────────────────────────────────────────────
function buildAudioUrl(baseUrl: string, text: string) {
  const u = new URL(`${baseUrl}/api/twilio/audio`);
  u.searchParams.set("text", text);
  return u.toString();
}

function respondWithGather(
  twiml: twilio.twiml.VoiceResponse,
  baseUrl: string,
  text: string,
  nextState: StatePayload,
): NextResponse {
  const token = encodeCallStateToken(nextState);
  const actionUrl = `${baseUrl}/api/twilio/voice/process?state=${encodeURIComponent(token)}`;

  if (isElevenLabsConfigured()) {
    twiml.play(buildAudioUrl(baseUrl, text));
  } else {
    twiml.say({ voice: "alice", language: "de-DE" }, text);
  }

  twiml.gather({
    input: ["speech"],
    action: actionUrl,
    method: "POST",
    language: "de-DE",
    speechTimeout: "auto",
    timeout: 8,
    actionOnEmptyResult: true,
    hints: "ja, nein, gerne, einen Moment, ich verbinde, kein Interesse, kein Bedarf",
  });

  // Fallback: Twilio re-sends to same URL if no speech captured
  twiml.redirect({ method: "POST" }, actionUrl);

  return new NextResponse(twiml.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function respondWithHangup(
  twiml: twilio.twiml.VoiceResponse,
  baseUrl: string,
  text: string,
): NextResponse {
  if (isElevenLabsConfigured()) {
    twiml.play(buildAudioUrl(baseUrl, text));
  } else {
    twiml.say({ voice: "alice", language: "de-DE" }, text);
  }
  twiml.hangup();
  return new NextResponse(twiml.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

// ─── State helpers ────────────────────────────────────────────────────────────
function buildInitialState(params: {
  callSid: string;
  company: string;
  contactName: string;
  topic: Topic;
  leadId?: string;
}): TokenizedCallState {
  const now = Math.floor(Date.now() / 1000);
  return {
    callSid: params.callSid,
    company: params.company,
    contactName: params.contactName,
    topic: params.topic,
    leadId: params.leadId,
    step: "conversation",
    consent: "no",
    turn: 0,
    transcript: "",
    contactRole: "gatekeeper", // safe default; OpenAI will correct if decision-maker
    issuedAt: now,
    expiresAt: now + 7200,
  };
}

function trimTranscript(text: string, maxLen = 3500): string {
  if (text.length <= maxLen) return text;
  const lines = text.split("\n");
  while (text.length > maxLen && lines.length > 4) {
    lines.splice(1, 2);
    text = lines.join("\n");
  }
  return text;
}

function toStatePayload(state: TokenizedCallState): StatePayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { issuedAt: _a, expiresAt: _b, ...rest } = state;
  return rest;
}

// ─── Report storage ───────────────────────────────────────────────────────────
async function finalizeCall(
  state: TokenizedCallState,
  outcome: ReportOutcome,
  note: string,
): Promise<void> {
  const summary = note
    ? `${state.transcript}\n\n--- Terminnotiz ---\n${note}`
    : state.transcript;
  try {
    const report = await storeCallReport({
      callSid: state.callSid,
      leadId: state.leadId,
      company: state.company,
      contactName: state.contactName,
      topic: state.topic as Topic,
      summary,
      outcome,
      appointmentAt: undefined,
      recordingConsent: state.consent === "yes",
      attempts: 1,
    });
    if (report) {
      await sendReportEmail(report).catch(() => {
        /* non-critical */
      });
    }
  } catch {
    /* storage failure must not crash the call */
  }
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function POST(request: Request): Promise<NextResponse> {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getAppBaseUrl(request);

  try {
    const url = new URL(request.url);
    const form = await request.formData();
    const tokenFromQuery = url.searchParams.get("state") || "";
    const tokenFromForm = String(form.get("state") || "").trim();
    const speech = String(form.get("SpeechResult") || "").trim();
    const digits = String(form.get("Digits") || "").trim();
    const callSid = String(form.get("CallSid") || "").trim();
    const isFallback = url.searchParams.get("fallback") === "1";

    // Restore persisted state or create fresh initial state for turn 0
    const tokenState = decodeCallStateToken(tokenFromForm || tokenFromQuery, callSid);
    const state: TokenizedCallState = tokenState ?? buildInitialState({
      callSid,
      company: url.searchParams.get("company") || "Ihr Unternehmen",
      contactName: url.searchParams.get("contactName") || "",
      topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
      leadId: url.searchParams.get("leadId") || undefined,
    });

    const heardText = speech || digits;

    // ── Safety: absolute turn limit ────────────────────────────────────────────
    if (state.turn >= MAX_TURNS) {
      await finalizeCall(state, "Kein Kontakt", "Maximale Gesprächsrunden erreicht.");
      return respondWithHangup(
        twiml,
        baseUrl,
        "Ich bedanke mich für Ihre Zeit und melde mich zu einem anderen Zeitpunkt. Auf Wiederhören.",
      );
    }

    // ── Load admin script for this topic ──────────────────────────────────────
    const dashboardData = await getDashboardData();
    const activeScript: ScriptConfig =
      dashboardData.scripts.find((s) => s.topic === state.topic) ?? {
        id: "fallback",
        topic: state.topic,
        opener:
          "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.",
        discovery: "Darf ich kurz erklären, worum es geht?",
        objectionHandling: "Ich verstehe Ihre Bedenken.",
        close: "Wann würde ein kurzer Termin passen?",
      };

    const systemPrompt = buildCallSystemPrompt(activeScript);

    // ── No speech / timeout fallback ──────────────────────────────────────────
    if (!heardText || isFallback) {
      const introLine =
        state.turn === 0
          ? "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe im Auftrag von Herrn Matthias Duic an."
          : "Entschuldigung, ich habe Sie leider nicht verstanden. Sind Sie noch da?";

      return respondWithGather(twiml, baseUrl, introLine, {
        ...toStatePayload(state),
        turn: state.turn + 1,
        transcript: trimTranscript(`${state.transcript}\nGloria: ${introLine}`),
      });
    }

    // ── Detect recording consent from speech after Gloria asked ───────────────
    let updatedConsent = state.consent;
    {
      const lastGloria = state.transcript
        .split("\n")
        .reverse()
        .find((l) => l.startsWith("Gloria:"));
      if (lastGloria && /aufzeichn|aufnahme|mitschnitt/.test(lastGloria.toLowerCase())) {
        const s = heardText.toLowerCase();
        if (/\bja\b|\bgerne\b|\bokay\b|\beinverstanden\b|\bnatürlich\b/.test(s)) {
          updatedConsent = "yes";
        } else if (/\bnein\b|\blieber nicht\b|\bkein\b|\bohne\b/.test(s)) {
          updatedConsent = "no";
        }
      }
    }

    // ── Ask OpenAI ────────────────────────────────────────────────────────────
    const decision = await askOpenAI(
      systemPrompt,
      state.transcript,
      heardText,
      state.contactRole as ContactRole,
    ).catch(
      (): GloriaDecision => ({
        detectedRole: "unknown",
        reply:
          "Entschuldigung, ich hatte kurz eine technische Unterbrechung. Ich bin gleich wieder für Sie da.",
        action: "continue",
        appointmentNote: "",
        consentGiven: null,
      }),
    );

    // Override consent if OpenAI confirmed it explicitly
    if (decision.consentGiven === true) updatedConsent = "yes";
    if (decision.consentGiven === false) updatedConsent = "no";

    // Once identified as decision-maker, never downgrade back to gatekeeper
    const newRole: ContactRole =
      state.contactRole === "decision-maker"
        ? "decision-maker"
        : decision.detectedRole === "decision-maker"
          ? "decision-maker"
          : "gatekeeper";

    const updatedTranscript = trimTranscript(
      [state.transcript, `Angerufener: ${heardText}`, `Gloria: ${decision.reply}`]
        .filter(Boolean)
        .join("\n"),
    );

    // ── End call ──────────────────────────────────────────────────────────────
    if (decision.action !== "continue") {
      const outcome: ReportOutcome =
        decision.action === "end_success"
          ? "Termin"
          : decision.action === "end_callback"
            ? "Wiedervorlage"
            : "Absage";

      await finalizeCall(
        {
          ...state,
          consent: updatedConsent,
          contactRole: newRole,
          transcript: updatedTranscript,
          turn: state.turn + 1,
          step: "finished",
        },
        outcome,
        decision.appointmentNote,
      );
      return respondWithHangup(twiml, baseUrl, decision.reply);
    }

    // ── Continue conversation ─────────────────────────────────────────────────
    return respondWithGather(twiml, baseUrl, decision.reply, {
      ...toStatePayload(state),
      consent: updatedConsent,
      contactRole: newRole,
      transcript: updatedTranscript,
      turn: state.turn + 1,
      step: "conversation",
    });
  } catch (error) {
    console.error("[gloria/process] Unhandled error:", error);
    twiml.say(
      { voice: "alice", language: "de-DE" },
      "Entschuldigung, es ist ein technischer Fehler aufgetreten. Ich melde mich nochmals.",
    );
    twiml.hangup();
    return new NextResponse(twiml.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }
}

// GET is used when Twilio follows a redirect within an ongoing call
export async function GET(request: Request): Promise<NextResponse> {
  return POST(request);
}
