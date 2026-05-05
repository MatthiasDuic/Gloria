import { NextResponse } from "next/server";
import {
  getAppBaseUrl,
  getTwilioCallerIds,
} from "@/lib/twilio";
import { encodeCallStateToken } from "@/lib/call-state-token";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { prepareCall } from "@/lib/telephony-runtime";
import { TOPICS, type Topic } from "@/lib/types";
import { buildDialTwiml, buildGatherTwiml, buildSayHangupTwiml, buildConnectStreamTwiml } from "@/lib/twiml";
import { buildSignedAudioUrl } from "@/lib/audio-url";
import { validateTwilioRequest } from "@/lib/twilio-signature";
import { log } from "@/lib/log";
import { buildInternalHeaders } from "@/lib/internal-auth";
import { normalizePhoneForMatch, phoneMatches } from "@/lib/phone-utils";

export const runtime = "edge";

const GATHER_HINTS =
  "zuständig, richtige Ansprechperson, worum geht es, ja bitte, einen Moment";
const INITIAL_GATHER_TIMEOUT_SECONDS = Math.min(
  10,
  Math.max(1, Number.parseInt(process.env.TWILIO_INITIAL_GATHER_TIMEOUT_SECONDS || "6", 10)),
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
    ownerGesellschaft: url.searchParams.get("ownerGesellschaft") || undefined,
    voiceId: url.searchParams.get("voiceId") || undefined,
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Ihr Unternehmen",
    contactName: url.searchParams.get("contactName") || "",
    topic: url.searchParams.get("topic") || "betriebliche Krankenversicherung",
    rtProfileKey: url.searchParams.get("rtProfileKey") || undefined,
    previousSummary: url.searchParams.get("previousSummary") || undefined,
    isCallback: url.searchParams.get("isCallback") === "1",
  };
}

function normalizeTopic(value: string): Topic {
  const found = TOPICS.find((topic) => topic === value);
  return found || TOPICS[0];
}

// Audio-URL wird zentral und signiert in @/lib/audio-url gebaut.

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
        ownerGesellschaft: incomingUrl.searchParams.get("ownerGesellschaft") || undefined,
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
          ? { playUrl: await buildSignedAudioUrl(baseUrl, callbackGreeting) }
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

  // Gloria spricht ausschließlich über ElevenLabs TTS über das Gather/Play-
  // Playbook unten. Der OpenAI Realtime-Streaming-Pfad ist bewusst entfernt.

  if (!isPrepared) {
    void prepareCall({
      topic: normalizeTopic(context.topic),
      userId: context.userId,
      baseUrl,
      request,
    });
  }

  // --- Media Streams (Render worker) ---------------------------------------
  // Wenn USE_MEDIA_STREAMS=1 und MEDIA_STREAM_WSS_URL konfiguriert ist, übergeben
  // wir den Audio-Pfad an den externen Worker (Deepgram + GPT-4o + ElevenLabs).
  // Die alte Gather/Play-Pipeline bleibt als Fallback bestehen.
  const useMediaStreams =
    (process.env.USE_MEDIA_STREAMS || "").trim() === "1" &&
    Boolean(process.env.MEDIA_STREAM_WSS_URL?.trim());

  if (useMediaStreams) {
    const streamUrl = process.env.MEDIA_STREAM_WSS_URL!.trim();
    const twiml = buildConnectStreamTwiml({
      streamUrl,
      parameters: {
        userId: context.userId,
        phoneNumberId: context.phoneNumberId,
        ownerRealName: context.ownerRealName,
        ownerCompanyName: context.ownerCompanyName,
        ownerGesellschaft: context.ownerGesellschaft,
        voiceId: context.voiceId,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        previousSummary: context.previousSummary,
        isCallback: context.isCallback ? "1" : undefined,
      },
    });

    return new NextResponse(twiml, {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }
  // --------------------------------------------------------------------------

  const processAction = `${baseUrl}/api/twilio/voice/process?step=intro&userId=${encodeURIComponent(context.userId || "")}&phoneNumberId=${encodeURIComponent(context.phoneNumberId || "")}&ownerRealName=${encodeURIComponent(context.ownerRealName || "")}&ownerCompanyName=${encodeURIComponent(context.ownerCompanyName || "")}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`;
  const fallbackAction = `${baseUrl}/api/twilio/voice/process?step=intro&fallback=1&userId=${encodeURIComponent(context.userId || "")}&phoneNumberId=${encodeURIComponent(context.phoneNumberId || "")}&ownerRealName=${encodeURIComponent(context.ownerRealName || "")}&ownerCompanyName=${encodeURIComponent(context.ownerCompanyName || "")}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName)}&topic=${encodeURIComponent(context.topic)}`;

  // Gloria bleibt zunächst stumm: Der Angerufene soll sich zuerst melden
  // ("Guten Tag, Praxis Dr. Müller" / "Müller, hallo"). Erst anhand dieser
  // Begrüßung entscheidet /api/twilio/voice/process deterministisch, ob
  // Gloria den Empfangs-Opener (Weiterleitung erbitten) oder den
  // Entscheider-Opener (direkte Ansprache + Konsens) spricht.
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
  const signature = await validateTwilioRequest(request);
  if (!signature.ok) {
    log.warn("twilio.signature_rejected", { event: "voice", reason: signature.reason });
    return new NextResponse(
      buildSayHangupTwiml({ sayText: "Diese Anfrage konnte nicht verifiziert werden." }),
      { status: 403, headers: { "Content-Type": "text/xml; charset=utf-8" } },
    );
  }
  return await renderVoiceResponse(request);
}

export async function POST(request: Request) {
  const signature = await validateTwilioRequest(request);
  if (!signature.ok) {
    log.warn("twilio.signature_rejected", { event: "voice", reason: signature.reason });
    return new NextResponse(
      buildSayHangupTwiml({ sayText: "Diese Anfrage konnte nicht verifiziert werden." }),
      { status: 403, headers: { "Content-Type": "text/xml; charset=utf-8" } },
    );
  }
  return await renderVoiceResponse(request);
}
