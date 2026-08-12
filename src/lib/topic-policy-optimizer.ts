import { AI_CONFIG } from "./ai-config";
import type { CallReport, ScriptConfig, Topic } from "./types";

export interface OptimizerResult {
  topicSummary: string;
  behavior: string;
  conversationGuardrails: string;
  requiredQuestions: string;
  rationale: string[];
  source: "openai" | "heuristic";
}

function buildPrompt(topic: Topic, reports: CallReport[], current: ScriptConfig) {
  const condensed = reports
    .slice(0, 25)
    .map((r, i) => `#${i + 1} [${r.outcome}] ${r.company}: ${(r.summary || "").slice(0, 800)}`)
    .join("\n---\n");
  const stats = {
    total: reports.length,
    termin: reports.filter((r) => r.outcome === "Termin").length,
    absage: reports.filter((r) => r.outcome === "Absage").length,
    wiedervorlage: reports.filter((r) => r.outcome === "Wiedervorlage").length,
    keinKontakt: reports.filter((r) => r.outcome === "Kein Kontakt").length,
  };

  const system = [
    "Du bist Trainer fuer B2B-Telefonvertrieb im Versicherungsumfeld (Deutschland).",
    "Du optimierst die Topic Policy von Gloria, einer digitalen Vertriebsassistentin.",
    "Antworten immer in deutscher Sprache, hoeflich, DSGVO-konform.",
    "Keine erfundenen Fakten, keine Preise, keine Tarifempfehlungen.",
    "Du gibst ausschliesslich JSON zurueck nach dem vorgegebenen Schema.",
  ].join(" ");

  const user = [
    `Thema: ${topic}`,
    `Statistik: ${JSON.stringify(stats)}`,
    "",
    "Aktuelle Topic Policy:",
    `Topic Summary: ${current.topicSummary || ""}`,
    `Behavior: ${current.behavior || ""}`,
    `Conversation Guardrails: ${current.conversationGuardrails || ""}`,
    `Required Questions: ${current.requiredQuestions || ""}`,
    "",
    "Gespraechsberichte (Auszug):",
    condensed || "(noch keine Berichte)",
    "",
    "Aufgabe: Optimiere topicSummary, behavior, conversationGuardrails, requiredQuestions so,",
    "dass mehr Termine vereinbart und weniger Absagen produziert werden.",
    "Bleibe nah am Stil der aktuellen Topic Policy, aendere nur was konkrete",
    "Schwaechen in den Berichten zeigen. Begruende knapp in rationale[]",
    "(max. 4 Stichpunkte).",
    "",
    "Antworte AUSSCHLIESSLICH als JSON mit den Keys:",
    `{"topicSummary":string,"behavior":string,"conversationGuardrails":string,"requiredQuestions":string,"rationale":string[]}`,
  ].join("\n");

  return { system, user };
}

function heuristicOptimize(current: ScriptConfig, reports: CallReport[]): OptimizerResult {
  const callbacks = reports.filter((r) => r.outcome === "Wiedervorlage").length;
  const appointments = reports.filter((r) => r.outcome === "Termin").length;

  const topicSummary = (current.topicSummary || "").trim();
  const behavior = (current.behavior || "").trim();
  const conversationGuardrails = (current.conversationGuardrails || "").trim();
  const requiredQuestions = (current.requiredQuestions || "").trim();

  const nextTopicSummary = topicSummary.includes("15")
    ? topicSummary
    : `${topicSummary}${topicSummary ? " " : ""}Nutzenversprechen frueh und konkret machen, dann auf einen kurzen 10-15-Minuten-Termin fuehren.`;
  const nextBehavior = callbacks > 0 && !behavior.toLowerCase().includes("kurz")
    ? `${behavior}${behavior ? "\n" : ""}Bei Zeitdruck extra kurz bleiben: maximal zwei kurze Saetze, dann eine klare Frage.`
    : behavior;
  const nextGuardrails = appointments > 0 && !conversationGuardrails.toLowerCase().includes("auswahl")
    ? `${conversationGuardrails}${conversationGuardrails ? "\n" : ""}Terminfragen als Auswahl formulieren (zwei konkrete Fenster statt offene Kalenderfrage).`
    : conversationGuardrails;
  const nextRequiredQuestions = requiredQuestions
    ? requiredQuestions
    : "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?";

  return {
    topicSummary: nextTopicSummary,
    behavior: nextBehavior,
    conversationGuardrails: nextGuardrails,
    requiredQuestions: nextRequiredQuestions,
    rationale: [
      "Heuristische Optimierung basierend auf Report-Zaehlern.",
      callbacks > 0 ? "Wiedervorlagen deuten auf Zeitdruck -> Laenge reduzieren." : "Keine nennenswerten Wiedervorlagen.",
      appointments > 0 ? "Konkrete Terminpaare erhoehen Abschluss." : "Noch zu wenige Termine fuer harte Aussagen.",
    ],
    source: "heuristic",
  };
}

export async function optimizeTopicPolicy(
  topic: Topic,
  reports: CallReport[],
  current: ScriptConfig,
): Promise<OptimizerResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || reports.length === 0) {
    return heuristicOptimize(current, reports);
  }

  const { system, user } = buildPrompt(topic, reports, current);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: AI_CONFIG.chatModel,
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return heuristicOptimize(current, reports);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return heuristicOptimize(current, reports);
    }

    const parsed = JSON.parse(content) as Partial<OptimizerResult>;
    if (
      typeof parsed.topicSummary !== "string" ||
      typeof parsed.behavior !== "string" ||
      typeof parsed.conversationGuardrails !== "string" ||
      typeof parsed.requiredQuestions !== "string"
    ) {
      return heuristicOptimize(current, reports);
    }

    return {
      topicSummary: parsed.topicSummary,
      behavior: parsed.behavior,
      conversationGuardrails: parsed.conversationGuardrails,
      requiredQuestions: parsed.requiredQuestions,
      rationale: Array.isArray(parsed.rationale) ? parsed.rationale.slice(0, 6) : [],
      source: "openai",
    };
  } catch {
    return heuristicOptimize(current, reports);
  } finally {
    clearTimeout(timeout);
  }
}
