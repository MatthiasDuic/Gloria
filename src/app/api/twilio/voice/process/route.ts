import { NextResponse } from "next/server";
import twilio from "twilio";
import {
  BAV_TERMINIERUNG_SCRIPT,
  BKV_TERMINIERUNG_SCRIPT,
  ENERGIE_TERMINIERUNG_SCRIPT,
  GEWERBE_TERMINIERUNG_SCRIPT,
  PKV_TERMINIERUNG_SCRIPT,
} from "@/lib/call-scripts";
import type { CallScript } from "@/lib/call-scripts";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { generateAdaptiveReply } from "@/lib/live-agent";
import { sendReportEmail } from "@/lib/mailer";
import { getDashboardData, storeCallReport } from "@/lib/storage";
import {
  getAppBaseUrl,
  getTwilioConversationMode,
  getTwilioMediaStreamUrl,
} from "@/lib/twilio";
import {
  decodeCallStateToken,
  encodeCallStateToken,
  type ContactRole,
  type TokenizedCallState,
} from "@/lib/call-state-token";
import type { ReportOutcome, Topic } from "@/lib/types";

export const runtime = "nodejs";

const DETAIL_SCRIPTS: Record<Topic, CallScript> = {
  "betriebliche Krankenversicherung": BKV_TERMINIERUNG_SCRIPT,
  "betriebliche Altersvorsorge": BAV_TERMINIERUNG_SCRIPT,
  "gewerbliche Versicherungen": GEWERBE_TERMINIERUNG_SCRIPT,
  "private Krankenversicherung": PKV_TERMINIERUNG_SCRIPT,
  Energie: ENERGIE_TERMINIERUNG_SCRIPT,
};

const MAX_LIVE_TURNS = 5;
const MAX_SILENT_RETRIES = 2;

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readContext(request: Request) {
  const url = new URL(request.url);
  const contactName = url.searchParams.get("contactName") || undefined;
  const contactRoleParam = url.searchParams.get("contactRole");

  return {
    callSid: url.searchParams.get("callSid") || undefined,
    step: url.searchParams.get("step") || "intro",
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Unbekanntes Unternehmen",
    contactName,
    topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
    consent: url.searchParams.get("consent") || "no",
    turn: Number(url.searchParams.get("turn") || "0"),
    transcript: url.searchParams.get("transcript") || "",
    contactRole:
      contactRoleParam === "decision-maker"
        ? "decision-maker"
        : contactName
          ? "gatekeeper"
          : "decision-maker",
  } as const;
}

function mergeContextWithToken(
  baseContext: ReturnType<typeof readContext>,
  tokenState?: TokenizedCallState,
) {
  if (!tokenState) {
    return baseContext;
  }

  return {
    ...baseContext,
    callSid: tokenState.callSid || baseContext.callSid,
    leadId: tokenState.leadId || baseContext.leadId,
    company: tokenState.company || baseContext.company,
    contactName: tokenState.contactName || baseContext.contactName,
    topic: tokenState.topic || baseContext.topic,
    step: tokenState.step || baseContext.step,
    consent: tokenState.consent || baseContext.consent,
    turn: Number.isFinite(tokenState.turn) ? tokenState.turn : baseContext.turn,
    transcript: tokenState.transcript || baseContext.transcript,
    contactRole: tokenState.contactRole || baseContext.contactRole,
  } as const;
}

function buildTopicIntro(topic: Topic) {
  if (topic === "betriebliche Altersvorsorge") {
    return "Es geht um einen kurzen Abgleich, wie sich die betriebliche Altersvorsorge für Mitarbeitende verständlich und attraktiv aufstellen lässt.";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Es geht um einen kurzen Vergleich Ihrer gewerblichen Absicherung auf Preis, Leistung und mögliche Lücken.";
  }

  if (topic === "private Krankenversicherung") {
    return "Es geht um eine ruhige Einordnung, wie sich Krankenversicherungsbeiträge im Alter besser planen lassen.";
  }

  if (topic === "Energie") {
    return "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich mit möglichem Einsparpotenzial.";
  }

  return "Es geht um die betriebliche Krankenversicherung als attraktiven Benefit für Mitarbeitende.";
}

