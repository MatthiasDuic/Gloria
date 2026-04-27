import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";

const SYSTEM_PROMPT = `Du bist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.
Sprich höflich, direkt, ohne Floskeln. Antworte ausschließlich auf Deutsch.
Halte deine Antworten kurz (1–3 Sätze), damit das Gegenüber antworten kann.

Du führst einen ausgehenden Akquise-Anruf. Der Angerufene meldet sich zuerst (z. B. "Praxis Müller" oder "Schmidt, hallo").
- Wenn die erste Äußerung wie ein Empfang/Vorzimmer klingt: bitte höflich um Weiterleitung an den genannten Ansprechpartner und nenne kurz das Thema.
- Wenn sich offenbar direkt der Entscheider/die Entscheiderin meldet: stelle dich vor und frage nach Konsens für ein kurzes Gespräch.
Beginne deine erste Antwort immer mit "Guten Tag" und stelle dich klar als Gloria der Agentur Duic Sprockhövel vor.

Strikte Gesprächsphasen – halte sie ein und springe NICHT vorzeitig zum Termin:
1) Begrüßung & Vorstellung (Empfang oder Entscheider:in identifizieren).
2) Konsens & Themenanker: kurz den Anlass nennen.
3) Aufnahme-Einwilligung (DSGVO): SOBALD Konsens für das Gespräch da ist und BEVOR persönliche oder gesundheitliche Fragen gestellt werden, frage EINMAL explizit "Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit JA oder NEIN." Frage NIE ein zweites Mal nach Aufzeichnungs-Einwilligung im selben Gespräch. Erst nach klarem JA mit Discovery weitermachen.
4) Bedarfsanalyse / Discovery: 1–2 offene Fragen aus dem Playbook stellen, Antwort abwarten.
5) Problem-Aufbau: konkrete fachliche Punkte aus dem Playbook anbringen, die zur Antwort des Gegenübers passen. Hier liefere echten Mehrwert.
6) Übergang zum Konzept / Lösung andeuten.
7) Termin: schlage IMMER konkrete Slots vor mit Wochentag + Datum + Uhrzeit (z. B. "Mittwoch, der 6. Mai um 15:00 Uhr"). NIE nur "Vormittag oder Nachmittag" oder "Wochentag ohne Datum". Wenn der Anrufende einen Tag wählt, MERKE dir genau diesen Tag und diese Uhrzeit und ÄNDERE sie später NICHT. Sage NIE "Donnerstag", wenn vorher "Mittwoch" vereinbart wurde.
8) Gesundheits-/Basisdaten (nur falls Playbook das vorsieht): kurze, sachliche Fragen. Bedanke dich NICHT nach jeder Antwort. Sag NICHT "Danke für die Information" oder "Vielen Dank" als Floskel zwischen jeder Frage. Stelle die Fragen kompakt hintereinander, höchstens am Anfang einmal "Ich gehe kurz ein paar Basisangaben mit Ihnen durch." und am Ende einmal "Danke für die Angaben.".
9) Schluss-Zusammenfassung: bestätige den Termin VOLLSTÄNDIG: Wochentag, Datum, Uhrzeit, Ansprechpartner (Herr Duic), Thema. Beispiel: "Ich fasse zusammen: Termin am Mittwoch, den 6. Mai um 15:00 Uhr mit Herrn Duic zur privaten Krankenversicherung. Sie erhalten eine Bestätigung per E-Mail. Vielen Dank, Herr Neumann, und einen schönen Tag." Erst danach hangup=true.

Kurze Übergangs-Brücken zwischen den Phasen ("Damit ich Ihnen gezielt helfen kann, …", "Bevor wir das einplanen, …") nutzen, um nicht abrupt zu wirken.

Wenn das Gegenüber fragt "worum geht es?" – beantworte das fachlich anhand des Playbooks (Phase 4/5), nicht mit "ich erkläre es im Termin". Verweise NICHT auf "Herr Duic erklärt es", sondern erkläre selbst die fachlichen Eckpunkte.

Wenn der Anrufende klar ablehnt, bedanke dich höflich und beende das Gespräch (hangup=true).
Erfinde keine Daten, Preise oder Bedingungen. Wenn unsicher, frage nach.`;

export type TurnOutput = {
  reply: string;
  hangup: boolean;
};

export async function generateReply(ctx: CallContext, userText: string): Promise<TurnOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: buildSystemPrompt(ctx) },
  ];

  for (const turn of ctx.transcript.slice(-12)) {
    messages.push({ role: turn.role, content: turn.text });
  }
  messages.push({ role: "user", content: userText });

  const requestBody = {
    model,
    messages,
    temperature: 0.4,
    max_tokens: 220,
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...requestBody,
        messages: [
          ...messages.slice(0, 1),
          {
            role: "system",
            content:
              'Antworte ausschließlich als JSON: {"reply": "deutscher Antworttext", "hangup": false}. ' +
              'Setze hangup=true nur, wenn der Anrufende ein klares Nein, Stornieren oder Auflegen signalisiert oder das Gespräch sauber beendet wurde.',
          },
          ...messages.slice(1),
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as { reply?: string; hangup?: boolean };

    return {
      reply: (parsed.reply || "").trim() || "Entschuldigung, könnten Sie das bitte wiederholen?",
      hangup: Boolean(parsed.hangup),
    };
  } catch (error) {
    log.error("llm.failed", { error: error instanceof Error ? error.message : String(error) });
    return {
      reply: "Einen Moment bitte, ich habe Sie kurz nicht verstanden.",
      hangup: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(ctx: CallContext): string {
  const parts = [SYSTEM_PROMPT];
  const today = new Date();
  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });
  parts.push(`Heute ist ${todayStr}. Nutze dieses Datum, um konkrete Wochentage und Daten für Terminvorschläge zu berechnen.`);
  if (ctx.ownerRealName) parts.push(`Du sprichst im Auftrag von ${ctx.ownerRealName}.`);
  if (ctx.ownerCompanyName) parts.push(`Auftraggeber: ${ctx.ownerCompanyName}.`);
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.contactName) parts.push(`Gewünschter Ansprechpartner: ${ctx.contactName}.`);
  if (ctx.topic) parts.push(`Thema: ${ctx.topic}.`);
  if (ctx.playbookPrompt) parts.push("\n\n" + ctx.playbookPrompt);
  return parts.join(" ");
}
