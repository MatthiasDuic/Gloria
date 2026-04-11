import {
  BAV_TERMINIERUNG_SCRIPT,
  BKV_TERMINIERUNG_SCRIPT,
  ENERGIE_TERMINIERUNG_SCRIPT,
  GEWERBE_TERMINIERUNG_SCRIPT,
  PKV_TERMINIERUNG_SCRIPT,
} from "./call-scripts";
import type { CallScript } from "./call-scripts";
import { buildSystemPrompt } from "./gloria";
import type { ScriptConfig, Topic } from "./types";

const DETAIL_SCRIPTS: Record<Topic, CallScript> = {
  "betriebliche Krankenversicherung": BKV_TERMINIERUNG_SCRIPT,
  "betriebliche Altersvorsorge": BAV_TERMINIERUNG_SCRIPT,
  "gewerbliche Versicherungen": GEWERBE_TERMINIERUNG_SCRIPT,
  "private Krankenversicherung": PKV_TERMINIERUNG_SCRIPT,
  Energie: ENERGIE_TERMINIERUNG_SCRIPT,
};

const DEFAULT_SCRIPTS: Record<Topic, ScriptConfig> = {
  "betriebliche Krankenversicherung": {
    id: "skript-bkv-default",
    topic: "betriebliche Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an.",
    discovery: "Wie gehen Sie aktuell mit Mitarbeitergesundheit und Benefits um?",
    objectionHandling:
      "Das kann ich gut nachvollziehen. Genau deshalb ist der Termin bewusst kurz und unverbindlich gehalten.",
    close: "Passt Ihnen grundsätzlich eher ein Vormittag oder ein Nachmittag?",
  },
  "betriebliche Altersvorsorge": {
    id: "skript-bav-default",
    topic: "betriebliche Altersvorsorge",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an.",
    discovery: "Wie ist die betriebliche Altersvorsorge aktuell bei Ihnen aufgestellt?",
    objectionHandling:
      "Verstehe. Gerade deshalb lohnt sich oft ein kurzer, neutraler Überblick.",
    close: "Wann wäre ein kurzer Termin für Sie angenehmer?",
  },
  "gewerbliche Versicherungen": {
    id: "skript-gewerbe-default",
    topic: "gewerbliche Versicherungen",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an.",
    discovery: "Wann haben Sie Ihre gewerblichen Versicherungen zuletzt strukturiert überprüft?",
    objectionHandling:
      "Das ist völlig verständlich. Der Termin dient zunächst nur als neutrale Einordnung.",
    close: "Wäre dafür eher diese oder nächste Woche passend?",
  },
  "private Krankenversicherung": {
    id: "skript-pkv-default",
    topic: "private Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an.",
    discovery:
      "Ist das Thema Beitragsstabilität und Planbarkeit im Alter für Sie grundsätzlich interessant?",
    objectionHandling:
      "Das kann ich gut verstehen. Genau deshalb geht es zunächst nur um eine kurze Einordnung.",
    close: "Wann wäre ein kurzer Termin für Sie grundsätzlich angenehm?",
  },
  Energie: {
    id: "skript-energie-default",
    topic: "Energie",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an.",
    discovery: "Wie zufrieden sind Sie aktuell mit Ihren gewerblichen Energieverträgen?",
    objectionHandling:
      "Verstehe gut. Genau deshalb ist ein kurzer Vergleich oft sehr hilfreich.",
    close: "Wann passt Ihnen ein kurzer Termin besser?",
  },
};

export interface LiveAgentConfig {
  topic: Topic;
  agentName: string;
  objective: string;
  firstMessage: string;
  successCriteria: string[];
  recoveryPlaybook: string[];
  qualificationFields: string[];
  systemPrompt: string;
}

