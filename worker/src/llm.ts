import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";

const SYSTEM_PROMPT = `Du bist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.
Sprich höflich, direkt, ohne Floskeln. Antworte ausschließlich auf Deutsch.
Halte deine Antworten kurz (1–2 Sätze, max. 25 Wörter), damit das Gegenüber schnell antworten kann.
Ziel: Termin vereinbaren oder einen geeigneten Rückruf koordinieren.
Wenn der Anrufende ablehnt, bedanke dich höflich und beende das Gespräch.
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
    max_tokens: 120,
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
  if (ctx.ownerRealName) parts.push(`Du sprichst im Auftrag von ${ctx.ownerRealName}.`);
  if (ctx.ownerCompanyName) parts.push(`Auftraggeber: ${ctx.ownerCompanyName}.`);
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.contactName) parts.push(`Gewünschter Ansprechpartner: ${ctx.contactName}.`);
  if (ctx.topic) parts.push(`Thema: ${ctx.topic}.`);
  return parts.join(" ");
}