function cleanScriptText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fillNameTemplate(value: string, contactName?: string) {
  const fallbackName = contactName?.trim() || "der zuständigen Person";

  return cleanScriptText(value)
    .replaceAll("Frau/Herrn [NAME]", fallbackName)
    .replaceAll("Frau/Herr [NAME]", fallbackName)
    .replaceAll("Herr/Frau [NAME]", fallbackName)
    .replaceAll("[NAME]", fallbackName);
}

function mentionsTargetName(text: string, contactName?: string) {
  if (!contactName?.trim()) {
    return false;
  }

  const normalizedText = normalizeName(text);
  const nameParts = normalizeName(contactName)
    .split(" ")
    .filter((part) => part.length > 2 && part !== "herr" && part !== "frau");

  return nameParts.some((part) => normalizedText.includes(part));
}

function mentionsDifferentNamedPerson(text: string, contactName?: string) {
  if (!contactName?.trim() || mentionsTargetName(text, contactName)) {
    return false;
  }

  const normalizedText = normalizeName(text);
  return /(^|\s)(herr|frau)\s+[a-z0-9]+|[a-z0-9]+\s+am apparat|[a-z0-9]+\s+guten tag/.test(
    normalizedText,
  );
}

function buildReceptionPrompt(
  topic: Topic,
  contactName?: string,
  variant: "intro" | "what" | "email" | "email-insist" = "intro",
) {
  const script = DETAIL_SCRIPTS[topic];

  if (variant === "what") {
    return fillNameTemplate(
      script.reception.ifAskedWhatTopic || script.reception.alternativeShort || script.reception.intro,
      contactName,
    );
  }

  if (variant === "email") {
    return fillNameTemplate(
      script.reception.ifEmailSuggested || script.reception.alternativeShort || script.reception.intro,
      contactName,
    );
  }

  if (variant === "email-insist") {
    return fillNameTemplate(
      script.reception.ifEmailInsisted || script.reception.ifEmailSuggested || script.reception.intro,
      contactName,
    );
  }

  return fillNameTemplate(script.reception.intro, contactName);
}

function buildDecisionMakerHello(contactName?: string) {
  if (contactName?.trim()) {
    return `Guten Tag ${contactName}, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel im Auftrag von Matthias Duic.`;
  }

  return "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel im Auftrag von Matthias Duic.";
}

function buildDecisionMakerPrompt(topic: Topic, contactName?: string) {
  if (contactName?.trim()) {
    return `${buildDecisionMakerHello(contactName)} Spreche ich direkt mit Ihnen persönlich?`;
  }

  return `${buildDecisionMakerHello(contactName)} ${buildTopicIntro(topic)} Sind Sie dafür die richtige Ansprechperson?`;
}

function buildDecisionMakerGreeting(topic: Topic, contactName?: string) {
  const script = DETAIL_SCRIPTS[topic];
  return fillNameTemplate(script.intro.text, contactName);
}

function soundsLikeTransfer(text: string) {
  return /ich verbinde|verbinde sie|stelle.*durch|einen moment|augenblick|ich hole|bleiben sie dran|ich leite.*weiter/.test(text);
}

function soundsLikeNotDecisionMaker(text: string) {
  return /nicht zuständig|bin ich nicht|dafür ist .* zuständig|sekretariat|empfang|zentrale|assistenz|büro|nicht da|außer haus|weiterleiten/.test(text);
}

function soundsLikeDecisionMaker(text: string) {
  return /ich bin zuständig|das bin ich|ja,? ich bin|da sprechen sie richtig|das passt|ich kümmere mich|dafür bin ich zuständig|am apparat|spreche selbst/.test(text);
}

