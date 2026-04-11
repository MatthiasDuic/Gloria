import { NextResponse } from "next/server";
import twilio from "twilio";
import { isElevenLabsConfigured } from "@/lib/elevenlabs";
import { sendReportEmail } from "@/lib/mailer";
import { storeCallReport } from "@/lib/storage";
import { getAppBaseUrl } from "@/lib/twilio";
import type { ReportOutcome, Topic } from "@/lib/types";

export const runtime = "nodejs";

function normalizeText(value: FormDataEntryValue | null) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function readContext(request: Request) {
  const url = new URL(request.url);

  return {
    step: url.searchParams.get("step") || "consent",
    leadId: url.searchParams.get("leadId") || undefined,
    company: url.searchParams.get("company") || "Unbekanntes Unternehmen",
    contactName: url.searchParams.get("contactName") || undefined,
    topic: (url.searchParams.get("topic") || "betriebliche Krankenversicherung") as Topic,
  };
}

function buildTopicIntro(topic: Topic) {
  if (topic === "betriebliche Altersvorsorge") {
    return "Es geht um einen kurzen Abgleich, wie sich die betriebliche Altersvorsorge einfacher und attraktiver kommunizieren lässt.";
  }

  if (topic === "gewerbliche Versicherungen") {
    return "Es geht um einen kompakten Vergleich Ihrer gewerblichen Absicherung auf Preis, Leistung und eventuelle Lücken.";
  }

  if (topic === "private Krankenversicherung") {
    return "Es geht um eine kurze Einordnung, wie sich Krankenversicherungsbeiträge im Alter besser planen lassen.";
  }

  if (topic === "Energie") {
    return "Es geht um einen kurzen gewerblichen Strom- und Gasvergleich mit möglichem Einsparpotenzial.";
  }

  return "Es geht um die betriebliche Krankenversicherung als attraktiven Mitarbeitenden-Benefit.";
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

  if (/(ja|gern|gerne|interessant|passt|termin|machen wir|einverstanden|okay)/.test(speech)) {
    return "Termin";
  }

  return "Kein Kontakt";
}

function buildFollowUpDate(speech: string, outcome: ReportOutcome) {
  const now = new Date();
  const result = new Date(now);
  const wantsNextWeek = /nächste woche/.test(speech);
  result.setDate(now.getDate() + (wantsNextWeek ? 7 : 2));
  result.setHours(outcome === "Termin" ? (/nachmittag|14|15|16/.test(speech) ? 14 : 10) : 11, 0, 0, 0);
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

export async function POST(request: Request) {
  const baseUrl = getAppBaseUrl(request);
  const context = readContext(request);
  const form = await request.formData();
  const speech = normalizeText(form.get("SpeechResult"));
  const digits = normalizeText(form.get("Digits"));
  const response = new twilio.twiml.VoiceResponse();

  if (context.step === "consent") {
    const consent = detectConsent(speech, digits);

    if (consent === null) {
      const retry = response.gather({
        input: ["speech", "dtmf"],
        numDigits: 1,
        action: `${baseUrl}/api/twilio/voice/process?step=consent&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName || "")}&topic=${encodeURIComponent(context.topic)}`,
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

      response.hangup();

      return new NextResponse(response.toString(), {
        headers: { "Content-Type": "text/xml; charset=utf-8" },
      });
    }

    const gather = response.gather({
      input: ["speech", "dtmf"],
      action: `${baseUrl}/api/twilio/voice/process?step=appointment&consent=${consent ? "yes" : "no"}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName || "")}&topic=${encodeURIComponent(context.topic)}`,
      method: "POST",
      language: "de-DE",
      speechTimeout: "auto",
      hints: "ja, nein, nächste Woche, später, Rückruf, kein Interesse",
    });

    const appointmentText = `${consent ? "Vielen Dank, ich notiere die Zustimmung." : "Natürlich, dann ohne Aufzeichnung."} ${buildTopicIntro(context.topic)} Passt dafür eher ein kurzer Termin mit Herrn Duic, oder soll ich eine Wiedervorlage notieren?`;

    if (isElevenLabsConfigured()) {
      gather.play(
        buildAudioUrl(baseUrl, {
          step: "appointment",
          topic: context.topic,
          consent: consent ? "yes" : "no",
        }),
      );
    } else {
      gather.say({ voice: "alice", language: "de-DE" }, appointmentText);
    }

    response.redirect(
      { method: "POST" },
      `${baseUrl}/api/twilio/voice/process?step=appointment&consent=${consent ? "yes" : "no"}&leadId=${encodeURIComponent(context.leadId || "")}&company=${encodeURIComponent(context.company)}&contactName=${encodeURIComponent(context.contactName || "")}&topic=${encodeURIComponent(context.topic)}`,
    );

    return new NextResponse(response.toString(), {
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });
  }

  const outcome = classifyOutcome(speech);
  const followUpDate = buildFollowUpDate(speech, outcome);
  const report = await storeCallReport({
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
    recordingConsent: new URL(request.url).searchParams.get("consent") === "yes",
    attempts: 1,
  });

  await sendReportEmail(report).catch(() => undefined);

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