export function buildLiveAgentConfig(topic: Topic, script?: ScriptConfig): LiveAgentConfig {
  const detailScript = DETAIL_SCRIPTS[topic];
  const activeScript = script || DEFAULT_SCRIPTS[topic];

  const objectiveByTopic: Record<Topic, string> = {
    "betriebliche Krankenversicherung":
      "Interesse für bKV wecken und einen qualifizierten Kurztermin mit Herrn Duic sichern.",
    "betriebliche Altersvorsorge":
      "bAV als Arbeitgeber-Benefit relevant machen und direkt auf einen kurzen Beratungstermin hinführen.",
    "gewerbliche Versicherungen":
      "Vergleichsbedarf sichtbar machen und einen neutralen Analyse-Termin vereinbaren.",
    "private Krankenversicherung":
      "Beitragsstabilität und Planbarkeit im Alter greifbar machen und einen Vorqualifikations-Termin buchen.",
    Energie:
      "Einspar- oder Vergleichspotenzial klar benennen und einen kompakten Termin für die Prüfung vereinbaren.",
  };

  const successCriteria = [
    "Bevorzugtes Ziel: einen konkreten Termin mit Herrn Duic vereinbaren.",
    "Wenn noch kein Termin möglich ist: eine klare Wiedervorlage mit Zeitpunkt sichern.",
    "Wenn die Person nicht zuständig ist: korrekten Ansprechpartner oder direkte E-Mail erfragen.",
    "Jede Antwort soll auf den nächsten sinnvollen Schritt hinführen und nicht im Smalltalk hängen bleiben.",
  ];

  const recoveryPlaybook = [
    "Wenn der Interessent vom Skript abweicht, antworte kurz, menschlich und relevant – aber kehre dann aktiv zum Geschäftsanlass zurück.",
    "Bei unerwarteten Fragen: kurz beantworten, Nutzen herausstellen und direkt eine Anschlussfrage stellen.",
    "Bei Einwänden zuerst Verständnis zeigen, dann Mehrwert verdichten und wieder auf Termin oder Wiedervorlage führen.",
    "Verliere nie das Ziel aus dem Blick: Termin, Wiedervorlage oder korrekter Ansprechpartner.",
  ];

  const liveRules = [
    "LIVE-MODUS: Dies ist ein echtes Gespräch. Du darfst frei formulieren und vom Skript abweichen, solange du klar, freundlich und zielorientiert bleibst.",
    `Gesprächsziel für dieses Thema: ${objectiveByTopic[topic]}`,
    "Wenn der Gesprächspartner etwas Unerwartetes sagt, dann: 1) kurz bestätigen, 2) knapp beantworten, 3) elegant zurück zum relevanten Nutzen führen, 4) mit einer klaren Frage Richtung Termin oder Wiedervorlage abschließen.",
    "Halte Antworten kurz – meist 1 bis 3 Sätze. Keine langen Monologe.",
    "Wenn die Person zögert, biete immer eine kleine nächste Stufe an: kurzer Termin, Rückruf oder kurze Einordnung.",
    "Wenn du merkst, dass Details nicht sofort beantwortet werden möchten, vereinfache und sichere trotzdem den nächsten Schritt.",
    "Bei PKV: Wenn die Person Gesundheitsdetails nicht nennen möchte, frage nur noch: 'Würden Sie sagen, dass Sie derzeit grundsätzlich gesund sind?'",
    "Bleibe verkaufsstark und menschlich. Nicht diskutieren, sondern führen.",
  ];

  return {
    topic,
    agentName: "Gloria Live Agent",
    objective: objectiveByTopic[topic],
    firstMessage: activeScript.opener,
    successCriteria,
    recoveryPlaybook,
    qualificationFields: detailScript.dataCollection.fields,
    systemPrompt: [buildSystemPrompt(activeScript), ...liveRules].join("\n"),
  };
}

