import { NextResponse } from "next/server";
import {
  getAppBaseUrl,
  getTwilioCallerIds,
  getTwilioConversationMode,
  getTwilioMediaStreamUrl,
} from "@/lib/twilio";
import { encodeCallStateToken } from "@/lib/call-state-token";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { prepareCall } from "@/lib/telephony-runtime";
import { TOPICS, type Topic } from "@/lib/types";
import { buildConnectStreamTwiml, buildDialTwiml, buildGatherTwiml, buildSayHangupTwiml } from "@/lib/twiml";

export const runtime = "edge";

const GATHER_HINTS =
  "zuständig, richtige Ansprechperson, worum geht es, ja bitte, einen Moment";
const WAIT_PROMPT = "Bitte einen kleinen Moment, die Verbindung wird hergestellt.";
const INITIAL_GATHER_TIMEOUT_SECONDS = Math.min(
  6,
  Math.max(1, Number.parseInt(process.env.TWILIO_INITIAL_GATHER_TIMEOUT_SECONDS || "1", 10)),
);
const INBOUND_FORWARD_TIMEOUT_SECONDS = Math.min(
  45,
  Math.max(8, Number.parseInt(process.env.TWILIO_INBOUND_FORWARD_TIMEOUT_SECONDS || "20", 10)),
);
const TWILIO_SPEECH_MODEL = process.env.TWILIO_SPEECH_MODEL?.trim() || "phone_call";
const TWILIO_PROFANITY_FILTER =
  (process.env.TWILIO_PROFANITY_FILTER?.trim() || "false").toLowerCase() === "true";

function getContext(request: Request) {
  const url = new URL(request.url);

  return {
    userId: url.searchParams.get("userId") || undefined,
    phoneNumberId: url.searchParams.get("phoneNumberId") || undefined,
    ownerRealName: url.searchParams.get("ownerRealName") || undefined,
    ownerCompanyName: url.searchParams.get("ownerCompanyName") || undefined,
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Ihr Unternehmen",
    contactName: url.searchParams.get("contactName") || "",
    topic: url.searchParams.get("topic") || "betriebliche Krankenversicherung",
    rtSessionId: url.searchParams.get("rtSessionId") || undefined,
    rtProfileKey: url.searchParams.get("rtProfileKey") || undefined,
  };
}

function normalizeTopic(value: string): Topic {
  const found = TOPICS.find((topic) => topic === value);
  return found || TOPICS[0];
}

function buildAudioUrl(baseUrl: string, text: string): string {
  const u = new URL(`${baseUrl}/api/twilio/audio`);
  u.searchParams.set("text", text);
  return u.toString();
}

function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();
  const token = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (username && password) {
    headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  if (token) {
    headers["x-gloria-internal-token"] = token;
  }

  return headers;
}

async function getIncomingTwilioForm(request: Request): Promise<{
  from?: string;
  to?: string;
  callSid?: string;
}> {
  const requestUrl = new URL(request.url);

  const fromFromQuery =
    String(requestUrl.searchParams.get("From") || requestUrl.searchParams.get("from") || "").trim() ||
    undefined;
  const toFromQuery =
    String(requestUrl.searchParams.get("To") || requestUrl.searchParams.get("to") || "").trim() ||
    undefined;
  const callSidFromQuery =
    String(requestUrl.searchParams.get("CallSid") || requestUrl.searchParams.get("callSid") || "").trim() ||
    undefined;

  if (request.method !== "POST") {
    return {
      from: fromFromQuery,
      to: toFromQuery,
      callSid: callSidFromQuery,
    };
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) {
    return {
      from: fromFromQuery,
      to: toFromQuery,
      callSid: callSidFromQuery,
    };
  }

  try {
    const form = await request.clone().formData();
    return {
      from: String(form.get("From") || "").trim() || fromFromQuery,
      to: String(form.get("To") || "").trim() || toFromQuery,
      callSid: String(form.get("CallSid") || "").trim() || callSidFromQuery,
    };
  } catch {
    return {
      from: fromFromQuery,
      to: toFromQuery,
      callSid: callSidFromQuery,
    };
  }
}

function normalizePhoneForMatch(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");

  if (!digits) {
    return "";
  }

  return plus ? `+${digits}` : digits;
}

function phoneMatches(leftRaw: string | undefined, rightRaw: string | undefined): boolean {
  const left = normalizePhoneForMatch(leftRaw);
  const right = normalizePhoneForMatch(rightRaw);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftDigits = left.replace(/^\+/, "");
  const rightDigits = right.replace(/^\+/, "");

  return leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits);
}

async function lookupInboundLead(baseUrl: string, from: string): Promise<
  | {
      id: string;
      company: string;
      contactName?: string;
      topic: Topic;
      directDial?: string;
      phone?: string;
    }
  | undefined
