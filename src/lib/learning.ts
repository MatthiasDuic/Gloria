import { TOPICS } from "./types";
import { getDashboardData, saveScript } from "./storage";
import type {
  CallReport,
  LearningInsight,
  LearningResponse,
  ScriptConfig,
  Topic,
} from "./types";

function percentage(part: number, total: number) {
  if (!total) {
    return 0;
  }

  return Math.round((part / total) * 100);
}

function collectSignals(reports: CallReport[]): string[] {
  const combined = reports.map((report) => report.summary.toLowerCase()).join(" ");
  const signals: string[] = [];

  if (/rückruf|wiedervorlage|später|späteren zeitpunkt|samstag/.test(combined)) {
    signals.push(
      "Zeitknappheit kommt vor – kurze 15-Minuten-Termine und konkrete Rückrufzeiten funktionieren hier besser.",
    );
  }

  if (/vergleich|einspar|förder|recruit|bindung|cyber|optimier/.test(combined)) {
    signals.push(
      "Klare Nutzenargumente wie Vergleich, Einsparung oder Mitarbeiterbindung erzeugen spürbar mehr Resonanz.",
    );
  }

  if (reports.some((report) => report.outcome === "Termin")) {
    signals.push(
      "Konkrete Terminangebote mit zwei Auswahloptionen erhöhen die Abschlusswahrscheinlichkeit.",
    );
  }

  if (!signals.length) {
    signals.push(
      "Für dieses Thema werden noch weitere Gespräche gesammelt, damit Gloria die Ansprache weiter schärfen kann.",
    );
  }

  return signals;
}

function buildRecommendations(
  topic: Topic,
  reports: CallReport[],
  appointmentRate: number,
): string[] {
  const callbacks = reports.filter((report) => report.outcome === "Wiedervorlage").length;
  const rejections = reports.filter((report) => report.outcome === "Absage").length;
  const recommendations: string[] = [];

  if (callbacks > 0) {
    recommendations.push(
      "Früh signalisieren, dass es nur um einen kurzen, unverbindlichen Termin geht und direkt zwei Zeitfenster anbieten.",
    );
  }

  if (rejections >= 1 || appointmentRate < 35) {
    recommendations.push(
      "Den Mehrwert in den ersten 10 Sekunden noch klarer machen und direkter auf den geschäftlichen Nutzen eingehen.",
    );
  }

  if (topic === "betriebliche Krankenversicherung") {
    recommendations.push(
      "Recruiting und Mitarbeiterbindung noch etwas früher im Einstieg platzieren, weil das im B2B-Kontext stark zieht.",
    );
  }

  if (topic === "Energie") {
    recommendations.push(
      "Einsparpotenziale und Vertragslaufzeiten sehr konkret ansprechen, damit der Anlass sofort greifbar ist.",
    );
  }

  if (!recommendations.length) {
    recommendations.push(
      "Den bestehenden Gesprächsaufbau beibehalten und weiter mit echten Gesprächsberichten trainieren.",
    );
  }

  return recommendations;
}

function buildOptimizedScript(script: ScriptConfig, reports: CallReport[]): ScriptConfig {
  const callbacks = reports.filter((report) => report.outcome === "Wiedervorlage").length;
  const appointments = reports.filter((report) => report.outcome === "Termin").length;

  const opener = script.opener.includes("15-Minuten")
    ? script.opener
    : `${script.opener} Es geht wirklich nur um eine kurze Einordnung von etwa 15 Minuten.`;

  const discovery = script.discovery.includes("Was wäre für Sie")
    ? script.discovery
    : `${script.discovery} Was wäre für Sie dabei aktuell am interessantesten – Mitarbeitervorteile, Kosten oder Absicherung?`;

  const objectionHandling = callbacks > 0 && !script.objectionHandling.includes("wenig Zeit")
    ? `${script.objectionHandling} Falls es gerade zeitlich eng ist: Genau dafür ist der Termin bewusst kurz und unkompliziert gehalten.`
    : script.objectionHandling;

  const close = appointments > 0 && !script.close.includes("Dienstagvormittag")
    ? `${script.close} Ich mache es Ihnen gern einfach: Wäre eher Dienstagvormittag oder Donnerstagnachmittag passend?`
    : `${script.close} Wenn Sie möchten, schlage ich Ihnen direkt zwei kurze Zeitfenster vor.`;

  return {
    ...script,
    opener,
    discovery,
    objectionHandling,
    close,
  };
}

export async function getLearningResponse(options?: {
  userId?: string;
  role?: "master" | "user";
}): Promise<LearningResponse> {
  const data = await getDashboardData({
    userId: options?.userId,
    role: options?.role,
  });

  const insights: LearningInsight[] = TOPICS.map((topic) => {
    const script = data.scripts.find((entry) => entry.topic === topic);
    const reports = data.reports.filter((report) => report.topic === topic);
    const appointments = reports.filter((report) => report.outcome === "Termin").length;
    const rejections = reports.filter((report) => report.outcome === "Absage").length;
    const callbacks = reports.filter((report) => report.outcome === "Wiedervorlage").length;
    const totalConversations = reports.length;
    const appointmentRate = percentage(appointments, totalConversations);

    const fallbackScript: ScriptConfig =
      script || data.scripts[0] || {
        id: `fallback-${topic}`,
        topic,
        opener: "",
        discovery: "",
        objectionHandling: "",
        close: "",
      };

    return {
      topic,
      totalConversations,
      appointments,
      rejections,
      callbacks,
      appointmentRate,
      signals: collectSignals(reports),
      recommendations: buildRecommendations(topic, reports, appointmentRate),
      optimizedScript: buildOptimizedScript(fallbackScript, reports),
    };
  });

  const bestTopic = [...insights].sort((left, right) => right.appointmentRate - left.appointmentRate)[0];
  const callbackTopic = [...insights].sort((left, right) => right.callbacks - left.callbacks)[0];

  return {
    insights,
    globalSummary: [
      bestTopic && bestTopic.totalConversations > 0
        ? `Beste Terminquote aktuell: ${bestTopic.topic} mit ${bestTopic.appointmentRate} %.`
        : "Gloria sammelt aktuell erste Gesprächsdaten für belastbare Optimierungen.",
      callbackTopic && callbackTopic.callbacks > 0
        ? `Die meisten Wiedervorlagen liegen bei ${callbackTopic.topic}; dort hilft ein noch kürzerer und direkterer Abschluss.`
        : "Der aktuelle Fokus liegt darauf, erfolgreiche Gesprächsmuster weiter auszubauen.",
      "Gloria kann die empfohlenen Verbesserungen pro Thema direkt ins Skript übernehmen.",
    ],
  };
}

export async function applyLearningSuggestion(
  topic: Topic,
  options?: { userId?: string; role?: "master" | "user" },
) {
  const learning = await getLearningResponse(options);
  const insight = learning.insights.find((entry) => entry.topic === topic);

  if (!insight) {
    throw new Error(`Kein Learning für ${topic} gefunden.`);
  }

  const saved = await saveScript(topic, insight.optimizedScript, {
    userId: options?.userId,
  });

  return {
    topic,
    saved,
    recommendations: insight.recommendations,
  };
}