function generateRuleBasedReply(topic: Topic, prospectMessage: string, config: LiveAgentConfig) {
  const text = prospectMessage.toLowerCase();

  if (/kein interesse|nicht interessiert|brauchen wir nicht/.test(text)) {
    return "Verstehe ich gut. Gerade deshalb halte ich es ganz kurz: Es geht nur um eine kompakte Einordnung, ob das Thema für Sie überhaupt sinnvoll ist. Wäre dafür eher nächste Woche ein kurzer Termin passend?";
  }

  if (/keine zeit|später|gerade ungünstig|im stress/.test(text)) {
    return "Das kann ich gut nachvollziehen. Dann machen wir es Ihnen leicht und planen einfach einen kurzen Termin zu einem ruhigen Zeitpunkt – wäre kommende oder übernächste Woche angenehmer?";
  }

  if (/unterlagen|email|e-mail|schicken/.test(text)) {
    return "Gern schicke ich Ihnen Informationen zu. Erfahrungsgemäß ist eine kurze Einordnung aber deutlich hilfreicher als allgemeine Unterlagen. Wann hätten Sie 10 bis 15 Minuten Zeit, damit Herr Duic das passend für Ihre Situation einordnen kann?";
  }

  if (/nicht zuständig|falsche person/.test(text)) {
    return "Alles klar, danke Ihnen. Wer wäre denn bei Ihnen der richtige Ansprechpartner, damit ich das Thema direkt an die passende Stelle geben kann?";
  }

  if (topic === "private Krankenversicherung" && /daten|gesundheit|möchte ich nicht sagen|zu privat/.test(text)) {
    return "Das ist vollkommen in Ordnung. Wir müssen das jetzt nicht im Detail besprechen. Für die Terminvereinbarung reicht mir zunächst nur die kurze Einschätzung: Würden Sie sagen, dass Sie derzeit grundsätzlich gesund sind?";
  }

  if (/was genau|worum geht|erklären sie/.test(text)) {
    return `${config.objective} Ganz konkret geht es also um eine kurze, verständliche Einordnung. Darf ich Ihnen dafür direkt einen kurzen Termin mit Herrn Duic reservieren?`;
  }

  return `Verstehe. ${config.objective} Wenn es für Sie passt, gehen wir am besten den nächsten kleinen Schritt: Soll ich Ihnen dafür direkt einen kurzen Termin oder alternativ eine Wiedervorlage eintragen?`;
}

export async function generateAdaptiveReply(input: {
  topic: Topic;
  prospectMessage: string;
  transcript?: string;
  script?: ScriptConfig;
}) {
  const config = buildLiveAgentConfig(input.topic, input.script);

  if (!process.env.OPENAI_API_KEY) {
    return {
      mode: "rule-based",
      reply: generateRuleBasedReply(input.topic, input.prospectMessage, config),
      objective: config.objective,
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        temperature: 0.6,
        input: [
          {
            role: "system",
            content: [{ type: "input_text", text: config.systemPrompt }],
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: `Bisheriger Gesprächsverlauf:\n${input.transcript || "Noch kein weiterer Verlauf."}\n\nAussage des Interessenten:\n${input.prospectMessage}\n\nAntworte als Gloria in 1 bis 3 kurzen, natürlichen Sätzen und führe klar zum nächsten Schritt Richtung Termin oder Wiedervorlage.`,
              },
            ],
          },
        ],
      }),
      cache: "no-store",
    });

    const data = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(data.error?.message || "OpenAI-Antwort konnte nicht erzeugt werden.");
    }

    const outputText =
      data.output_text ||
      data.output
        ?.flatMap((item) => item.content || [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text || "")
        .join("\n")
        .trim();

    if (!outputText) {
      throw new Error("Leere KI-Antwort erhalten.");
    }

    return {
      mode: "openai",
      reply: outputText,
      objective: config.objective,
    };
  } catch {
    return {
      mode: "fallback",
      reply: generateRuleBasedReply(input.topic, input.prospectMessage, config),
      objective: config.objective,
    };
  }
}
