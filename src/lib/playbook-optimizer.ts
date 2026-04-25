import { AI_CONFIG } from "./ai-config";
import type { CallReport, ScriptConfig, Topic } from "./types";

export interface OptimizerResult {
  opener: string;
  discovery: string;
  objectionHandling: string;
  close: string;
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
    "Du optimierst das Playbook von Gloria, einer digitalen Vertriebsassistentin.",
    "Antworten immer in deutscher Sprache, hoeflich, DSGVO-konform.",
    "Keine erfundenen Fakten, keine Preise, keine Tarifempfehlungen.",
    "Du gibst ausschliesslich JSON zurueck nach dem vorgegebenen Schema.",
  ].join(" ");

  const user = [
    `Thema: ${topic}`,
    `Statistik: ${JSON.stringify(stats)}`,
    "",
    "Aktuelles Playbook:",
    `Opener: ${current.opener}`,
    `Discovery: ${current.discovery}`,
    `Objection Handling: ${current.objectionHandling}`,
    `Close: ${current.close}`,
    "",
    "Gespraechsberichte (Auszug):",
    condensed || "(noch keine Berichte)",
    "",
    "Aufgabe: Optimiere opener, discovery, objectionHandling, close so,",
    "dass mehr Termine vereinbart und weniger Absagen produziert werden.",
    "Bleibe nah am Stil des aktuellen Playbooks, aendere nur was konkrete",
    "Schwaechen in den Berichten zeigen. Begruende knapp in rationale[]",
    "(max. 4 Stichpunkte).",
    "",
    "Antworte AUSSCHLIESSLICH als JSON mit den Keys:",
    `{"opener":string,"discovery":string,"objectionHandling":string,"close":string,"rationale":string[]}`,
  ].join("\n");

  return { system, user };
}

function heuristicOptimize(current: ScriptConfig, reports: CallReport[]): OptimizerResult {
  const callbacks = reports.filter((r) => r.outcome === "Wiedervorlage").length;
  const appointments = reports.filter((r) => r.outcome === "Termin").length;

  const opener = current.opener.includes("15-Minuten")
    ? current.opener
    : `${current.opener} Es geht wirklich nur um eine kurze Einordnung von etwa 15 Minuten.`;
  const discovery = current.discovery.includes("Was waere fuer Sie")
    ? current.discovery
    : `${current.discovery} Was waere fuer Sie dabei aktuell am interessantesten?`;
  const objectionHandling =
    callbacks > 0 && !current.objectionHandling.includes("wenig Zeit")
      ? `${current.objectionHandling} Falls es zeitlich eng ist: der Termin ist bewusst kurz und unverbindlich.`
      : current.objectionHandling;
  const close =
    appointments > 0 && !current.close.includes("Dienstagvormittag")
      ? `${current.close} Waere eher Dienstagvormittag oder Donnerstagnachmittag passend?`
      : `${current.close} Wenn Sie moechten, schlage ich direkt zwei kurze Zeitfenster vor.`;

  return {
    opener,
    discovery,
    objectionHandling,
    close,
    rationale: [
      "Heuristische Optimierung basierend auf Report-Zaehlern.",
      callbacks > 0 ? "Wiedervorlagen deuten auf Zeitdruck -> Laenge reduzieren." : "Keine nennenswerten Wiedervorlagen.",
      appointments > 0 ? "Konkrete Terminpaare erhoehen Abschluss." : "Noch zu wenige Termine fuer harte Aussagen.",
    ],
    source: "heuristic",
  };
}

export async function optimizePlaybook(
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
      typeof parsed.opener !== "string" ||
      typeof parsed.discovery !== "string" ||
      typeof parsed.objectionHandling !== "string" ||
      typeof parsed.close !== "string"
    ) {
      return heuristicOptimize(current, reports);
    }

    return {
      opener: parsed.opener,
      discovery: parsed.discovery,
      objectionHandling: parsed.objectionHandling,
      close: parsed.close,
      rationale: Array.isArray(parsed.rationale) ? parsed.rationale.slice(0, 6) : [],
      source: "openai",
    };
  } catch {
    return heuristicOptimize(current, reports);
  } finally {
    clearTimeout(timeout);
  }
}
