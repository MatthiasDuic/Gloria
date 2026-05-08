/**
 * sipgate.io inbound voice webhook.
 *
 * sipgate ruft diese URL an, sobald ein Gespräch auf einer konfigurierten
 * Rufnummer eingeht (oder wenn die ausgehende Verbindung angenommen wird).
 *
 * sipgate schickt ein application/x-www-form-urlencoded POST mit mindestens:
 *   from, to, callId, direction (in|out), event (newCall)
 *
 * Wir antworten mit sipgate-XML:
 *   1. Begrüßungs-MP3 (<Play>)
 *   2. <Record> mit actionUrl → /api/sipgate/respond
 */

import { NextResponse } from "next/server";
import { getAppBaseUrl } from "@/lib/twilio";
import { buildSipgateRecordXml, buildSipgateHangupXml } from "@/lib/sipgate";
import { encodeCallStateToken } from "@/lib/call-state-token";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { buildSignedAudioUrl } from "@/lib/audio-url";
import { TOPICS, type Topic } from "@/lib/types";
import { buildInternalHeaders } from "@/lib/internal-auth";
import { log } from "@/lib/log";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Shared secret auth (sipgate does not sign webhooks with HMAC)
// ---------------------------------------------------------------------------
function verifyWebhookSecret(request: Request): boolean {
  const expected = process.env.SIPGATE_WEBHOOK_SECRET?.trim();
  if (!expected) {
    // No secret configured – allow all (only safe in dev / behind IP restriction)
    return true;
  }
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret") || "";
  return provided === expected;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeTopic(value: string | null | undefined): Topic {
  const found = TOPICS.find((t) => t === value);
  return found || TOPICS[0];
}

function getContext(request: Request) {
  const url = new URL(request.url);
  const sp = url.searchParams;
  return {
    userId: sp.get("userId") || undefined,
    phoneNumberId: sp.get("phoneNumberId") || undefined,
    ownerRealName: sp.get("ownerRealName") || undefined,
    ownerCompanyName: sp.get("ownerCompanyName") || undefined,
    ownerGesellschaft: sp.get("ownerGesellschaft") || undefined,
    voiceId: sp.get("voiceId") || undefined,
    leadId: sp.get("leadId") || undefined,
    company: sp.get("company") || "Ihr Unternehmen",
    contactName: sp.get("contactName") || "",
    topic: normalizeTopic(sp.get("topic")),
    previousSummary: sp.get("previousSummary") || undefined,
    isCallback: sp.get("isCallback") === "1",
  };
}

async function parseSipgateForm(request: Request): Promise<Record<string, string>> {
  try {
    const form = await request.clone().formData();
    const result: Record<string, string> = {};
    for (const [key, value] of form.entries()) {
      result[key] = String(value);
    }
    return result;
  } catch {
    return {};
  }
}

/** Look up lead info by inbound caller number */
async function lookupInboundLead(
  baseUrl: string,
  from: string,
): Promise<
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
    const response = await fetch(
      `${baseUrl}/api/twilio/inbound/lookup?from=${encodeURIComponent(from)}`,
      {
        method: "GET",
        headers: buildInternalHeaders(),
        cache: "no-store",
      },
    );
    if (!response.ok) return undefined;
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
    if (!payload.found || !payload.lead) return undefined;
    return payload.lead;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  if (!verifyWebhookSecret(request)) {
    log.warn("sipgate.voice.secret_mismatch");
    return new NextResponse(buildSipgateHangupXml(), {
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
  }

  const form = await parseSipgateForm(request);
  const callId = form.callId || form.xmlCallId || "";
  const from = form.from || "";
  const to = form.to || "";
  const direction = form.direction || "in";

  log.info("sipgate.voice.incoming", { callId, from, to, direction });

  const baseUrl = getAppBaseUrl(request);
  const context = getContext(request);

  // For inbound calls without context params, try to look up the lead
  let resolvedContext = { ...context };
  if (!context.leadId && from && direction === "in") {
    const lead = await lookupInboundLead(baseUrl, from);
    if (lead) {
      resolvedContext = {
        ...resolvedContext,
        leadId: lead.id,
        company: lead.company,
        contactName: lead.contactName || "",
        topic: lead.topic,
      };
    }
  }

  // Build intro greeting text
  const { company, contactName, topic, previousSummary, isCallback } = resolvedContext;
  let greetingText: string;
  if (isCallback) {
    greetingText =
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich danke Ihnen für Ihren Rückruf. Darf ich kurz mit Ihnen die Terminvereinbarung abstimmen?";
  } else if (previousSummary) {
    greetingText = `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich melde mich kurz bezüglich unseres letzten Gesprächs. ${previousSummary} Haben Sie gerade einen Moment?`;
  } else if (contactName) {
    greetingText = `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich habe eine kurze fachliche Rückfrage für ${contactName}. Würden Sie mich bitte kurz dorthin verbinden?`;
  } else {
    greetingText = `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel. Ich rufe wegen ${topic} an. Bin ich damit bei der richtigen Ansprechperson?`;
  }

  // Encode initial call state into a token
  const callStateToken = await encodeCallStateToken({
    callSid: callId,
    userId: resolvedContext.userId,
    phoneNumberId: resolvedContext.phoneNumberId,
    ownerRealName: resolvedContext.ownerRealName,
    ownerCompanyName: resolvedContext.ownerCompanyName,
    ownerGesellschaft: resolvedContext.ownerGesellschaft,
    leadId: resolvedContext.leadId,
    company,
    contactName: contactName || undefined,
    topic,
    step: "intro",
    consent: "no",
    consentAsked: false,
    turn: 1,
    transcript: `Gloria: ${greetingText}`,
    contactRole: "gatekeeper",
    roleState: "reception",
    decisionMakerIntroDone: false,
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
  });

  // Build the respond URL (Record action) with state token
  const secret = process.env.SIPGATE_WEBHOOK_SECRET?.trim();
  const respondUrl = new URL(`${baseUrl}/api/sipgate/respond`);
  respondUrl.searchParams.set("state", callStateToken);
  if (secret) respondUrl.searchParams.set("secret", secret);

  // Build audio URL for greeting
  let greetingAudioUrl: string | undefined;
  if (isElevenLabsConfigured()) {
    try {
      greetingAudioUrl = await buildSignedAudioUrl(baseUrl, greetingText);
    } catch (err) {
      log.warn("sipgate.voice.audio_url_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const xml = buildSipgateRecordXml({
    ...(greetingAudioUrl ? { playUrl: greetingAudioUrl } : { sayText: greetingText }),
    actionUrl: respondUrl.toString(),
    maxLength: 60,
    timeout: 6,
  });

  return new NextResponse(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}

// Allow GET for health checks / manual testing
export async function GET(request: Request) {
  if (!verifyWebhookSecret(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return new NextResponse("sipgate voice endpoint ok", { status: 200 });
}