function isLikelyGreeting(text: string) {
  if (soundsLikeDecisionMaker(text) || soundsLikeNotDecisionMaker(text) || soundsLikeTransfer(text)) {
    return false;
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3 || /hallo|guten tag|ja bitte|wer ist da|moin/.test(text);
}

function detectConsent(speech: string, digits: string) {
  if (digits === "1") {
    return true;
  }

  if (digits === "2") {
    return false;
  }

  if (/(^|\b)(ja|gern|gerne|okay|in ordnung|einverstanden)(\b|$)/.test(speech)) {
    return true;
  }

  if (/(^|\b)(nein|nicht|keine aufzeichnung|ohne aufzeichnung)(\b|$)/.test(speech)) {
    return false;
  }

  return null;
}

function isCallbackRequest(speech: string) {
  return /(später|andermal|nächste woche|rückruf|rufen sie wieder an|kein[e]? zeit|im moment schlecht|gerade schlecht|heute nicht|morgen|bitte später|nochmal anrufen)/.test(
    speech,
  );
}

function isAppointmentAcceptance(
  speech: string,
  stage: "discovery" | "problem" | "benefit" | "objection" | "closing" = "discovery",
) {
  if (/termin|machen wir|passt .*vormittag|passt .*nachmittag|einverstanden mit termin|gerne termin/.test(speech)) {
    return true;
  }

  if (
    stage === "closing" &&
    /(^|\b)(ja|ja gern|ja gerne|gern|gerne|okay|ok|einverstanden|passt|passt gut|ja passt|machen wir)(\b|$)/.test(
      speech.trim(),
    )
  ) {
    return true;
  }

  return false;
}

function classifyOutcome(
  speech: string,
  stage: "discovery" | "problem" | "benefit" | "objection" | "closing" = "discovery",
): ReportOutcome {
  if (/(kein interesse|nicht interessant|bitte nicht|nein danke|keinen bedarf|kein bedarf)/.test(speech)) {
    return "Absage";
  }

  if (isCallbackRequest(speech)) {
    return "Wiedervorlage";
  }

  if (isAppointmentAcceptance(speech, stage)) {
    return "Termin";
  }

  return "Kein Kontakt";
}

function buildFollowUpDate(speech: string, outcome: ReportOutcome) {
  const now = new Date();
  const result = new Date(now);
  const wantsNextWeek = /nächste woche/.test(speech);
  result.setDate(now.getDate() + (wantsNextWeek ? 7 : 2));
  result.setHours(
    outcome === "Termin" ? (/nachmittag|14|15|16/.test(speech) ? 14 : 10) : 11,
    0,
    0,
    0,
  );
  return result.toISOString();
}

function buildAudioUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const url = new URL("/api/twilio/audio", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function buildProcessUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const url = new URL("/api/twilio/voice/process", `${baseUrl}/`);

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url.toString();
}

function trimTranscript(value: string, maxLength = 1200) {
  const normalized = value.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(normalized.length - maxLength);
}

function respondWithGather(options: {
  response: twilio.twiml.VoiceResponse;
  baseUrl: string;
  promptText: string;
  audioParams?: Record<string, string | undefined>;
  context: ReturnType<typeof readContext>;
  consent: "yes" | "no";
  turn: number;
  transcript: string;
  lowLatency?: boolean;
  step?: "intro" | "consent" | "conversation";
  contactRole?: ContactRole;
  callSid?: string;
}) {
  const nextStep = options.step || "conversation";
  const nextRole = options.contactRole || options.context.contactRole;
  const nextTranscript = trimTranscript(options.transcript);
  const nextCallSid = options.callSid || options.context.callSid;
  const stateToken = encodeCallStateToken({
    callSid: nextCallSid,
    leadId: options.context.leadId,
    company: options.context.company,
    contactName: options.context.contactName,
    topic: options.context.topic,
    step: nextStep,
    consent: options.consent,
    turn: options.turn,
    transcript: nextTranscript,
    contactRole: nextRole,
  });
  const actionUrl = buildProcessUrl(options.baseUrl, {
    callSid: nextCallSid,
    step: nextStep,
    company: options.context.company,
    contactName: options.context.contactName,
    topic: options.context.topic,
    state: stateToken,
  });

  const hints =
    nextStep === "intro"
      ? "zuständig, richtige Ansprechperson, durchstellen, worum geht es, einen Moment"
      : nextStep === "consent"
        ? "ja, nein, aufzeichnung erlaubt, ohne aufzeichnung"
        : "ja, nein, Termin, Rückruf, kein Interesse, später, nächste Woche";

  const gather = options.response.gather({
    input: ["speech", "dtmf"],
    action: actionUrl,
    method: "POST",
    language: "de-DE",
    speechTimeout: "auto",
    timeout: 4,
    actionOnEmptyResult: true,
    hints,
  });

  if (options.promptText.trim()) {
    if (isElevenLabsConfigured()) {
      gather.play(
        buildAudioUrl(options.baseUrl, {
          text: options.promptText,
          ...options.audioParams,
        }),
      );
    } else {
      gather.say({ voice: "alice", language: "de-DE" }, options.promptText);
    }
  }

  return new NextResponse(options.response.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

async function safelyStoreReport(payload: Parameters<typeof storeCallReport>[0]) {
  try {
    const report = await storeCallReport(payload);
    await sendReportEmail(report).catch(() => undefined);
    return report;
  } catch (error) {
    console.error("Twilio report could not be saved", error);
    return undefined;
  }
}

export async function POST(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const url = new URL(request.url);
  const tokenFromQuery = url.searchParams.get("state");
  const baseContext = readContext(request);
  const form = await request.formData();
  const tokenFromForm = String(form.get("state") || "").trim();
  const callSidRaw = String(form.get("CallSid") || "").trim();
  const callSid = callSidRaw || baseContext.callSid;
  const tokenState = decodeCallStateToken(tokenFromForm || tokenFromQuery, callSid);
  const context = mergeContextWithToken(baseContext, tokenState);
  const speech = normalizeText(form.get("SpeechResult"));
  const digits = normalizeText(form.get("Digits"));
  const response = new twilio.twiml.VoiceResponse();
  const dashboardData = await getDashboardData();
  const activeScript = dashboardData.scripts.find((entry) => entry.topic === context.topic);

  if (context.step === "intro") {
    const heardText = speech || digits;
    const atGatekeeper = context.contactRole === "gatekeeper";

    if (!heardText) {
      const prompt = atGatekeeper
        ? buildReceptionPrompt(context.topic, context.contactName, "intro")
        : buildDecisionMakerPrompt(context.topic, context.contactName);

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: atGatekeeper ? "gatekeeper" : "decision-maker",
      });
    }

    if (/(nicht da|außer haus|im termin|gerade nicht erreichbar|später erreichbar|morgen wieder da|heute nachmittag|heute vormittag|rufen sie.*wieder an|nochmal anrufen)/.test(heardText)) {
      const nextCallAt = buildFollowUpDate(heardText, "Wiedervorlage");

      await safelyStoreReport({
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        summary: trimTranscript(`${context.transcript}\nInteressent: ${heardText}`),
        outcome: "Wiedervorlage",
        nextCallAt,
        recordingConsent: false,
        attempts: 1,
      });

      if (isElevenLabsConfigured()) {
        response.play(buildAudioUrl(baseUrl, { step: "final", variant: "callback" }));
      } else {
        response.say(
          { voice: "alice", language: "de-DE" },
          "Vielen Dank für die Info. Ich notiere die Wiedervorlage und melde mich dann passend noch einmal.",
        );
      }

      response.hangup();

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    if (atGatekeeper) {
      if (/worum geht|was genau|um was geht/.test(heardText)) {
        const prompt = buildReceptionPrompt(context.topic, context.contactName, "what");
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "gatekeeper",
        });
      }

      if (/email|e-mail|mailen|schicken sie/.test(heardText)) {
        const prompt = buildReceptionPrompt(
          context.topic,
          context.contactName,
          /nur per mail|bitte per e-?mail|allgemeine mail/.test(heardText) ? "email-insist" : "email",
        );
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: context.turn + 1,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "gatekeeper",
        });
      }

      if (soundsLikeTransfer(heardText)) {
        const prompt = "Danke Ihnen.";
        return respondWithGather({
          response,
          baseUrl,
          promptText: prompt,
          audioParams: { text: prompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
          step: "intro",
          contactRole: "decision-maker",
          lowLatency: true,
        });
      }

      if (mentionsTargetName(heardText, context.contactName) || soundsLikeDecisionMaker(heardText)) {
        const consentPrompt =
          "Perfekt, danke Ihnen. Ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel im Auftrag von Matthias Duic. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?";

        return respondWithGather({
          response,
          baseUrl,
          promptText: consentPrompt,
          audioParams: { text: consentPrompt },
          context,
          consent: "no",
          turn: 0,
          transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
          step: "consent",
          contactRole: "decision-maker",
        });
      }

      const prompt =
        mentionsDifferentNamedPerson(heardText, context.contactName) ||
        soundsLikeNotDecisionMaker(heardText) ||
        isLikelyGreeting(heardText)
          ? buildReceptionPrompt(context.topic, context.contactName, "intro")
          : buildReceptionPrompt(context.topic, context.contactName, "what");

      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: "gatekeeper",
      });
    }

    if (soundsLikeNotDecisionMaker(heardText)) {
      const prompt = buildReceptionPrompt(context.topic, context.contactName, "intro");
      return respondWithGather({
        response,
        baseUrl,
        promptText: prompt,
        audioParams: { text: prompt },
        context,
        consent: "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${prompt}`),
        step: "intro",
        contactRole: "gatekeeper",
      });
    }

    const consentPrompt =
      "Perfekt, danke Ihnen. Ich bin Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel im Auftrag von Matthias Duic. Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?";

    return respondWithGather({
      response,
      baseUrl,
      promptText: consentPrompt,
      audioParams: { text: consentPrompt },
      context,
      consent: "no",
      turn: 0,
      transcript: trimTranscript(`${context.transcript}\nInteressent: ${heardText}\nGloria: ${consentPrompt}`),
      step: "consent",
      contactRole: "decision-maker",
    });
  }

  if (context.step === "consent") {
    const consent = detectConsent(speech, digits);

    if (consent === null) {
      const retryStateToken = encodeCallStateToken({
        callSid,
        leadId: context.leadId,
        company: context.company,
        contactName: context.contactName,
        topic: context.topic,
        step: "consent",
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn,
        transcript: context.transcript,
        contactRole: "decision-maker",
      });
      const retry = response.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: buildProcessUrl(baseUrl, {
          callSid,
          step: "consent",
          company: context.company,
          contactName: context.contactName,
          topic: context.topic,
          state: retryStateToken,
        }),
        method: "POST",
        language: "de-DE",
        speechTimeout: "auto",
      });

      if (isElevenLabsConfigured()) {
        retry.play(buildAudioUrl(baseUrl, { step: "consent-retry" }));
      } else {
        retry.say(
          { voice: "alice", language: "de-DE" },
          "Danke. Ich habe Sie akustisch nicht sicher verstanden. Wenn die Aufzeichnung in Ordnung ist, sagen Sie bitte ja oder drücken Sie die eins. Wenn nicht, sagen Sie bitte nein oder drücken Sie die zwei.",
        );
      }

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const consentValue = consent ? "yes" : "no";
    const appointmentText = `${consent ? "Vielen Dank." : "Natürlich, dann ohne Aufzeichnung."} ${buildDecisionMakerGreeting(context.topic, context.contactName)}`;

    if (getTwilioConversationMode() === "media-stream") {
      const mediaStreamUrl = getTwilioMediaStreamUrl();

      if (mediaStreamUrl) {
        if (isElevenLabsConfigured()) {
          response.play(buildAudioUrl(baseUrl, { text: appointmentText }));
        } else {
          response.say({ voice: "alice", language: "de-DE" }, appointmentText);
        }

        const connect = response.connect();
        const stream = connect.stream({ url: mediaStreamUrl });
        stream.parameter({ name: "leadId", value: context.leadId || "" });
        stream.parameter({ name: "company", value: context.company });
        stream.parameter({ name: "contactName", value: context.contactName || "" });
        stream.parameter({ name: "topic", value: context.topic });
        stream.parameter({ name: "recordingConsent", value: consentValue });

        return new NextResponse(response.toString(), {
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        });
      }
    }

    return respondWithGather({
      response,
      baseUrl,
      promptText: appointmentText,
      audioParams: {
        step: "appointment",
        topic: context.topic,
        consent: consentValue,
      },
      context,
      consent: consentValue,
      turn: 0,
      transcript: `Gloria: ${appointmentText}`,
    });
  }

  if (context.step === "conversation") {
    const heardText = speech || digits;

    if (!heardText) {
      if (context.turn >= MAX_SILENT_RETRIES) {
        await safelyStoreReport({
          leadId: context.leadId,
          company: context.company,
          contactName: context.contactName,
          topic: context.topic,
          summary: trimTranscript(
            `${context.transcript}\nInteressent: keine verwertbare Rückmeldung im Live-Gespräch.`,
          ),
          outcome: "Kein Kontakt",
          recordingConsent: context.consent === "yes",
          attempts: 1,
        });

        if (isElevenLabsConfigured()) {
          response.play(buildAudioUrl(baseUrl, { step: "final", variant: "neutral" }));
        } else {
          response.say(
            { voice: "alice", language: "de-DE" },
            "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
          );
        }

        response.hangup();

        return new NextResponse(response.toString(), {
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        });
      }

      const retryText =
        "Ich habe Sie akustisch gerade nicht ganz verstanden. Was ist Ihnen bei dem Thema aktuell wichtiger: eher Mitarbeiterbindung, Kosten oder erstmal nur ein kurzer Überblick?";

      return respondWithGather({
        response,
        baseUrl,
        promptText: retryText,
        audioParams: { step: "dynamic", text: retryText },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: trimTranscript(`${context.transcript}\nGloria: ${retryText}`),
        lowLatency: true,
      });
    }

    const isObjection =
      /kein interesse|keine zeit|später|unterlagen|email|e-mail|nicht zuständig|falsche person|was genau|worum geht|erklären sie|wir haben schon|haben bereits|zu teuer|zu klein|kein bedarf/.test(
        heardText,
      );
    const isPositiveSignal = /interessant|passt|gerne|gern|okay|einverstanden|ja/.test(heardText);
    const stage = isObjection
      ? "objection"
      : context.turn <= 0
        ? "discovery"
        : context.turn === 1
          ? "problem"
          : context.turn === 2
            ? "benefit"
            : context.turn >= 3 || isPositiveSignal
              ? "closing"
              : "discovery";

    const shouldUseFastRuleMode =
      !process.env.OPENAI_API_KEY ||
      context.turn === 0 ||
      heardText.length < 6 ||
      /^ja$|^nein$|^okay$|^ok$/.test(heardText.trim());

    const aiResult = await generateAdaptiveReply({
      topic: context.topic,
      prospectMessage: heardText,
      transcript: context.transcript,
      script: activeScript,
      stage,
      preferFastResponse: shouldUseFastRuleMode,
    });

    const updatedTranscript = trimTranscript(
      [context.transcript, `Interessent: ${heardText}`, `Gloria: ${aiResult.reply}`]
        .filter(Boolean)
        .join("\n"),
    );

    const detectedOutcome = classifyOutcome(heardText, stage);
    const reachedTurnLimit = context.turn >= MAX_LIVE_TURNS;
    const shouldFinish = detectedOutcome !== "Kein Kontakt" || reachedTurnLimit;

    if (!shouldFinish) {
      return respondWithGather({
        response,
        baseUrl,
        promptText: aiResult.reply,
        audioParams: { step: "dynamic", text: aiResult.reply },
        context,
        consent: context.consent === "yes" ? "yes" : "no",
        turn: context.turn + 1,
        transcript: updatedTranscript,
      });
    }

    const finalOutcome = detectedOutcome;
    const followUpDate = buildFollowUpDate(heardText, finalOutcome);
    await safelyStoreReport({
      leadId: context.leadId,
      company: context.company,
      contactName: context.contactName,
      topic: context.topic,
      summary: updatedTranscript,
      outcome: finalOutcome,
      appointmentAt: finalOutcome === "Termin" ? followUpDate : undefined,
      nextCallAt: finalOutcome === "Wiedervorlage" ? followUpDate : undefined,
      recordingConsent: context.consent === "yes",
      attempts: 1,
    });

    if (isElevenLabsConfigured()) {
      response.play(
        buildAudioUrl(baseUrl, {
          step: "final",
          variant:
            finalOutcome === "Termin"
              ? "success"
              : finalOutcome === "Wiedervorlage"
                ? "callback"
                : finalOutcome === "Absage"
                  ? "rejection"
                  : "neutral",
        }),
      );
    } else if (finalOutcome === "Termin") {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Perfekt, dann ist ein kurzer Termin vorgemerkt. Herr Duic meldet sich mit der Bestätigung. Vielen Dank für Ihre Zeit.",
      );
    } else if (finalOutcome === "Wiedervorlage") {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.",
      );
    } else if (finalOutcome === "Absage") {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.",
      );
    } else {
      response.say(
        { voice: "alice", language: "de-DE" },
        "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
      );
    }

    response.hangup();

    return new NextResponse(response.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  const outcome = classifyOutcome(speech, "closing");
  const followUpDate = buildFollowUpDate(speech, outcome);
  await safelyStoreReport({
    leadId: context.leadId,
    company: context.company,
    contactName: context.contactName,
    topic: context.topic,
    summary:
      speech
        ? `Twilio-Sprachdialog: ${speech}`
        : "Twilio-Sprachdialog ohne klar verwertbare Rückmeldung.",
    outcome,
    appointmentAt: outcome === "Termin" ? followUpDate : undefined,
    nextCallAt: outcome === "Wiedervorlage" ? followUpDate : undefined,
    recordingConsent: context.consent === "yes",
    attempts: 1,
  });

  if (isElevenLabsConfigured()) {
    response.play(
      buildAudioUrl(baseUrl, {
        step: "final",
        variant:
          outcome === "Termin"
            ? "success"
            : outcome === "Wiedervorlage"
              ? "callback"
              : outcome === "Absage"
                ? "rejection"
                : "neutral",
      }),
    );
  } else if (outcome === "Termin") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Perfekt, dann ist ein kurzer Termin vorgemerkt. Herr Duic meldet sich mit der Bestätigung. Vielen Dank für Ihre Zeit.",
    );
  } else if (outcome === "Wiedervorlage") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Sehr gern. Ich habe die Wiedervorlage notiert. Vielen Dank und bis bald.",
    );
  } else if (outcome === "Absage") {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Danke für die offene Rückmeldung. Dann wünsche ich Ihnen einen angenehmen Tag.",
    );
  } else {
    response.say(
      { voice: "alice", language: "de-DE" },
      "Vielen Dank für Ihre Zeit. Herr Duic meldet sich bei Bedarf noch einmal kurz bei Ihnen.",
    );
  }

  response.hangup();

  return new NextResponse(response.toString(), {
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}
