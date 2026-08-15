import { fetch } from "undici";
import { log } from "./log.js";

export type TopicPolicyFields = {
  topic?: string;
  callObjective?: string;
  topicSummary?: string;
  behavior?: string;
  conversationGuardrails?: string;
  requiredQuestions?: string;
  requiredData?: string;
  exampleSentences?: string;
};

export async function loadTopicPolicy(opts: {
  userId?: string;
  topic?: string;
}): Promise<TopicPolicyFields | null> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token) {
    log.warn("topic_policy.skipped_no_config");
    return null;
  }
  if (!opts.topic) {
    log.warn("topic_policy.skipped_no_topic");
    return null;
  }

  const params = new URLSearchParams();
  if (opts.userId) params.set("userId", opts.userId);

  const url = `${baseUrl}/api/telnyx/topic-policies${params.toString() ? `?${params.toString()}` : ""}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-gloria-internal-token": token },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("topic_policy.http_error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as { topicPolicies?: TopicPolicyFields[] };
    const list = Array.isArray(json.topicPolicies) ? json.topicPolicies : [];
    const match =
      list.find((p) => (p.topic || "").toLowerCase() === opts.topic!.toLowerCase()) ||
      list[0] ||
      null;
    if (!match) {
      log.warn("topic_policy.no_match", { topic: opts.topic });
      return null;
    }
    log.info("topic_policy.loaded", { topic: match.topic, fields: Object.keys(match).length });
    return match;
  } catch (error) {
    log.warn("topic_policy.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function topicPolicyToSystemPrompt(policy: TopicPolicyFields): string {
  const topic = (policy.topic || "").trim();
  const callObjective = (policy.callObjective || "").trim();
  const topicSummary = (policy.topicSummary || "").trim();
  const behavior = (policy.behavior || "").trim();
  const conversationGuardrails = (policy.conversationGuardrails || "").trim();
  const requiredQuestions = (policy.requiredQuestions || policy.requiredData || "").trim();
  const exampleSentences = (policy.exampleSentences || "").trim();

  if (
    !topicSummary &&
    !callObjective &&
    !behavior &&
    !conversationGuardrails &&
    !requiredQuestions
  ) {
    return topic ? `THEMA DIESES CALLS: ${topic}` : "";
  }

  const parts: string[] = [];
  parts.push("TOPIC POLICY – fachliche Leitlinie für dieses Gespräch:");
  parts.push(
    "VORRANGREGEL: Die universellen Erstkontakt-, Transparenz-, Freiwilligkeits- und Datenschutzregeln im Hauptprompt stehen über dieser Topic Policy. Nutze die Topic Policy als Orientierung für Inhalt und Richtung, aber antworte immer situativ auf die letzte Kundenaussage und nicht als Skript.",
  );
  if (topic) parts.push(`THEMA: ${topic}`);
  if (callObjective) {
    parts.push("", "ZIEL DIESES ANRUFS:", callObjective);
  }
  if (topicSummary) {
    parts.push("", "WORUM ES BEI DIESEM THEMA GEHT UND WELCHEN NUTZEN DER INTERESSENT DAVON HAT:", topicSummary);
  }
  if (behavior) {
    parts.push("", "VERHALTEN & TONALITÄT (themenspezifisch):", behavior);
  }
  if (conversationGuardrails) {
    parts.push("", "THEMENSPEZIFISCHE GRENZEN & HINWEISE (nicht als Skript vorlesen):", conversationGuardrails);
  }
  if (requiredQuestions) {
    parts.push(
      "",
      "FRAGEN NACH TERMINBESTÄTIGUNG:",
      "Nach bestätigtem Termin führst du diese Fragen als Vorbereitung zuverlässig durch: eine Frage pro Turn, in der vorgegebenen Reihenfolge und ohne bereits beantwortete Fragen zu wiederholen. Erkläre bei sensiblen Daten kurz den Nutzen. Sagt der Kunde Nein, hat keine Zeit oder möchte keine weiteren Angaben machen, akzeptiere das sofort, beende die Fragerunde und vermerke die offenen Punkte für die Terminbestätigung:",
      requiredQuestions,
    );
  }
  if (exampleSentences) {
    parts.push(
      "",
      "BEISPIELFORMULIERUNGEN (nur sinngemäß verwenden, nicht mechanisch wiederholen):",
      exampleSentences,
    );
  }

  if (/private\s+krankenversicherung|pkv/i.test(topic)) {
    parts.push(
      "",
      "FLEXIBLER PKV-ORIENTIERUNGSRAHMEN (kein Skript und keine Pflichtreihenfolge):",
      "Nutze diese Punkte als fachliche Landkarte und wähle je nach Gespräch: Anlass und Beitragsentwicklung verständlich machen; bei echtem Interesse mit historischen und aktuellen Zahlen arbeiten; erklären, dass Herr Duic im Termin den Ist-Zustand und die mögliche Entwicklung anhand der persönlichen Zahlen prüft; danach ruhig zu Versicherungsstatus, aktuellem Beitrag und Termin führen. Der historische Einstiegsbeitrag ist niemals automatisch der aktuelle Monatsbeitrag. Wenn der Kunde eine eigene Frage, Geschichte oder einen Einwand einbringt, pausiert dieser Rahmen vollständig: zuerst die Kundenäußerung beantworten, dann nur bei natürlicher Gelegenheit zurückkehren. Beitragsentlastungstarife und mögliche steuerliche Gegenfinanzierung nur als mögliche Prüfoptionen nennen, niemals als Empfehlung oder Garantie. Nie mehrere Fragen in einem Turn und nie einen Themenwechsel, bevor der letzte Gedanke abgeschlossen ist.",
      "Nutze ausschließlich die Umlaute ä, ö und ü. Schreibe niemals ae, oe oder ue.",
    );
  }

  return parts.join("\n");
}