> {
  try {
    const internalHeaders = buildInternalHeaders();
    const response = await fetch(
      `${baseUrl}/api/twilio/inbound/lookup?from=${encodeURIComponent(from)}`,
      {
        method: "GET",
        headers: internalHeaders,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      found?: boolean;
      lead?: {
        id: string;
        company: string;
        contactName?: string;
        topic: Topic;
        directDial?: string;
        phone?: string;
      };
    };

    if (!payload.found || !payload.lead) {
      return undefined;
    }

    return payload.lead;
  } catch {
    return undefined;
  }
}

async function renderVoiceResponse(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const context = getContext(request);
  const incomingUrl = new URL(request.url);
  const incomingForm = await getIncomingTwilioForm(request);
  const twilioNumbers = getTwilioCallerIds();
  const toIsTwilioNumber = twilioNumbers.some((number) => phoneMatches(incomingForm.to, number));
  const fromIsTwilioNumber = twilioNumbers.some((number) => phoneMatches(incomingForm.from, number));
  const isInboundCallback = Boolean(
    incomingForm.from &&
      incomingForm.to &&
      toIsTwilioNumber &&
      !fromIsTwilioNumber,
  );
  const isPrepared = incomingUrl.searchParams.get("prepared") === "1";
  const mode = getTwilioConversationMode();
  const streamUrl = getTwilioMediaStreamUrl();

  if (isInboundCallback && incomingForm.from) {
    const matchedLead = await lookupInboundLead(baseUrl, incomingForm.from);

    if (matchedLead) {
      const callbackGreeting =
        "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich danke Ihnen für Ihren Rückruf. Darf ich kurz mit Ihnen die Terminvereinbarung abstimmen?";

      const token = await encodeCallStateToken({
        callSid: incomingForm.callSid,
        userId: incomingUrl.searchParams.get("userId") || undefined,
        phoneNumberId: incomingUrl.searchParams.get("phoneNumberId") || undefined,
        ownerRealName: incomingUrl.searchParams.get("ownerRealName") || undefined,
        ownerCompanyName: incomingUrl.searchParams.get("ownerCompanyName") || undefined,
        leadId: matchedLead.id,
        company: matchedLead.company,
        contactName: matchedLead.contactName,
        directDial: matchedLead.directDial || matchedLead.phone,
        decisionMakerIntroDone: true,
        scriptPhaseIndex: 0,
        scriptSegmentIndex: 0,
        healthQuestionIndex: 0,
        pkvHealthIntroDone: false,
        appointmentAtDraft: undefined,
        appointmentNoteDraft: undefined,
        appointmentProposalAsked: false,
        appointmentPreference: "any",
        appointmentOptionAAt: undefined,
        appointmentOptionBAt: undefined,
        topic: matchedLead.topic,
        step: "intro",
        consent: "no",
        consentAsked: false,
        turn: 1,
        transcript: `Gloria: ${callbackGreeting}`,
        contactRole: "decision-maker",
        roleState: "decision_maker",
      });

      const actionUrl = `${baseUrl}/api/twilio/voice/process?state=${encodeURIComponent(token)}`;

      const twiml = buildGatherTwiml({
        ...(isElevenLabsConfigured()
          ? { playUrl: buildAudioUrl(baseUrl, callbackGreeting) }
          : { sayText: callbackGreeting }),
        gather: {
          input: "speech",
          action: actionUrl,
          method: "POST",
          language: "de-DE",
          speechModel: TWILIO_SPEECH_MODEL,
          profanityFilter: TWILIO_PROFANITY_FILTER,
          speechTimeout: "auto",
          timeout: INITIAL_GATHER_TIMEOUT_SECONDS,
          actionOnEmptyResult: true,
          hints: "ja, nein, termin, rueckruf, guten tag, hier spricht, ich bin dran, einverstanden",
        },
        redirectUrl: actionUrl,
        redirectMethod: "POST",
      });

      return new NextResponse(twiml, {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const forwardTo = process.env.TWILIO_INBOUND_FORWARD_TO?.trim();

    if (forwardTo) {
      const twiml = buildDialTwiml({
        sayText: "Vielen Dank für Ihren Rückruf. Ich verbinde Sie jetzt mit dem zuständigen Ansprechpartner.",
        number: forwardTo,
        timeout: INBOUND_FORWARD_TIMEOUT_SECONDS,
      });

      return new NextResponse(twiml, {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    return new NextResponse(
      buildSayHangupTwiml({
        sayText: "Vielen Dank für Ihren Rückruf. Aktuell ist kein Ansprechpartner verfügbar. Wir melden uns zeitnah bei Ihnen.",
      }),
      {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      },
    );
  }

  // Fast start path: answer immediately and hand audio off to realtime WebSocket.
  if (streamUrl && mode !== "guided" && isPrepared) {
    const twiml = buildConnectStreamTwiml({
      streamUrl,
      parameters: {
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        rtSessionId: context.rtSessionId,
        rtProfileKey: context.rtProfileKey,
      },
      waitPrompt: WAIT_PROMPT,
    });

    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  if (!isPrepared) {
    void prepareCall({
      topic: normalizeTopic(context.topic),
      userId: context.userId,
      baseUrl,
      request,
    });
  }

  const processAction = `${baseUrl}/api/twilio/voice/process?step=intro&userId=${encodeURIComponent(context.userId || "")}&phoneNumberId=${encodeURIComponent(context.phoneNumberId || "")}&ownerRealName=${encodeURIComponent(context.ownerRealName || "")}&ownerCompanyName=${encodeURIComponent(context.ownerCompanyName || "")}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`;
  const fallbackAction = `${baseUrl}/api/twilio/voice/process?step=intro&fallback=1&userId=${encodeURIComponent(context.userId || "")}&phoneNumberId=${encodeURIComponent(context.phoneNumberId || "")}&ownerRealName=${encodeURIComponent(context.ownerRealName || "")}&ownerCompanyName=${encodeURIComponent(context.ownerCompanyName || "")}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`;

  const twiml = buildGatherTwiml({
    gather: {
      input: "speech dtmf",
      numDigits: 1,
      action: processAction,
      method: "POST",
      language: "de-DE",
      speechModel: TWILIO_SPEECH_MODEL,
      profanityFilter: TWILIO_PROFANITY_FILTER,
      speechTimeout: "auto",
      timeout: INITIAL_GATHER_TIMEOUT_SECONDS,
      actionOnEmptyResult: true,
      hints: GATHER_HINTS,
    },
    redirectUrl: fallbackAction,
    redirectMethod: "POST",
  });

  return new NextResponse(twiml, {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  return await renderVoiceResponse(request);
}

export async function POST(request: Request) {
  return await renderVoiceResponse(request);
}
