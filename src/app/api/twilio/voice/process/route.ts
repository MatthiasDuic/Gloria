import { NextResponse } from "next/server";
import twilio from "twilio";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { generateAdaptiveReply } from "@/lib/live-agent";
import { sendReportEmail } from "@/lib/mailer";
import { getDashboardData, storeCallReport } from "@/lib/storage";
import {
  getAppBaseUrl,
  getTwilioConversationMode,
  getTwilioMediaStreamUrl,
} from "@/lib/twilio";
import type { ReportOutcome, Topic } from "@/lib/types";

export const runtime = "nodejs";

const MAX_LIVE_TURNS = 5;
const MAX_SILENT_RETRIES = 2;

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readContext(request: Request) {
  const url = new URL(request.url);

  return {
    step: url.searchParams.get("step") || "intro",
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Unbekanntes Unternehmen",
    contactName: url.searchParams.get("contactName") || undefined,
    topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
    consent: url.searchParams.get("consent") || "no",
    turn: Number(url.searchParams.get("turn") || "0"),
    transcript: url.searchParams.get("transcript") || "",
  };
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

function buildDecisionMakerPrompt(topic: Topic) {
  return `${buildTopicIntro(topic)} Sind Sie dafür die richtige Ansprechperson, oder wen darf ich dazu am besten kurz sprechen?`;
}

function soundsLikeNotDecisionMaker(text: string) {
  return /nicht zuständig|bin ich nicht|dafür ist .* zuständig|sekretariat|empfang|zentrale|assistenz|büro|nicht da|außer haus|ich verbinde|ich leite.*weiter|weiterleiten/.test(text);
}

function soundsLikeDecisionMaker(text: string) {
  return /ich bin zuständig|das bin ich|ja,? ich bin|da sprechen sie richtig|das passt|ich kümmere mich|dafür bin ich zuständig/.test(text);
}

function isLikelyGreeting(text: string) {
  if (soundsLikeDecisionMaker(text) || soundsLikeNotDecisionMaker(text)) {
    return false;
  }

  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3 || /hallo|guten tag|ja bitte|wer ist da|moment|einen moment|moin/.test(text);
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

function classifyOutcome(speech: string): ReportOutcome {
  if (/(kein interesse|nicht interessant|bitte nicht|nein danke|keinen bedarf|kein bedarf)/.test(speech)) {
    return "Absage";
  }

  if (/(später|andermal|nächste woche|rückruf|rufen sie wieder an|kein[e]? zeit|im moment schlecht)/.test(speech)) {
    return "Wiedervorlage";
  }

  if (/termin|machen wir|passt .*vormittag|passt .*nachmittag|einverstanden mit termin|gerne termin/.test(speech)) {
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
}) {
  const nextStep = options.step || "conversation";
  const actionUrl = buildProcessUrl(options.baseUrl, {
    step: nextStep,
    consent: options.consent,
    leadId: options.context.leadId,
    company: options.context.company,
    contactName: options.context.contactName,
    topic: options.context.topic,
    turn: String(options.turn),
    transcript: trimTranscript(options.transcript),
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

  if (!options.lowLatency && isElevenLabsConfigured()) {
    gather.play(
      buildAudioUrl(options.baseUrl, {
        text: options.promptText,
        ...options.audioParams,
      }),
    );
  } else {
    gather.say({ voice: "alice", language: "de-DE" }, options.promptText);
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
  const context = readContext(request);
  const form = await request.formData();
  const speech = normalizeText(form.get("SpeechResult"));
  const digits = normalizeText(form.get("Digits"));
  const response = new twilio.twiml.VoiceResponse();
  const dashboardData = await getDashboardData();
  const activeScript = dashboardData.scripts.find((entry) => entry.topic === context.topic);

  if (context.step === "intro") {
    const heardText = speech || digits;

    if (!heardText) {
      const prompt = `Guten Tag. ${buildDecisionMakerPrompt(context.topic)}`;
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
      });
    }

    if (soundsLikeNotDecisionMaker(heardText) || isLikelyGreeting(heardText) || /worum geht|was genau|wer sind sie|ja bitte/.test(heardText)) {
      const prompt = `Danke Ihnen. ${buildDecisionMakerPrompt(context.topic)}`;
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
      });
    }

    if (soundsLikeDecisionMaker(heardText) || context.turn >= 1) {
      const consentPrompt =
        "Perfekt, danke Ihnen. Bevor wir weitergehen: Darf ich das Gespräch kurz zu Schulungs- und Qualitätszwecken aufzeichnen?";

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
      });
    }

    const prompt = `Danke Ihnen. ${buildDecisionMakerPrompt(context.topic)}`;
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
    });
  }

  if (context.step === "consent") {
    const consent = detectConsent(speech, digits);

    if (consent === null) {
      const retry = response.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: buildProcessUrl(baseUrl, {
          step: "consent",
          leadId: context.leadId,
          company: context.company,
          contactName: context.contactName,
          topic: context.topic,
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
    const discoveryPrompt = activeScript?.discovery || "Darf ich kurz fragen, wie Sie dieses Thema aktuell bei sich handhaben?";
    const appointmentText = `${consent ? "Vielen Dank, ich notiere die Zustimmung." : "Natürlich, dann ohne Aufzeichnung."} ${buildTopicIntro(context.topic)} ${discoveryPrompt}`;

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
        "Ich habe Sie akustisch gerade nicht ganz verstanden. Möchten Sie lieber einen kurzen Termin, eine Wiedervorlage oder soll ich es noch einmal kurz einordnen?";

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
      /kein interesse|keine zeit|später|unterlagen|email|e-mail|nicht zuständig|falsche person|was genau|worum geht|erklären sie/.test(
        heardText,
      );
    const isPositiveSignal = /interessant|passt|gerne|gern|okay|einverstanden|ja/.test(heardText);
    const stage = isObjection
      ? "objection"
      : context.turn <= 1
        ? "discovery"
        : context.turn >= MAX_LIVE_TURNS - 1 || isPositiveSignal
          ? "closing"
          : "discovery";

    const aiResult = await generateAdaptiveReply({
      topic: context.topic,
      prospectMessage: heardText,
      transcript: context.transcript,
      script: activeScript,
      stage,
      preferFastResponse: true,
    });

    const updatedTranscript = trimTranscript(
      [context.transcript, `Interessent: ${heardText}`, `Gloria: ${aiResult.reply}`]
        .filter(Boolean)
        .join("\n"),
    );

    const detectedOutcome = classifyOutcome(heardText);
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

    const finalOutcome =
      detectedOutcome === "Kein Kontakt" && reachedTurnLimit ? "Wiedervorlage" : detectedOutcome;
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

  const outcome = classifyOutcome(speech);
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
