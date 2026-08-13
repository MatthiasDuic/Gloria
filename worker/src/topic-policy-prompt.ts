import { fetch } from "undici";
import { log } from "./log.js";

export type TopicPolicyFields = {
  topic?: string;
  topicSummary?: string;
  behavior?: string;
  conversationGuardrails?: string;
  requiredQuestions?: string;
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
  const topicSummary = (policy.topicSummary || "").trim();
  const behavior = (policy.behavior || "").trim();
  const conversationGuardrails = (policy.conversationGuardrails || "").trim();
  const requiredQuestions = (policy.requiredQuestions || "").trim();
  const exampleSentences = (policy.exampleSentences || "").trim();

  if (
    !topicSummary &&
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
      "PFLICHTFRAGEN IN TERMINIERUNGS-/VORBEREITUNGSPHASE:",
      "Diese Fragen muessen in der Terminierungs- oder Vorbereitungsphase gestellt werden. Wenn der Kunde sie nicht direkt beantworten moechte oder der Call vorher endet, muessen sie in die Terminbestaetigungsmail aufgenommen werden:",
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
      "VERBINDLICHE PKV-GESPRÄCHSSTRUKTUR:",
      "Halte diese Reihenfolge in jedem Erstgespräch ein: (1) Anlass erklären: Die Beiträge in der Gesundheitsversorgung steigen Jahr für Jahr; nach Angaben des PKV-Verbands liegen jährliche Beitragsanpassungen im Durchschnitt häufig bei etwa drei bis fünf Prozent. (2) Unternehmer und Selbstständige auf Planbarkeit ansprechen und fragen, wie stark sie diese Entwicklung bei sich spüren. (3) Fragen, mit welchem Beitrag der Kunde ursprünglich angefangen hat. Dieser historische Einstiegsbeitrag ist niemals der aktuelle Monatsbeitrag. (4) Das Konzept erklären: Im ersten Termin analysiert Herr Duic den Ist-Zustand anhand personenbezogener Daten, Vertragsdaten und historischer Entwicklungen und rechnet die Beitragsentwicklung bei gleichbleibender Entwicklung bis zum Ruhestand hoch. Fragen, ob der Kunde das schon einmal detailliert angeschaut hat. (5) Erst danach Versicherungsstatus und aktuellen Monatsbeitrag erfragen. (6) Nach dem aktuellen Monatsbeitrag unmittelbar eine konkrete Zehn-Jahres-Hochrechnung geben. (7) Das Ziel erklären: Heute Klarheit schaffen, welche Entscheidungen zu einem planbareren Beitrag im Alter beitragen können. (8) Keine Schnellabschluss-Sprache: Ersttermin = Kennenlernen, Ist-Analyse und grobe Einordnung; zweiter Termin = individuelles Konzept mit Hochrechnung und gegebenenfalls Tarifvergleich; dritter Termin = Abschluss und offene Fragen. (9) Beitragsentlastungstarife und mögliche steuerliche Gegenfinanzierung, zum Beispiel über eine Basisrente, nur als mögliche Prüfoptionen nennen, niemals als Empfehlung oder Garantie. Niemals direkt nach der Erlaubnisfrage mit \"privat oder gesetzlich\" beginnen.",
      "Nutze ausschließlich die Umlaute ä, ö und ü. Schreibe niemals ae, oe oder ue.",
    );
  }

  return parts.join("\n");
}
