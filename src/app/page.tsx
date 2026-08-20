"use client";

import Image from "next/image";
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { CrmSavedView, CrmUiPreferences, DashboardData, LearningResponse, TopicPolicyConfig, Topic } from "@/lib/types";
import { TOPICS } from "@/lib/types";
import topicPolicyDefaults from "../../data/topic-policies.json";

const SAMPLE_CSV = `company,contactName,phone,email,topic,note,nextCallAt
Musterbau GmbH,Herr Neumann,+49 2339 555100,neumann@musterbau.de,betriebliche Krankenversicherung,120 Mitarbeitende; Recruiting Thema,
Sprockhoevel Energieberatung,Frau Peters,+49 2324 555200,peters@se-beratung.de,Energie,Vertragsverlängerung in 90 Tagen,2026-04-15T10:00:00.000Z`;

const EMPTY_DATA: DashboardData = {
  leads: [],
  reports: [],
  topicPolicies: [],
  reportStorageMode: "file",
  topicPoliciesStorageMode: "file",
  metrics: {
    dialAttempts: 0,
    conversations: 0,
    appointments: 0,
    rejections: 0,
    callbacksOpen: 0,
    gatekeeperLoops: 0,
    transferSuccessRate: 0,
  },
};

const EMPTY_LEARNING: LearningResponse = {
  insights: [],
  globalSummary: [],
};

type TopicCategoryDefinition = {
  label: string;
  topics: string[];
};

type TopicGroup = {
  label: string;
  topics: string[];
};

const TOPIC_CATEGORY_DEFINITIONS: TopicCategoryDefinition[] = [
  {
    label: "Outbound Telefonie - Neukundenakquise",
    topics: [
      "betriebliche Krankenversicherung",
      "betriebliche Altersvorsorge",
      "private Krankenversicherung",
      "gewerbliche Versicherungen",
      "Energie",
    ],
  },
  {
    label: "Outbound Telefonie - Service",
    topics: ["Outbound Service (Kundenzufriedenheit)"],
  },
  {
    label: "Outbound Telefonie - Bestandskunden",
    topics: ["Outbound Bestandskunden (Jahresgespraech)"],
  },
  {
    label: "Inbound Telefonie",
    topics: ["Inbound Service (Anliegen und Tasks)"],
  },
];

const PLAYBOOK_CATEGORY_ALL = "Alle Kategorien";

function normalizeTopicKey(value: string) {
  return value.trim().toLowerCase();
}

function findTopicCategoryLabel(topic: string) {
  const key = normalizeTopicKey(topic);

  for (const category of TOPIC_CATEGORY_DEFINITIONS) {
    if (category.topics.some((entry) => normalizeTopicKey(entry) === key)) {
      return category.label;
    }
  }

  return "Eigene Themen";
}

function buildTopicGroups(topicList: string[]): TopicGroup[] {
  const uniqueTopics = Array.from(new Set(topicList.map((topic) => topic.trim()).filter(Boolean)));
  const remaining = new Set(uniqueTopics);
  const grouped: TopicGroup[] = [];

  for (const category of TOPIC_CATEGORY_DEFINITIONS) {
    const topicsInCategory = category.topics.filter((topic) => remaining.has(topic));
    if (topicsInCategory.length > 0) {
      grouped.push({ label: category.label, topics: topicsInCategory });
      for (const topic of topicsInCategory) {
        remaining.delete(topic);
      }
    }
  }

  const customTopics = Array.from(remaining).sort((a, b) => a.localeCompare(b, "de"));
  if (customTopics.length > 0) {
    grouped.push({ label: "Eigene Themen", topics: customTopics });
  }

  return grouped;
}

function formatDate(value?: string) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function normalizeComparableText(value?: string) {
  return (value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizePhoneDigits(value?: string) {
  return (value || "").replace(/\D+/g, "");
}

function ensureStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function phoneLooksEqual(a?: string, b?: string) {
  const left = normalizePhoneDigits(a);
  const right = normalizePhoneDigits(b);
  if (!left || !right) {
    return false;
  }
  if (left === right) {
    return true;
  }
  const shortLeft = left.length > 8 ? left.slice(-8) : left;
  const shortRight = right.length > 8 ? right.slice(-8) : right;
  return shortLeft === shortRight;
}

function formatOutcomeLabel(value?: string): string {
  const normalized = (value || "").trim();
  if (!normalized) return "–";
  if (/^termin$/i.test(normalized)) return "Termin";
  if (/^absage$/i.test(normalized)) return "Absage";
  if (/^wiedervorlage$/i.test(normalized)) return "Wiedervorlage";
  if (/kein\s*kontakt|nicht\s*erreicht|erreicht.*nicht/i.test(normalized)) return "Nicht erreicht / kein Kontakt";
  if (/gespraech\s*abgebrochen|abgebrochen/i.test(normalized)) return "Gespräch abgebrochen";
  return normalized;
}

function reportOutcomeBucket(report: DashboardData["reports"][number]): "no_contact" | "aborted" | "callback" | "appointment" | "rejection" {
  const outcome = (report.outcome || "").trim();
  if (/termin/i.test(outcome)) return "appointment";
  if (/wiedervorlage/i.test(outcome)) return "callback";
  if (/absage/i.test(outcome)) return "rejection";
  if (/gespraech\s*abgebrochen|abgebrochen/i.test(`${outcome} ${report.summary || ""}`)) return "aborted";
  return "no_contact";
}

function reportMatchesLead(
  report: DashboardData["reports"][number],
  lead: DashboardData["leads"][number],
) {
  if (report.leadId && report.leadId === lead.id) {
    return true;
  }

  const companyMatch =
    normalizeComparableText(report.company) === normalizeComparableText(lead.company);
  if (!companyMatch) {
    return false;
  }

  const contactMatch =
    normalizeComparableText(report.contactName) ===
    normalizeComparableText(lead.contactName);
  const phoneMatch = phoneLooksEqual(report.directDial, lead.directDial)
    || phoneLooksEqual(report.directDial, lead.phone);

  return contactMatch || phoneMatch || report.topic === lead.topic;
}

function getLeadAmpel(
  lead: DashboardData["leads"][number],
  leadReports: DashboardData["reports"],
) {
  const latestReport = [...leadReports].sort((a, b) => {
    const aTime = Date.parse(a.conversationDate || "") || 0;
    const bTime = Date.parse(b.conversationDate || "") || 0;
    return bTime - aTime;
  })[0];

  if (lead.status === "termin" || latestReport?.outcome === "Termin") {
    return { tone: "ok", label: "Gruen", text: "Termin vereinbart" };
  }

  if (lead.status === "absage" || latestReport?.outcome === "Absage") {
    return { tone: "danger", label: "Rot", text: "Absage / Auftrag beendet" };
  }

  if (
    lead.status === "wiedervorlage"
    || latestReport?.outcome === "Wiedervorlage"
    || Boolean(lead.nextCallAt)
    || Boolean(latestReport?.nextCallAt)
  ) {
    return { tone: "warn", label: "Gelb", text: "Wiedervorlage offen" };
  }

  if (lead.status === "angerufen" || leadReports.length > 0 || lead.attempts > 0) {
    return { tone: "info", label: "Blau", text: "In Bearbeitung" };
  }

  return { tone: "info", label: "Blau", text: "Offen / noch kein Kontakt" };
}

type CampaignRunPayload = {
  ok?: boolean;
  action?: "start" | "stop" | "run" | "delete";
  listId?: string;
  dialed?: boolean;
  skipped?: boolean;
  completed?: boolean;
  reason?: string;
  error?: string;
  call?: {
    sid?: string;
    to?: string;
    company?: string;
  };
};

function describeRunReason(reason?: string) {
  switch ((reason || "").toLowerCase()) {
    case "missing_phone":
      return "Lead ohne Telefonnummer";
    case "list_not_active":
      return "Liste ist nicht aktiv";
    case "cooldown":
      return "Cooldown zwischen zwei Anrufen aktiv";
    case "outside_business_hours":
      return "Außerhalb der Anrufzeiten";
    case "no_active_lists":
      return "Keine aktive Liste vorhanden";
    default:
      return reason || "Unbekannter Grund";
  }
}

function toDateKey(value: Date) {
  // Lokales Datum (nicht UTC), damit Kalenderzellen und Termine auf demselben
  // Tag landen. toISOString() würde 2026-05-13T22:00:00 lokal als 2026-05-13
  // (UTC) speichern, aber die Kalenderzelle für den 14.05 lokal hat als Key
  // den UTC-13.05 -> Termin würde einen Tag zu spät erscheinen.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function speakText(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "de-DE";

  const germanVoice = window.speechSynthesis
    .getVoices()
    .find((voice) => voice.lang.toLowerCase().startsWith("de"));

  if (germanVoice) {
    utterance.voice = germanVoice;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function buildConversationLines(summary: string) {
  return summary
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("Gloria:") || l.startsWith("Interessent:"))
    .map((l) => {
      const isGloria = l.startsWith("Gloria:");
      return { speaker: isGloria ? "Gloria" : "Interessent", text: l.replace(/^Gloria:|^Interessent:/, "").trim() };
    });
}

function readDocumentationField(summary: string, field: string): string | undefined {
  if (!summary) {
    return undefined;
  }

  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = summary.match(new RegExp(`^-\\s*${escaped}:\\s*(.+)$`, "mi"));
  return match?.[1]?.trim();
}

function reportHasRealConversation(report: DashboardData["reports"][number]): boolean {
  const summary = report.summary || "";
  const documentation = readDocumentationField(summary, "Gespraech stattgefunden");

  if (documentation) {
    return /ja/i.test(documentation);
  }

  const disposition = readDocumentationField(summary, "Einordnung");
  if (disposition) {
    const normalized = disposition.toLowerCase();
    if (normalized.includes("gespraech") && !normalized.includes("kein gespraech")) {
      return true;
    }
  }

  if (report.outcome !== "Nicht erreicht / kein Kontakt") {
    return true;
  }

  const lines = buildConversationLines(summary);
  const hasGloria = lines.some((line) => line.speaker === "Gloria");
  const hasUser = lines.some((line) => line.speaker === "Interessent");
  return hasGloria && hasUser;
}

function detectLostStage(summary: string): string {
  const t = summary.toLowerCase();
  if (t.includes("appt_slot_iso") || t.includes("appt_slot_label")) {
    return "Terminbestätigung – Interessent hat nach Terminvorschlag abgesagt";
  }
  if (t.includes("prep_mode") || t.includes("prep_short") || t.includes("wann passt")) {
    return "Terminvereinbarung – Abbruch beim Erfassen der Termindaten";
  }
  if (t.includes("problem_confirm_pending") || t.includes("stellen sie sich vor")) {
    return "Nutzenargumentation – Interessent hat Mehrwert nicht gesehen";
  }
  if (t.includes("discovery") || t.includes("wie zufrieden") || t.includes("was wäre für sie")) {
    return "Bedarfsermittlung – kein Interesse nach Bedarfsabfrage";
  }
  return "Gesprächseinstieg – Entscheider nicht oder kaum erreicht";
}

function pickText(value: string | undefined, fallback?: string) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return fallback ?? "";
}

const TOPIC_POLICY_EDITABLE_FIELDS: Array<keyof TopicPolicyConfig> = [
  "callObjective",
  "topicSummary",
  "behavior",
  "conversationGuardrails",
  "requiredQuestions",
  "exampleSentences",
  "gatekeeperTask",
  "gatekeeperBehavior",
  "receptionTopicReason",
  "decisionMakerTask",
  "decisionMakerBehavior",
  "decisionMakerContext",
  "appointmentGoal",
  "greetingGatekeeper",
  "greetingDecisionMaker",
  "reasonForCall",
  "relevanceQuestion",
  "contributionQuestion",
  "projectionText",
  "knowledge",
  "proofPoints",
  "objectionResponses",
  "transferHandling",
  "opener",
  "discovery",
  "objectionHandling",
  "close",
  "aiKeyInfo",
  "consentPrompt",
  "pkvHealthIntro",
  "pkvHealthQuestions",
  "problemBuildup",
  "conceptTransition",
  "appointmentConfirmation",
  "availableAppointmentSlots",
];

function countFilledTopicPolicyFields(config?: TopicPolicyConfig) {
  if (!config) {
    return 0;
  }

  return TOPIC_POLICY_EDITABLE_FIELDS.reduce((count, field) => {
    const value = config[field];
    return typeof value === "string" && value.trim().length > 0 ? count + 1 : count;
  }, 0);
}

function normalizeLineCount(value?: string) {
  return (value || "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean).length;
}

function getRecommendedTopicPolicyPreset(topic: Topic): Partial<TopicPolicyConfig> {
  const normalized = topic.trim().toLowerCase();
  const completeDefault = topicPolicyDefaults.find(
    (policy) => policy.topic.trim().toLowerCase() === normalized,
  );

  if (completeDefault) {
    return completeDefault;
  }

  const commonTransfer = [
    "Nur dann an einen Menschen weiterleiten, wenn der Interessent das ausdrücklich wünscht oder die KI klar ablehnt.",
    "Dann sagen: Gerne, ich verbinde Sie jetzt direkt mit Jutta Brost, unserer Vertriebsassistentin. Falls die Verbindung nicht sofort klappt, meldet sie sich kurzfristig bei Ihnen.",
    "Eine Weiterleitung nie ungefragt als Standardschritt anbieten.",
  ].join("\n");

  if (normalized === "private krankenversicherung") {
    return {
      topicSummary: [
        "Es geht darum, dem Interessenten greifbar zu machen, wie sich seine Krankenversicherungsbeitraege in den naechsten Jahren entwickeln koennen und welche Stellschrauben es fuer mehr Planbarkeit gibt.",
        "Der Nutzen des Termins ist keine Produktshow, sondern eine persoenliche Einordnung mit eigener Zahl, Zehn-Jahres-Blick und klaren Handlungsoptionen.",
      ].join("\n"),
      behavior: [
        "Warm, direkt und wie eine starke Vertriebsassistentin am Telefon sprechen - nicht wie ein Sprachcomputer.",
        "Erst kurz Relevanz und persoenlichen Nutzen erklaeren, dann fragen - nicht sofort in einen Fragenkatalog kippen.",
        "Gesagtes des Kunden aktiv aufgreifen und daran anschliessen, statt den naechsten Skriptpunkt abzuspulen.",
        "Kurz, charmant, professionell und auf Augenhoehe. Kein Callcenter-Ton.",
      ].join("\n"),
      conversationGuardrails: [
        "Kurze Dialogzüge: maximal zwei kurze Sätze und dann eine klare Frage.",
        "Keine direkte Terminierung, bevor Relevanz, Nutzen und persoenlicher Mehrwert fuer den Kunden klar ausgesprochen wurden.",
        "Keine erfundenen Quellen, keine garantierten Einsparungen und keine Aussagen wie immer guenstiger oder garantiert stabil.",
        "Wenn Pflichtfragen nicht direkt beantwortet werden, nicht druecken, sondern sauber in die Terminbestaetigungsmail uebernehmen.",
      ].join("\n"),
      requiredQuestions: [
        "Sind Sie aktuell privat oder gesetzlich versichert?",
        "In welcher Groessenordnung liegt Ihr aktueller Monatsbeitrag?",
        "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
        "Gibt es einen Punkt, den Herr Duic fuer den Termin besonders vorbereiten soll?",
      ].join("\n"),
    };
  }

  if (normalized === "betriebliche krankenversicherung") {
    return {
      topicSummary: "Es geht darum, dem Unternehmen kurz und klar zu zeigen, wie bKV bei Arbeitgeberattraktivitaet, Bindung und Mitarbeiterwert schaft. Der Termin dient als erste Einordnung, nicht als Produktverkauf.",
      behavior: "Klar, unternehmerisch und nutzenorientiert sprechen. Recruiting, Bindung und Mitarbeiterwahrnehmung frueh greifbar machen.",
      conversationGuardrails: [
        "Nicht in Tarifdetails oder Leistungsversprechen abrutschen.",
        "Keine Produktshow, sondern Relevanz für Recruiting, Bindung und Wahrnehmung als Arbeitgeber herausarbeiten.",
        "Einwände kurz, konkret und ohne Callcenter-Floskeln beantworten.",
        "Immer nur eine Hauptfrage gleichzeitig stellen.",
      ].join("\n"),
      requiredQuestions: [
        "Wie viele Mitarbeitende beschaeftigen Sie aktuell?",
        "Gibt es bei Ihnen aktuell eher Recruiting- oder Bindungsthemen?",
        "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
      ].join("\n"),
    };
  }

  if (normalized === "betriebliche altersvorsorge") {
    return {
      topicSummary: "Es geht um eine verstaendliche Einordnung, wie bAV fuer Arbeitgeber und Mitarbeitende sinnvoll genutzt werden kann und wo heute oft ungenutztes Potenzial liegt.",
      behavior: "Ruhig, verstaendlich und beratungsnah sprechen. Erst Nutzen und Klarheit, dann naechsten Schritt.",
      conversationGuardrails: [
        "Keine Steuer- oder Rechtsberatung im Einzelfall.",
        "Nicht in Fachchinesisch kippen; immer erst Nutzen und Verständlichkeit erklären.",
        "Keine Renditeversprechen.",
        "Kurze, führende Dialogschritte statt langer Erklärbären.",
      ].join("\n"),
      requiredQuestions: [
        "Gibt es bei Ihnen bereits eine bAV-Struktur oder ist das Thema noch offen?",
        "Geht es Ihnen eher um Arbeitgeberattraktivitaet oder um bestehende Vertragsanpassungen?",
        "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
      ].join("\n"),
    };
  }

  if (normalized === "gewerbliche versicherungen") {
    return {
      topicSummary: "Es geht um einen strukturierten Risiko- und Deckungscheck, damit der Interessent Klarheit ueber Aktualitaet, Luecken und moegliche Optimierung bekommt - ohne Wechselzwang.",
      behavior: "Unternehmerisch, ruhig und sehr konkret sprechen. Den Termin als Einordnung und Vergleich positionieren, nicht als Verkaufsdruck.",
      conversationGuardrails: [
        "Keine Angstkommunikation und keine Panikbilder.",
        "Den Termin als Einordnung und Vergleich positionieren, nicht als Verkaufsabschluss.",
        "Keine Deckungs- oder Beitragszusagen ohne Vertragsdaten.",
        "Auch bei Einwänden ruhig und unternehmerisch bleiben.",
      ].join("\n"),
      requiredQuestions: [
        "Wann wurde Ihre Absicherung zuletzt insgesamt geprueft?",
        "Geht es bei Ihnen eher um Beitrag, Leistung oder moegliche Luecken?",
        "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
      ].join("\n"),
    };
  }

  if (normalized === "energie") {
    return {
      topicSummary: "Es geht um eine wirtschaftliche Einordnung bestehender Energiekonditionen, damit der Interessent Transparenz ueber Kosten, Laufzeiten und moegliche Handlungsfenster bekommt.",
      behavior: "Sachlich, wirtschaftlich und kurz fuehren. Keine Tarifshow, sondern Klarheit ueber Beschaffung und Konditionen.",
      conversationGuardrails: [
        "Keine pauschalen Sparversprechen.",
        "Nicht spekulieren, wenn Lastprofil, Laufzeit oder Vertragsdetails fehlen.",
        "Immer wirtschaftlich, sachlich und knapp argumentieren.",
        "Kein Preisdruck, sondern Transparenz über Konditionen und Beschaffungszeitpunkt schaffen.",
      ].join("\n"),
      requiredQuestions: [
        "Wann laeuft Ihr aktueller Vertrag ungefaehr aus?",
        "Geht es aktuell eher um Strom, Gas oder beides?",
        "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
      ].join("\n"),
    };
  }

  if (normalized === "outbound service (kundenzufriedenheit)") {
    return {
      callObjective: "Kundenzufriedenheit nach dem Werkstattbesuch verlässlich messen, positives Feedback sichern und bei Problemen sofort eine interne Aufgabe auslösen.",
      behavior: [
        "Freundlich, neutral und serviceorientiert sprechen - ohne Verkaufsdruck.",
        "Kurz führen: Begruessung, Zufriedenheitsfrage, Ergebnis sichern, sauber abschliessen.",
        "Bei Kritik empathisch reagieren und gezielt nach dem Kernproblem fragen.",
      ].join("\n"),
      conversationGuardrails: [
        "Kein Verkauf, kein Upselling, keine Tarifdiskussion.",
        "Bewertung immer explizit als Zahl von 1 bis 5 erfassen.",
        "Bei 1-3 nicht relativieren, sondern Problem konkret aufnehmen.",
        "Immer dokumentieren, ob Rueckruf oder Eskalation gewuenscht ist.",
      ].join("\n"),
      requiredData: [
        "Darf ich kurz Ihren Namen zur Zuordnung abgleichen?",
        "Wie zufrieden waren Sie insgesamt mit Ihrem Werkstattbesuch auf einer Skala von 1 bis 5?",
        "Was lief gut, was duerfen wir verbessern?",
        "Wuenschen Sie einen Rueckruf vom Autohaus?",
        "Unter welcher Nummer und zu welcher Zeit sind Sie am besten erreichbar?",
      ].join("\n"),
      proofPoints: [
        "Jede Rueckmeldung innerhalb von 48 Stunden reduziert Reklamationseskalationen deutlich.",
        "Kunden mit aktiv aufgenommener Beschwerde bleiben signifikant loyaler als bei rein passiver Nachverfolgung.",
      ].join("\n"),
      objectionResponses: [
        "Keine Zeit: Verstehe ich gut, es dauert wirklich nur eine Minute - Ihre kurze Bewertung hilft dem Service-Team direkt.",
        "Alles okay: Perfekt, danke fuer die Rueckmeldung. Duerfte ich trotzdem kurz die 1-bis-5-Bewertung notieren?",
        "War schlecht: Danke fuer Ihre Offenheit. Was genau war der wichtigste Punkt, den wir sofort pruefen sollen?",
      ].join("\n"),
      knowledge: [
        "ERLAUBT:",
        "- Servicequalitaet abfragen und dokumentieren.",
        "- Bei Kritik aktiv Rueckruf/Task anbieten.",
        "",
        "VERBOTEN:",
        "- Verkaufsgespraeche starten.",
        "- Schuldzuweisungen oder technische Zusagen ohne Werkstattfreigabe.",
      ].join("\n"),
      transferHandling: "Bei Bewertung 1-3 oder expliziter Beschwerde immer einen Rueckruf-Task erstellen und Prioritaet mitgeben. Bei akuter Verunsicherung aktiv menschliche Uebergabe anbieten.",
    };
  }

  if (normalized === "outbound bestandskunden (jahresgespraech)") {
    return {
      callObjective: "Einen Termin fuer ein kurzes Jahresgespraech oder einen Vertragscheck vereinbaren; falls nicht moeglich eine verbindliche Wiedervorlage setzen.",
      behavior: [
        "Persoenlich, wertschätzend und auf Augenhoehe sprechen.",
        "Bestehende Beziehung anerkennen und den Nutzen eines kurzen Checks klar machen.",
        "Mit Auswahlfragen terminieren statt offenem Druck.",
      ].join("\n"),
      conversationGuardrails: [
        "Kein harter Verkaufston, Fokus auf Betreuung und Aktualitaet.",
        "Bei Zeitmangel aktiv Mini-Termin (10-15 Minuten) anbieten.",
        "Wenn aktuell kein Bedarf genannt wird, trotzdem Mehrwert des Jahreschecks kurz begruenden.",
      ].join("\n"),
      requiredData: [
        "Passt Ihnen eher Anfang oder Ende naechster Woche?",
        "Bevorzugen Sie Telefon, Video oder persoenlich?",
        "Welche E-Mail-Adresse sollen wir fuer die Bestaetigung nutzen?",
        "Gibt es ein Thema, das Herr Duic im Termin besonders vorbereiten soll?",
      ].join("\n"),
      proofPoints: [
        "Bei vielen Kunden aendern sich innerhalb eines Jahres Lebenssituation, Einkommen oder Leistungswuensche spuerbar.",
        "Ein 10-15-Minuten-Check verhindert haeufig, dass veraltete Vertragsstaende unbemerkt bleiben.",
      ].join("\n"),
      objectionResponses: [
        "Ich habe keine Zeit: Verstehe ich gut. Wir halten es bewusst kurz - 10 Minuten reichen fuer einen klaren Abgleich.",
        "Kein Bedarf: Kann gut sein. Genau deshalb machen wir den Jahrescheck: einmal bestaetigen, dass alles weiterhin passt.",
        "Bitte spaeter: Gerne. Welcher Tag passt Ihnen fuer eine verbindliche Wiedervorlage am besten?",
      ].join("\n"),
      knowledge: [
        "ERLAUBT:",
        "- Jahrescheck als Serviceleistung und Qualitaetssicherung positionieren.",
        "- Nutzen ueber Aktualitaet, Absicherung und Planbarkeit kommunizieren.",
        "",
        "VERBOTEN:",
        "- Abschlussdruck oder Angstkommunikation.",
      ].join("\n"),
      transferHandling: commonTransfer,
    };
  }

  if (normalized === "inbound service (anliegen und tasks)") {
    return {
      callObjective: "Anliegen im Erstkontakt loesen, andernfalls einen vollstaendigen Task mit Prioritaet, Rueckrufdaten und Zusammenfassung anlegen.",
      behavior: [
        "Hilfsbereit, strukturiert und ruhig sprechen.",
        "Anliegen zuerst klar klassifizieren: Schaden, Vertrag, Termin, Dokumente, Leistung, Sonstiges.",
        "Wenn keine Sofortloesung moeglich ist, aktiv Verantwortung uebernehmen und naechsten Schritt fixieren.",
      ].join("\n"),
      conversationGuardrails: [
        "Keine rechtlich verbindlichen Leistungszusagen am Telefon.",
        "Nur Informationen verwenden, die in der Wissensbasis oder den Topic Policies freigegeben sind.",
        "Bei sensiblen Faellen Rueckruf-Task mit Prioritaet setzen statt zu spekulieren.",
      ].join("\n"),
      requiredData: [
        "Worum geht es genau?",
        "Wie dringend ist das Anliegen fuer Sie (heute, diese Woche, normal)?",
        "Unter welcher Nummer koennen wir Sie am besten erreichen?",
        "Was waere fuer Sie das gewuenschte Ergebnis?",
      ].join("\n"),
      proofPoints: [
        "Klare Ticketzusammenfassungen mit Rueckrufzeit senken Nachfragen und Doppelkontakte deutlich.",
        "Die sofortige Erfassung von Dringlichkeit verbessert Reaktionszeiten in der Kundenbetreuung messbar.",
      ].join("\n"),
      objectionResponses: [
        "Ich brauche sofort jemanden: Ich nehme das direkt priorisiert auf und lasse schnellstmoeglich zurueckrufen.",
        "Nur per E-Mail: Gern, ich dokumentiere Ihr Anliegen jetzt und wir senden die Zusammenfassung zusaetzlich per Mail.",
        "Das ist kompliziert: Kein Problem, ich strukturiere das kurz mit Ihnen und uebergebe es dann passend weiter.",
      ].join("\n"),
      knowledge: [
        "ERLAUBT:",
        "- Oeffnungszeiten, Kontaktwege, Terminlogik und allgemeine Produktinfos aus den freigegebenen Quellen nennen.",
        "- Links fuer Schadenmeldung oder Dokumentanforderung anbieten.",
        "",
        "VERBOTEN:",
        "- Verbindliche Leistungszusagen ohne Pruefung.",
        "- Aussagen ausserhalb der freigegebenen Wissensbasis.",
      ].join("\n"),
      transferHandling: "Wenn Sofortloesung nicht moeglich ist, immer Task mit Anliegen, Prioritaet, Rueckrufnummer und kurzer Zusammenfassung erstellen. Bei eskalierten Faellen sofort menschliche Rueckmeldung priorisieren.",
    };
  }

  return {
    topicSummary: "Es geht um eine saubere Einordnung des Themas und einen klaren naechsten Schritt fuer den Interessenten.",
    behavior: "Kurz, professionell, charmant und fuehrend sprechen.",
    conversationGuardrails: "Kurze Dialogzüge, keine Monologe, keine erfundenen Fakten, immer nur eine Hauptfrage zur Zeit.",
    requiredQuestions: "Welche E-Mail-Adresse sollen wir fuer die Terminbestaetigung nutzen?",
  };
}

function buildDraftFromPreset(topic: Topic, existing?: Partial<TopicPolicyConfig>): TopicPolicyConfig {
  const preset = getRecommendedTopicPolicyPreset(topic);

  return {
    id: existing?.id || `topic-policy-${topic.toLowerCase().replace(/\s+/g, "-")}`,
    topic,
    callObjective: pickText(existing?.callObjective, preset.callObjective),
    topicSummary: pickText(existing?.topicSummary, preset.topicSummary),
    behavior: pickText(existing?.behavior, preset.behavior),
    conversationGuardrails: pickText(existing?.conversationGuardrails, preset.conversationGuardrails),
    requiredQuestions: pickText(existing?.requiredQuestions || existing?.requiredData, preset.requiredQuestions),
    exampleSentences: pickText(existing?.exampleSentences, ""),
    requiredData: pickText(existing?.requiredData, ""),
    knowledge: pickText(existing?.knowledge, ""),
    objectionResponses: pickText(existing?.objectionResponses, ""),
    proofPoints: pickText(existing?.proofPoints, ""),
    transferHandling: pickText(existing?.transferHandling, ""),
    greetingDecisionMaker: pickText(existing?.greetingDecisionMaker, ""),
    greetingGatekeeper: pickText(existing?.greetingGatekeeper, ""),
    reasonForCall: pickText(existing?.reasonForCall, ""),
    relevanceQuestion: pickText(existing?.relevanceQuestion, ""),
    contributionQuestion: pickText(existing?.contributionQuestion, ""),
    projectionText: pickText(existing?.projectionText, ""),
    opener: pickText(existing?.opener, ""),
    discovery: pickText(existing?.discovery, ""),
    objectionHandling: pickText(existing?.objectionHandling, ""),
    close: pickText(existing?.close, ""),
    aiKeyInfo: pickText(existing?.aiKeyInfo, ""),
    consentPrompt: pickText(
      existing?.consentPrompt,
      'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".',
    ),
    pkvHealthIntro: pickText(
      existing?.pkvHealthIntro,
      "Damit wir den Termin optimal vorbereiten koennen, muessen wir kurz ein paar Basisinformationen abklaeren.",
    ),
    pkvHealthQuestions: pickText(existing?.pkvHealthQuestions, ""),
    gatekeeperTask: pickText(existing?.gatekeeperTask, ""),
    gatekeeperBehavior: pickText(existing?.gatekeeperBehavior, ""),
    decisionMakerTask: pickText(existing?.decisionMakerTask, ""),
    decisionMakerBehavior: pickText(existing?.decisionMakerBehavior, ""),
    decisionMakerContext: pickText(existing?.decisionMakerContext, ""),
    appointmentGoal: pickText(existing?.appointmentGoal, ""),
    receptionTopicReason: pickText(existing?.receptionTopicReason, ""),
    problemBuildup: pickText(existing?.problemBuildup, ""),
    conceptTransition: pickText(existing?.conceptTransition, ""),
    appointmentConfirmation: pickText(existing?.appointmentConfirmation, ""),
    availableAppointmentSlots: pickText(existing?.availableAppointmentSlots, ""),
  };
}

function buildRecommendedAccountDraft(topic: Topic, existing?: TopicPolicyConfig): TopicPolicyConfig {
  const baseline = buildDraftFromPreset(topic, existing);
  const preset = getRecommendedTopicPolicyPreset(topic);

  return {
    ...baseline,
    ...preset,
    id: baseline.id,
    topic,
  };
}

function CollapsiblePanel({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  void defaultOpen;
  return (
    <section className="panel static-panel">
      <header className="panel-summary">
        <h2>{title}</h2>
      </header>
      <div className="panel-content">{children}</div>
    </section>
  );
}

interface LiveSessionRow {
  callSid?: string;
  company: string;
  topic: string;
  startedAt: string;
  lastEventAt: string;
  lastStep: string;
  lastEventType: string;
  contactRole?: "gatekeeper" | "decision-maker";
  turns: number;
  status: "aktiv" | "beendet";
  events: Array<{
    eventType: string;
    step: string;
    text?: string;
    createdAt: string;
    contactRole?: "gatekeeper" | "decision-maker";
    turn?: number;
  }>;
}

function LiveMonitorPanel() {
  const [sessions, setSessions] = useState<LiveSessionRow[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/live?minutes=15", { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as {
          sessions: LiveSessionRow[];
          activeCount: number;
          now: string;
        };
        if (cancelled) return;
        setSessions(payload.sessions || []);
        setActiveCount(payload.activeCount || 0);
        setLastUpdated(payload.now);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Fehler beim Laden");
      }
    }
    void load();
    const interval = setInterval(() => void load(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <CollapsiblePanel title="Live-Monitor" defaultOpen={false}>
      <div className="row" style={{ gap: 12, marginBottom: 10 }}>
        <span className="pill" style={{ background: activeCount > 0 ? "rgba(47,143,87,0.18)" : undefined }}>
          {activeCount} aktive Gespraech{activeCount === 1 ? "" : "e"}
        </span>
        <span className="subtle" style={{ fontSize: "0.85rem" }}>
          Fenster: letzte 15 Min - Auto-Refresh 5 s
          {lastUpdated ? ` - Stand: ${new Date(lastUpdated).toLocaleTimeString("de-DE")}` : ""}
        </span>
        {error && <span className="subtle" style={{ color: "#c24d4d", fontSize: "0.85rem" }}>- {error}</span>}
      </div>
      {sessions.length === 0 ? (
        <p className="subtle">Keine Gespraeche im aktuellen Zeitfenster.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Firma</th>
                <th>Thema</th>
                <th>Rolle</th>
                <th>Schritt</th>
                <th>Letztes Event</th>
                <th>Turns</th>
                <th>Aktualisiert</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const key = s.callSid || `${s.company}-${s.startedAt}`;
                const isOpen = expanded === key;
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>
                        <span className={`status ${s.status === "beendet" ? "absage" : ""}`}>{s.status}</span>
                      </td>
                      <td><strong>{s.company}</strong></td>
                      <td>{s.topic}</td>
                      <td>{s.contactRole || "-"}</td>
                      <td>{s.lastStep}</td>
                      <td><code>{s.lastEventType}</code></td>
                      <td>{s.turns}</td>
                      <td>{new Date(s.lastEventAt).toLocaleTimeString("de-DE")}</td>
                      <td>
                        <button className="btn ghost" onClick={() => setExpanded(isOpen ? null : key)}>
                          {isOpen ? "Zuklappen" : "Verlauf"}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={9}>
                          <div style={{ maxHeight: 220, overflowY: "auto", padding: "8px 4px", background: "#f5f8fd", borderRadius: 6 }}>
                            {s.events.slice().reverse().map((e, idx) => (
                              <div key={idx} style={{ display: "grid", gridTemplateColumns: "90px 150px 140px 1fr", gap: 8, padding: "3px 0", fontSize: "0.85rem" }}>
                                <span className="subtle">{new Date(e.createdAt).toLocaleTimeString("de-DE")}</span>
                                <span><code>{e.eventType}</code></span>
                                <span>{e.step}</span>
                                <span>{e.text ? e.text.slice(0, 180) : ""}</span>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsiblePanel>
  );
}

export default function HomePage() {
  type SessionUser = {
    id: string;
    username: string;
    role: "master" | "user";
    realName: string;
    companyName: string;
    calendarFeedToken?: string;
    selectedVoiceId?: string;
    allowedPlaybookTopics?: string[];
  };

  type AdminUser = {
    id: string;
    username: string;
    role: "master" | "user";
    realName: string;
    companyName: string;
    address?: string;
    email?: string;
    realPhone?: string;
    gesellschaft?: string;
    createdAt?: string;
    phoneNumbers?: ManagedPhoneNumber[];
    selectedVoiceId?: string;
    allowedPlaybookTopics?: string[];
  };

  type ManagedPhoneNumber = {
    id: string;
    userId: string;
    phoneNumber: string;
    label: string;
    active: boolean;
  };

  type CampaignListSummary = {
    listId: string;
    listName: string;
    active: boolean;
    currentlyDialing?: boolean;
    total: number;
    pending: number;
    called: number;
    appointments: number;
    callbacks: number;
    rejections: number;
  };

  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [csvText, setCsvText] = useState(SAMPLE_CSV);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importListName, setImportListName] = useState("");
  const [importTopic, setImportTopic] = useState<Topic | "">(TOPICS[0]);
  const [detailTopic, setDetailTopic] = useState<Topic>(TOPICS[0]);
  const [playbookCategoryFilter, setPlaybookCategoryFilter] = useState<string>(PLAYBOOK_CATEGORY_ALL);
  const [voiceTopic, setVoiceTopic] = useState<Topic>(TOPICS[0]);
  const [voicePreview, setVoicePreview] = useState("");
  const [voiceAudioUrl, setVoiceAudioUrl] = useState("");
  const [availableVoices, setAvailableVoices] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [learning, setLearning] = useState<LearningResponse>(EMPTY_LEARNING);
  const [anrufEinzelfirmaTarget, setAnrufEinzelfirmaTarget] = useState("");
  const [anrufEinzelfirmaCompany, setAnrufEinzelfirmaCompany] = useState("Musterbau GmbH");
  const [anrufEinzelfirmaContactName, setAnrufEinzelfirmaContactName] = useState("Herr Neumann");
  const [anrufEinzelfirmaTopic, setAnrufEinzelfirmaTopic] = useState<Topic>(TOPICS[0]);
  const [anrufEinzelfirmaFromOptions, setAnrufEinzelfirmaFromOptions] = useState<Array<{ id?: string; number: string; label: string }>>([]);
  const [anrufEinzelfirmaFrom, setAnrufEinzelfirmaFrom] = useState("");
  const [currentUser, setCurrentUser] = useState<SessionUser | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [managedPhoneNumbers, setManagedPhoneNumbers] = useState<ManagedPhoneNumber[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRealName, setNewRealName] = useState("");
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRealPhone, setNewRealPhone] = useState("");
  const [newGesellschaft, setNewGesellschaft] = useState("");
  const [newRole, setNewRole] = useState<"master" | "user">("user");
  const [newPhoneUserId, setNewPhoneUserId] = useState("");
  const [newPhoneNumber, setNewPhoneNumber] = useState("");
  const [newPhoneLabel, setNewPhoneLabel] = useState("");
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    username: string;
    realName: string;
    companyName: string;
    address: string;
    email: string;
    realPhone: string;
    gesellschaft: string;
    role: "master" | "user";
    password: string;
    assignedPhone: string;
    assignedLabel: string;
    selectedVoiceId: string;
    allowedPlaybookTopics: string[];
  } | null>(null);
  const [notice, setNotice] = useState("Dashboard wird geladen ...");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [draftScripts, setDraftScripts] = useState<Record<string, TopicPolicyConfig>>({});
  const [newTopicInput, setNewTopicInput] = useState("");
  const [showNewTopicForm, setShowNewTopicForm] = useState(false);
  const [selectedReport, setSelectedReport] = useState<DashboardData["reports"][number] | null>(null);
  const [selectedLeadForHistory, setSelectedLeadForHistory] = useState<DashboardData["leads"][number] | null>(null);
  const [leadSearch, setLeadSearch] = useState("");
  const [leadStatusFilter, setLeadStatusFilter] = useState("");
  const [crmTab, setCrmTab] = useState<"customers" | "pipeline" | "callbacks">("customers");
  const [crmSearch, setCrmSearch] = useState("");
  const [crmTypeFilter, setCrmTypeFilter] = useState<"" | "BarmeniaGothaer" | "Agentur-Duic">("");
  const [crmCustomerKindFilter, setCrmCustomerKindFilter] = useState<"" | "privat" | "firma">("");
  const [crmPipelineFilter, setCrmPipelineFilter] = useState<"" | "neu" | "qualifiziert" | "angebot" | "verhandlung" | "gewonnen" | "verloren">("");
  const [crmContactFilter, setCrmContactFilter] = useState<"" | "mitEmail" | "ohneEmail" | "mitTelefon">("");
  const [selectedCrmLeads, setSelectedCrmLeads] = useState<Set<string>>(new Set());
  const [showAddCustomerModal, setShowAddCustomerModal] = useState(false);
  const [addCustomerDraft, setAddCustomerDraft] = useState({
    company: "", contactName: "", phone: "", email: "", topic: "" as Topic | "", customerType: "Agentur-Duic" as "BarmeniaGothaer" | "Agentur-Duic", customerKind: "firma" as "privat" | "firma", addressStreet: "", addressPostalCode: "", addressCity: "", addressCountry: "Deutschland", productsInput: "", note: "",
  });
  const [showCampaignFromSelectionModal, setShowCampaignFromSelectionModal] = useState(false);
  const [showCrmImport, setShowCrmImport] = useState(false);
  const [crmImportFile, setCrmImportFile] = useState<File | null>(null);
  const [crmImportListName, setCrmImportListName] = useState("");
  const [crmImportTopic, setCrmImportTopic] = useState<Topic | "">("" as Topic | "");
  const [crmImportCustomerType, setCrmImportCustomerType] = useState<"BarmeniaGothaer" | "Agentur-Duic">("Agentur-Duic");
  const [campaignFromSelectionName, setCampaignFromSelectionName] = useState("");
  const [campaignFromSelectionTopic, setCampaignFromSelectionTopic] = useState<Topic>(TOPICS[0]);
  const [detailDraft, setDetailDraft] = useState<Partial<DashboardData["leads"][number]> | null>(null);
  const [crmDetailTab, setCrmDetailTab] = useState<"stammdaten" | "pipeline" | "historie" | "kommunikation" | "termine" | "aufgaben">("stammdaten");
  const [leadTaskDraft, setLeadTaskDraft] = useState({ title: "", dueAt: "" });
  const [outlookMailDraft, setOutlookMailDraft] = useState({ subject: "", body: "", to: "", sentAt: "" });
  const [selectedListForEvaluation, setSelectedListForEvaluation] = useState<CampaignListSummary | null>(null);
  const [crmSavedViews, setCrmSavedViews] = useState<CrmSavedView[]>([]);
  const [crmViewNameDraft, setCrmViewNameDraft] = useState("");
  const [crmPrefsReady, setCrmPrefsReady] = useState(false);
  const [transcriptEvents, setTranscriptEvents] = useState<Array<{
    id: string;
    speaker: "Gloria" | "Interessent";
    text: string;
    latencyMs?: number;
    spokenAt?: string;
    createdAt: string;
  }>>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  useEffect(() => {
    const callSid = selectedReport?.callSid?.trim();
    if (!callSid) {
      setTranscriptEvents([]);
      return;
    }
    let cancelled = false;
    setTranscriptLoading(true);
    fetch(`/api/reports/transcript?callSid=${encodeURIComponent(callSid)}`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`http ${res.status}`);
        return res.json();
      })
      .then((data: { events?: typeof transcriptEvents }) => {
        if (cancelled) return;
        setTranscriptEvents(Array.isArray(data.events) ? data.events : []);
      })
      .catch(() => {
        if (cancelled) return;
        setTranscriptEvents([]);
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedReport?.callSid]);
  const [saveStatus, setSaveStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  void settingsOpen; void setSettingsOpen;
  const [activeView, setActiveView] = useState<"overview" | "calls" | "leads" | "calendar" | "crm" | "settings" | "compliance">("overview");
  const [leadNoteEdit, setLeadNoteEdit] = useState<string>("");
  useEffect(() => { setLeadNoteEdit(selectedLeadForHistory?.note || ""); }, [selectedLeadForHistory]);
  useEffect(() => {
    if (!selectedLeadForHistory) return;
    const latestLead = data.leads.find((lead) => lead.id === selectedLeadForHistory.id);
    if (latestLead && latestLead !== selectedLeadForHistory) {
      setSelectedLeadForHistory(latestLead);
    }
  }, [data.leads, selectedLeadForHistory]);
  useEffect(() => {
    if (!selectedLeadForHistory) {
      setDetailDraft(null);
      setCrmDetailTab("stammdaten");
      setLeadTaskDraft({ title: "", dueAt: "" });
      setOutlookMailDraft({ subject: "", body: "", to: "", sentAt: "" });
      return;
    }
    setCrmDetailTab("stammdaten");
    setLeadTaskDraft({ title: "", dueAt: "" });
    setDetailDraft({
      customerKind: selectedLeadForHistory.customerKind || "firma",
      customerOwner: selectedLeadForHistory.customerOwner,
      contactName: selectedLeadForHistory.contactName,
      phone: selectedLeadForHistory.phone,
      directDial: selectedLeadForHistory.directDial,
      email: selectedLeadForHistory.email,
      location: selectedLeadForHistory.location,
      addressStreet: selectedLeadForHistory.addressStreet,
      addressPostalCode: selectedLeadForHistory.addressPostalCode,
      addressCity: selectedLeadForHistory.addressCity,
      addressCountry: selectedLeadForHistory.addressCountry,
      products: selectedLeadForHistory.products,
      crmPipeline: selectedLeadForHistory.crmPipeline,
      topic: selectedLeadForHistory.topic,
      note: selectedLeadForHistory.note,
    });
    setOutlookMailDraft({
      subject: "",
      body: "",
      to: selectedLeadForHistory.email || "",
      sentAt: "",
    });
  }, [selectedLeadForHistory]);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDayKey, setSelectedDayKey] = useState(() => toDateKey(new Date()));
  const [campaignLists, setCampaignLists] = useState<CampaignListSummary[]>([]);
  const [runningListIds, setRunningListIds] = useState<string[]>([]);
  const blockedOutboundNumbers = useMemo(() => new Set(["+18446290030"]), []);

  function normalizePhoneNumber(value?: string) {
    return String(value || "").replace(/[\s()-]/g, "").trim();
  }

  const activeDraft = draftScripts[detailTopic];
  const playbookTopicOptions = useMemo(
    () => Array.from(new Set([...TOPICS, ...Object.keys(draftScripts)])),
    [draftScripts],
  );
  const playbookTopicGroups = useMemo(
    () => buildTopicGroups(playbookTopicOptions),
    [playbookTopicOptions],
  );
  const playbookCategoryTabs = useMemo(
    () => [PLAYBOOK_CATEGORY_ALL, ...playbookTopicGroups.map((group) => group.label)],
    [playbookTopicGroups],
  );
  const playbookCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set(PLAYBOOK_CATEGORY_ALL, playbookTopicOptions.length);
    for (const group of playbookTopicGroups) {
      counts.set(group.label, group.topics.length);
    }
    return counts;
  }, [playbookTopicGroups, playbookTopicOptions.length]);
  const visiblePlaybookTopicGroups = useMemo(
    () =>
      playbookCategoryFilter === PLAYBOOK_CATEGORY_ALL
        ? playbookTopicGroups
        : playbookTopicGroups.filter((group) => group.label === playbookCategoryFilter),
    [playbookCategoryFilter, playbookTopicGroups],
  );
  const visiblePlaybookTopics = useMemo(
    () => visiblePlaybookTopicGroups.flatMap((group) => group.topics),
    [visiblePlaybookTopicGroups],
  );
  const detailTopicCategory = useMemo(
    () => findTopicCategoryLabel(detailTopic),
    [detailTopic],
  );
  const currentUserAllowedTopics = useMemo(
    () => ensureStringArray(currentUser?.allowedPlaybookTopics),
    [currentUser?.allowedPlaybookTopics],
  );
  const voiceTopicOptions = useMemo(
    () => Array.from(
      new Set(
        (currentUserAllowedTopics.length
          ? currentUserAllowedTopics
          : [...TOPICS])
          .map((topic) => String(topic).trim())
          .filter(Boolean),
      ),
    ),
    [currentUserAllowedTopics],
  );
  const voiceTopicGroups = useMemo(
    () => buildTopicGroups(voiceTopicOptions),
    [voiceTopicOptions],
  );

  useEffect(() => {
    if (playbookCategoryFilter === PLAYBOOK_CATEGORY_ALL) {
      return;
    }

    if (visiblePlaybookTopics.includes(detailTopic)) {
      return;
    }

    if (visiblePlaybookTopics.length > 0) {
      setDetailTopic(visiblePlaybookTopics[0]);
    }
  }, [playbookCategoryFilter, visiblePlaybookTopics, detailTopic]);
  const reportRows = useMemo(() => data.reports, [data.reports]);
  const appointmentReports = useMemo(
    () =>
      data.reports.filter(
        (report) =>
          Boolean(report.appointmentAt) &&
          // Kalender immer nur eigene Termine, auch fuer Master.
          (!currentUser || !report.userId || report.userId === currentUser.id),
      ),
    [data.reports, currentUser],
  );
  const appointmentsByDay = useMemo(() => {
    const grouped = new Map<string, DashboardData["reports"]>();

    for (const report of appointmentReports) {
      if (!report.appointmentAt) {
        continue;
      }

      const dayKey = toDateKey(new Date(report.appointmentAt));
      const existing = grouped.get(dayKey) || [];
      grouped.set(dayKey, [...existing, report]);
    }

    for (const [key, reports] of grouped) {
      grouped.set(
        key,
        [...reports].sort((a, b) => {
          const aTime = a.appointmentAt ? Date.parse(a.appointmentAt) : 0;
          const bTime = b.appointmentAt ? Date.parse(b.appointmentAt) : 0;
          return aTime - bTime;
        }),
      );
    }

    return grouped;
  }, [appointmentReports]);

  const reportingInsights = useMemo(() => {
    const reports = data.reports;
    const total = reports.length;
    const realConversations = reports.filter((report) => reportHasRealConversation(report)).length;
    const appointments = reports.filter((r) => reportOutcomeBucket(r) === "appointment").length;
    const rejections = reports.filter((r) => reportOutcomeBucket(r) === "rejection").length;
    const callbacks = reports.filter((r) => reportOutcomeBucket(r) === "callback").length;
    const aborted = reports.filter((r) => reportOutcomeBucket(r) === "aborted").length;
    const noContact = reports.filter((r) => reportOutcomeBucket(r) === "no_contact").length;
    const noContactWithConversation = reports.filter(
      (r) => reportOutcomeBucket(r) === "no_contact" && reportHasRealConversation(r),
    ).length;
    const noConversation = total - realConversations;
    const contacts = total - noContact - aborted;
    const contactRate = total > 0 ? Math.round((contacts / total) * 100) : 0;
    const appointmentRate = contacts > 0 ? Math.round((appointments / contacts) * 100) : 0;
    const rejectionRate = contacts > 0 ? Math.round((rejections / contacts) * 100) : 0;

    const byTopic = new Map<string, { total: number; termin: number; absage: number; wiedervorlage: number; keinKontakt: number }>();
    for (const r of reports) {
      const entry = byTopic.get(r.topic) || { total: 0, termin: 0, absage: 0, wiedervorlage: 0, keinKontakt: 0 };
      entry.total++;
      if (r.outcome === "Termin") entry.termin++;
      else if (r.outcome === "Absage") entry.absage++;
      else if (r.outcome === "Wiedervorlage") entry.wiedervorlage++;
      else if (r.outcome === "Nicht erreicht / kein Kontakt") entry.keinKontakt++;
      byTopic.set(r.topic, entry);
    }
    const topicStats = Array.from(byTopic.entries())
      .map(([topic, stats]) => ({
        topic,
        ...stats,
        terminRate: stats.total > 0 ? Math.round((stats.termin / stats.total) * 100) : 0,
      }))
      .sort((a, b) => b.total - a.total);

    const reasonBuckets: Array<{ label: string; match: RegExp }> = [
      { label: "Kein Interesse", match: /kein\s*interesse|nicht\s*interessiert/i },
      { label: "Bereits versorgt / anderer Anbieter", match: /bereits|schon\s*versichert|vorhanden|anderer\s*anbieter|haben\s*schon/i },
      { label: "Keine Zeit / spaeter", match: /keine\s*zeit|zu\s*besch(ae|ä)ftigt|sp(ae|ä)ter|momentan\s*nicht/i },
      { label: "Kein Budget / zu teuer", match: /kein\s*budget|zu\s*teuer|kosten\s*zu\s*hoch/i },
      { label: "Keine Werbeanrufe", match: /werbung|werbeanruf|nicht\s*anrufen|keine\s*anrufe/i },
      { label: "Falscher Ansprechpartner", match: /falsch|nicht\s*zust(ae|ä)ndig|nicht\s*der\s*richtige/i },
      { label: "Entscheidung bereits gefallen", match: /entscheidung\s*gefallen|entschieden|festgelegt/i },
    ];
    const reasonCounts = reasonBuckets.map((b) => ({ label: b.label, count: 0 }));
    let reasonOther = 0;
    for (const r of reports.filter((x) => x.outcome === "Absage")) {
      const s = r.summary || "";
      let matched = false;
      reasonBuckets.forEach((b, i) => {
        if (b.match.test(s)) {
          reasonCounts[i].count++;
          matched = true;
        }
      });
      if (!matched) reasonOther++;
    }
    const topRejections = [...reasonCounts, { label: "Sonstige / Unspezifisch", count: reasonOther }]
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count);

    const days: Array<{ key: string; label: string; gespraeche: number; termine: number; absagen: number }> = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      days.push({
        key: toDateKey(d),
        label: d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }),
        gespraeche: 0,
        termine: 0,
        absagen: 0,
      });
    }
    const dayIndex = new Map(days.map((d, i) => [d.key, i] as const));
    for (const r of reports) {
      if (!r.conversationDate) continue;
      const key = toDateKey(new Date(r.conversationDate));
      const idx = dayIndex.get(key);
      if (idx === undefined) continue;
      days[idx].gespraeche++;
      if (r.outcome === "Termin") days[idx].termine++;
      else if (r.outcome === "Absage") days[idx].absagen++;
    }
    const peakDayGespraeche = Math.max(1, ...days.map((d) => d.gespraeche));

    return {
      total,
      realConversations,
      noConversation,
      noContactWithConversation,
      contacts,
      appointments,
      rejections,
      callbacks,
      aborted,
      noContact,
      contactRate,
      appointmentRate,
      rejectionRate,
      topicStats,
      topRejections,
      days,
      peakDayGespraeche,
    };
  }, [data.reports]);

  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
    const firstWeekday = (firstOfMonth.getDay() + 6) % 7;
    const start = new Date(firstOfMonth);
    start.setDate(firstOfMonth.getDate() - firstWeekday);

    return Array.from({ length: 42 }).map((_, index) => {
      const day = new Date(start);
      day.setDate(start.getDate() + index);
      const key = toDateKey(day);
      return {
        key,
        date: day,
        inMonth: day.getMonth() === calendarMonth.getMonth(),
        items: appointmentsByDay.get(key) || [],
      };
    });
  }, [appointmentsByDay, calendarMonth]);
  const selectedDayAppointments = useMemo(
    () => appointmentsByDay.get(selectedDayKey) || [],
    [appointmentsByDay, selectedDayKey],
  );
  const runningListSet = useMemo(() => new Set(runningListIds), [runningListIds]);
  const selectedLeadReports = useMemo(() => {
    if (!selectedLeadForHistory) {
      return [] as DashboardData["reports"];
    }

    return [...data.reports]
      .filter((report) => reportMatchesLead(report, selectedLeadForHistory))
      .sort((a, b) => {
        const aTime = Date.parse(a.conversationDate || "") || 0;
        const bTime = Date.parse(b.conversationDate || "") || 0;
        return bTime - aTime;
      });
  }, [data.reports, selectedLeadForHistory]);
  const leadAmpelById = useMemo(() => {
    const result: Record<string, ReturnType<typeof getLeadAmpel>> = {};
    for (const lead of data.leads) {
      const reportsForLead = data.reports.filter((report) => reportMatchesLead(report, lead));
      result[lead.id] = getLeadAmpel(lead, reportsForLead);
    }
    return result;
  }, [data.leads, data.reports]);

  const assignedPhoneOptions = useMemo(() => {
    const byNumber = new Map<string, { number: string; label: string }>();

    for (const entry of managedPhoneNumbers) {
      if (!entry.phoneNumber) continue;
      if ([...blockedOutboundNumbers].some((blocked) => normalizePhoneNumber(blocked) === normalizePhoneNumber(entry.phoneNumber))) continue;
      byNumber.set(entry.phoneNumber, {
        number: entry.phoneNumber,
        label: entry.label || entry.phoneNumber,
      });
    }

    for (const entry of anrufEinzelfirmaFromOptions) {
      if (!entry.number) continue;
      if ([...blockedOutboundNumbers].some((blocked) => normalizePhoneNumber(blocked) === normalizePhoneNumber(entry.number))) continue;
      if (!byNumber.has(entry.number)) {
        byNumber.set(entry.number, {
          number: entry.number,
          label: entry.label || entry.number,
        });
      }
    }

    return Array.from(byNumber.values());
  }, [managedPhoneNumbers, anrufEinzelfirmaFromOptions, blockedOutboundNumbers]);

  async function loadDashboard(): Promise<DashboardData | null> {
    try {
      const [dashboardResponse, learningResponse] = await Promise.all([
        fetch("/api/reports", { cache: "no-store" }),
        fetch("/api/learning", { cache: "no-store" }),
      ]);
      if (!dashboardResponse.ok) throw new Error(`Reports konnten nicht geladen werden (HTTP ${dashboardResponse.status}).`);
      if (!learningResponse.ok) throw new Error(`Learning konnte nicht geladen werden (HTTP ${learningResponse.status}).`);

      const payload = (await dashboardResponse.json()) as DashboardData;
      const learningPayload = (await learningResponse.json()) as LearningResponse;

      setData(payload);
      setLearning(learningPayload);
      const nextDrafts = payload.topicPolicies.reduce<Record<string, TopicPolicyConfig>>((acc, script) => {
        acc[script.topic] = buildDraftFromPreset(script.topic, script);
        return acc;
      }, {});

      // Keep the settings area available even if one topic has no persisted script yet.
      for (const topic of TOPICS) {
        if (!nextDrafts[topic]) {
          nextDrafts[topic] = buildDraftFromPreset(topic);
        }
      }

      setDraftScripts(nextDrafts);
      setNotice(
        `Aktueller Stand: ${payload.metrics.appointments} Termin(e), ${payload.metrics.callbacksOpen} offene Wiedervorlage(n).`,
      );
      return payload;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Dashboard konnte nicht geladen werden.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  const loadCampaignLists = useCallback(async () => {
    try {
      const response = await fetch("/api/campaigns/lists", { cache: "no-store" });
      const payload = (await response.json()) as { lists?: CampaignListSummary[] };
      if (response.ok) {
        const lists = payload.lists || [];
        setCampaignLists(lists);
        setRunningListIds((current) => {
          const next = new Set(current);
          for (const list of lists) {
            if (list.active) {
              next.add(list.listId);
            }
          }
          for (const listId of [...next]) {
            if (!lists.some((entry) => entry.listId === listId)) {
              next.delete(listId);
            }
          }
          return [...next];
        });
      } else {
        setNotice(`Kampagnenlisten konnten nicht geladen werden (HTTP ${response.status}).`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Kampagnenlisten konnten nicht geladen werden.");
    }
  }, []);

  const loadSessionAndAdminData = useCallback(async () => {
    try {
      const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
      const mePayload = (await meResponse.json().catch(() => ({}))) as { user?: SessionUser };
      if (!meResponse.ok || !mePayload.user) return;

      setCurrentUser(mePayload.user);

      const crmViewsResponse = await fetch("/api/crm/views", { cache: "no-store" });
      const crmViewsPayload = (await crmViewsResponse.json().catch(() => ({}))) as { views?: CrmSavedView[] };
      if (crmViewsResponse.ok) {
        setCrmSavedViews(Array.isArray(crmViewsPayload.views) ? crmViewsPayload.views.slice(0, 20) : []);
      } else {
        setCrmSavedViews([]);
      }

      const crmPrefsResponse = await fetch("/api/crm/preferences", { cache: "no-store" });
      const crmPrefsPayload = (await crmPrefsResponse.json().catch(() => ({}))) as { preferences?: CrmUiPreferences };
      if (crmPrefsResponse.ok && crmPrefsPayload.preferences) {
        const prefs = crmPrefsPayload.preferences;
        if (prefs.crmTab) setCrmTab(prefs.crmTab);
        if (prefs.crmDetailTab) setCrmDetailTab(prefs.crmDetailTab);
        if (typeof prefs.crmSearch === "string") setCrmSearch(prefs.crmSearch);
        if (prefs.crmTypeFilter !== undefined) setCrmTypeFilter(prefs.crmTypeFilter);
        if (prefs.crmCustomerKindFilter !== undefined) setCrmCustomerKindFilter(prefs.crmCustomerKindFilter);
        if (prefs.crmPipelineFilter !== undefined) setCrmPipelineFilter(prefs.crmPipelineFilter);
        if (prefs.crmContactFilter !== undefined) setCrmContactFilter(prefs.crmContactFilter);
      }
      setCrmPrefsReady(true);

    const voicesResponse = await fetch("/api/voices", { cache: "no-store" });
    const voicesPayload = (await voicesResponse.json().catch(() => ({}))) as {
      voices?: Array<{ id: string; name: string }>;
      selectedVoiceId?: string;
    };
    if (voicesResponse.ok) {
      setAvailableVoices(voicesPayload.voices || []);
      setSelectedVoiceId(voicesPayload.selectedVoiceId || "");
    }

    const phoneResponse = await fetch("/api/admin/phone-numbers", { cache: "no-store" });
    const phonePayload = (await phoneResponse.json().catch(() => ({}))) as {
      phoneNumbers?: ManagedPhoneNumber[];
    };
    if (phoneResponse.ok) {
      setManagedPhoneNumbers(phonePayload.phoneNumbers || []);
    }

      if (mePayload.user.role === "master") {
        const usersResponse = await fetch("/api/admin/users", { cache: "no-store" });
        const usersPayload = (await usersResponse.json().catch(() => ({}))) as { users?: AdminUser[] };
        if (usersResponse.ok) {
          setAdminUsers(usersPayload.users || []);
        }
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Kontodaten konnten nicht geladen werden.");
    }
  }, []);

  async function persistCrmSavedViews(nextViews: CrmSavedView[]) {
    const response = await fetch("/api/crm/views", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ views: nextViews.slice(0, 20) }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; views?: CrmSavedView[] };
    if (!response.ok) {
      throw new Error(payload.error || "CRM-Ansichten konnten nicht gespeichert werden.");
    }
    return Array.isArray(payload.views) ? payload.views.slice(0, 20) : nextViews.slice(0, 20);
  }

  async function persistCrmUiPreferences(nextPreferences: CrmUiPreferences) {
    const response = await fetch("/api/crm/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: nextPreferences }),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "CRM-Layout konnte nicht gespeichert werden.");
    }
  }

  useEffect(() => {
    if (!currentUser || !crmPrefsReady) return;
    const timer = setTimeout(() => {
      void persistCrmUiPreferences({
        crmTab,
        crmDetailTab,
        crmSearch,
        crmTypeFilter,
        crmCustomerKindFilter,
        crmPipelineFilter,
        crmContactFilter,
      }).catch(() => {
        // Avoid interrupting UX with noisy autosave messages.
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [
    crmCustomerKindFilter,
    crmContactFilter,
    crmDetailTab,
    crmPipelineFilter,
    crmPrefsReady,
    crmSearch,
    crmTab,
    crmTypeFilter,
    currentUser,
  ]);

  useEffect(() => {
    void loadDashboard();
    void loadCampaignLists();
    void loadSessionAndAdminData();
  }, [loadCampaignLists, loadSessionAndAdminData]);

  useEffect(() => {
    let cancelled = false;

    async function refreshReports() {
      if (document.visibilityState !== "visible") return;

      try {
        const response = await fetch("/api/reports", { cache: "no-store" });
        if (!response.ok) return;

        const payload = (await response.json()) as DashboardData;
        if (!cancelled) {
          setData(payload);
        }
      } catch {
        // The next polling cycle retries without interrupting the current workflow.
      }
    }

    const interval = window.setInterval(() => void refreshReports(), 5_000);
    const handleVisibilityChange = () => void refreshReports();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    if (!currentUser || currentUser.role !== "master") return;
    if (newPhoneUserId) return;
    const firstUser = adminUsers.find((entry) => entry.role === "user") || adminUsers[0];
    if (firstUser?.id) {
      setNewPhoneUserId(firstUser.id);
    }
  }, [adminUsers, currentUser, newPhoneUserId]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/telnyx/call-options", { cache: "no-store" });
        const payload = (await response.json()) as {
          fromOptions?: Array<{ id?: string; number: string; label: string }>;
          defaultFrom?: string;
        };

        if (!response.ok) {
          return;
        }

        const fromOptions = payload.fromOptions || [];
        setAnrufEinzelfirmaFromOptions(fromOptions);
        setAnrufEinzelfirmaFrom(payload.defaultFrom || fromOptions[0]?.number || "");
      } catch {
        // Optional UI data; keep call form usable even if this fetch fails.
      }
    })();
  }, []);

  function downloadSampleCsv() {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8;" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = "gloria-muster-import.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
  }

  async function handleCsvImport() {
    setBusy(true);

    try {
      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvText,
          listName: importListName.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        imported?: number;
        error?: string;
        listName?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "CSV konnte nicht importiert werden.");
      }

      setNotice(`Liste "${payload.listName || importListName || "Import"}" importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Import fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFileImport() {
    if (!importFile) {
      setNotice("Bitte zuerst eine CSV- oder Excel-Datei auswählen.");
      return;
    }

    setBusy(true);
    setNotice(`Dateiimport läuft (${importFile.name}) ...`);

    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const formData = new FormData();
      formData.set("file", importFile);
      formData.set("listName", importListName.trim() || importFile.name.replace(/\.[^.]+$/, ""));
      if (importTopic && importTopic !== "") {
        formData.set("topic", importTopic);
      }

      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 45_000);

      const response = await fetch("/api/campaigns/import", {
        method: "POST",
        body: formData,
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (timeout) {
        clearTimeout(timeout);
      }

      const raw = await response.text();
      const payload = ((() => {
        try {
          return JSON.parse(raw) as {
            imported?: number;
            error?: string;
            listName?: string;
          };
        } catch {
          return {} as {
            imported?: number;
            error?: string;
            listName?: string;
          };
        }
      })()) as {
        imported?: number;
        error?: string;
        listName?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || raw || "Datei konnte nicht importiert werden.");
      }

      setNotice(`Liste "${payload.listName || importListName || importFile.name}" importiert: ${payload.imported ?? 0} neue Firmen in Gloria geladen.`);
      setImportFile(null);
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Dateiimport fehlgeschlagen.",
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      setBusy(false);
    }
  }

  async function controlCampaignList(listId: string, action: "start" | "stop" | "delete") {
    if (action === "delete") {
      const confirmed = confirm("Moechten Sie diese Liste wirklich loeschen? Alle zugehoerigen Firmen werden entfernt.");
      if (!confirmed) {
        return;
      }
    }

    setBusy(true);
    try {
      const response = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, listId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        lists?: CampaignListSummary[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Liste konnte nicht aktualisiert werden.");
      }

      setCampaignLists(payload.lists || []);
      if (action === "start") {
        setRunningListIds((current) => (current.includes(listId) ? current : [...current, listId]));
        setNotice("Liste wurde gestartet. Erster Anrufversuch wird ausgelöst ...");

        const runResponse = await fetch("/api/campaigns/lists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "run", listId }),
        });
        const runPayload = (await runResponse.json().catch(() => ({}))) as CampaignRunPayload & {
          lists?: CampaignListSummary[];
        };

        if (!runResponse.ok) {
          throw new Error(runPayload.error || "Erster Anrufversuch konnte nicht gestartet werden.");
        }

        if (Array.isArray(runPayload.lists)) {
          setCampaignLists(runPayload.lists);
        }

        if (runPayload.dialed && runPayload.call?.sid) {
          setNotice(
            `Anruf gestartet (${runPayload.call.company || "Firma"}, ${runPayload.call.to || "-"}, SID: ${runPayload.call.sid}).`,
          );
        } else if (runPayload.completed) {
          setNotice("Liste ist abgearbeitet und wurde automatisch gestoppt.");
        } else if (runPayload.skipped) {
          setNotice(`Anruf übersprungen: ${describeRunReason(runPayload.reason)}.`);
        }
      } else if (action === "stop") {
        setRunningListIds((current) => current.filter((id) => id !== listId));
        setNotice("Liste wurde gestoppt.");
      } else {
        setRunningListIds((current) => current.filter((id) => id !== listId));
        setNotice("Liste wurde geloescht.");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Aktion fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const activeLists = campaignLists.filter((list) => list.active);

    if (activeLists.length === 0) {
      return;
    }

    const timer = setInterval(() => {
      void (async () => {
        for (const list of activeLists) {
          const response = await fetch("/api/campaigns/lists", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "run", listId: list.listId }),
          }).catch(() => undefined);

          if (!response) {
            continue;
          }

          const payload = (await response.json().catch(() => ({}))) as CampaignRunPayload;

          if (!response.ok) {
            setNotice(
              payload.error
                ? `Anruffehler in Liste "${list.listName}": ${payload.error}`
                : `Anruffehler in Liste "${list.listName}".`,
            );
            continue;
          }

          if (payload.dialed && payload.call?.sid) {
            setNotice(
              `Anruf läuft: ${payload.call.company || list.listName} (${payload.call.to || "-"}) · SID ${payload.call.sid}`,
            );
          } else if (payload.skipped && payload.reason && payload.reason !== "list_not_active") {
            setNotice(`Liste "${list.listName}": ${describeRunReason(payload.reason)}.`);
          }
        }
        await loadCampaignLists();
        await loadDashboard();
      })();
    }, 15000);

    return () => clearInterval(timer);
  }, [campaignLists, loadCampaignLists]);

  async function applyLearning(topic: Topic) {
    const confirmed = confirm(
      `Möchten Sie die vorgeschlagenen Optimierungen für "${topic}" übernehmen?`,
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch("/api/learning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Optimierung konnte nicht angewendet werden.");
      }

      setNotice(`Gloria hat die Topic Policy für ${topic} anhand der Gesprächsreports optimiert.`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Selbstoptimierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function optimizeWithAI(topic: Topic) {
    setBusy(true);
    try {
      const previewRes = await fetch("/api/learning/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const preview = (await previewRes.json()) as {
        error?: string;
        optimized?: {
          topicSummary: string;
          behavior: string;
          conversationGuardrails: string;
          requiredQuestions: string;
          rationale: string[];
          source: string;
        };
      };
      if (!previewRes.ok || !preview.optimized) {
        throw new Error(preview.error || "Vorschau fehlgeschlagen.");
      }
      const opt = preview.optimized;
      const rationale = opt.rationale.length ? `\n\nBegruendung:\n- ${opt.rationale.join("\n- ")}` : "";
      const confirmed = confirm(
        `KI-Optimierung fuer "${topic}" (${opt.source}):\n\n` +
          `Thema & Nutzen: ${opt.topicSummary.slice(0, 180)}${opt.topicSummary.length > 180 ? "..." : ""}\n\n` +
          `Verhalten & Ton: ${opt.behavior.slice(0, 180)}${opt.behavior.length > 180 ? "..." : ""}` +
          rationale +
          "\n\nIn die Topic Policy uebernehmen?",
      );
      if (!confirmed) {
        setNotice("Optimierung verworfen.");
        return;
      }
      const applyRes = await fetch("/api/learning/optimize?apply=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const applied = (await applyRes.json()) as { error?: string };
      if (!applyRes.ok) throw new Error(applied.error || "Uebernahme fehlgeschlagen.");
      setNotice(`KI-optimierte Topic Policy fuer ${topic} gespeichert (${opt.source}).`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "KI-Optimierung fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function persistPlaybookDraft(draft: TopicPolicyConfig) {
    const requestPayload = {
      id: draft.id,
      topic: draft.topic,
      callObjective: draft.callObjective || "",
      topicSummary: draft.topicSummary || "",
      behavior: draft.behavior || "",
      conversationGuardrails: draft.conversationGuardrails || "",
      requiredQuestions: draft.requiredQuestions || "",
      exampleSentences: draft.exampleSentences || "",
      gatekeeperTask: draft.gatekeeperTask || "",
      gatekeeperBehavior: draft.gatekeeperBehavior || "",
      receptionTopicReason: draft.receptionTopicReason || "",
      decisionMakerTask: draft.decisionMakerTask || "",
      decisionMakerBehavior: draft.decisionMakerBehavior || "",
      decisionMakerContext: draft.decisionMakerContext || "",
      appointmentGoal: draft.appointmentGoal || "",
      greetingGatekeeper: draft.greetingGatekeeper || "",
      greetingDecisionMaker: draft.greetingDecisionMaker || "",
      reasonForCall: draft.reasonForCall || "",
      relevanceQuestion: draft.relevanceQuestion || "",
      contributionQuestion: draft.contributionQuestion || "",
      projectionText: draft.projectionText || "",
      requiredData: draft.requiredData || "",
      knowledge: draft.knowledge || "",
      proofPoints: draft.proofPoints || "",
      objectionResponses: draft.objectionResponses || "",
      transferHandling: draft.transferHandling || "",
      opener: draft.opener || "",
      discovery: draft.discovery || "",
      objectionHandling: draft.objectionHandling || "",
      close: draft.close || "",
      aiKeyInfo: draft.aiKeyInfo || "",
      consentPrompt: draft.consentPrompt || "",
      pkvHealthIntro: draft.pkvHealthIntro || "",
      pkvHealthQuestions: draft.pkvHealthQuestions || "",
      problemBuildup: draft.problemBuildup || "",
      conceptTransition: draft.conceptTransition || "",
      appointmentConfirmation: draft.appointmentConfirmation || "",
      availableAppointmentSlots: draft.availableAppointmentSlots || "",
    };

    const response = await fetch("/api/topic-policies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestPayload),
    });
    const payload = (await response.json()) as {
      error?: string;
      storageMode?: "postgres" | "file";
    };

    if (!response.ok) {
      throw new Error(payload.error || "Topic Policy konnte nicht gespeichert werden.");
    }

    return payload;
  }

  async function saveScript(topic: Topic) {
    const draft = draftScripts[topic];

    if (!draft) {
      return;
    }

    setBusy(true);
    setSaveStatus(null);

    try {
      const payload = await persistPlaybookDraft(draft);
      setNotice(
        `Topic Policy für ${topic} gespeichert und für Gloria übernommen. Gespeichert in ${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}.`,
      );
      setSaveStatus({
        type: "success",
        message: `Erfolgreich gespeichert (${payload.storageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}).`,
      });
      await loadDashboard();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Topic Policy speichern fehlgeschlagen.";
      setNotice(errorMessage);
      setSaveStatus({ type: "error", message: errorMessage });
    } finally {
      setBusy(false);
    }
  }

  async function applyRecommendedPlaybooksToAccount() {
    const availableTopics = Array.from(
      new Set(
        (currentUserAllowedTopics.length
          ? currentUserAllowedTopics
          : [...TOPICS, ...Object.keys(draftScripts)])
          .map((topic) => topic.trim())
          .filter(Boolean),
      ),
    );

    if (availableTopics.length === 0) {
      setNotice("Es wurden keine Topic-Policy-Themen für dieses Konto gefunden.");
      return;
    }

    setBusy(true);
    setSaveStatus(null);

    try {
      const nextDrafts = { ...draftScripts };
      let lastStorageMode: "postgres" | "file" = "file";

      for (const topic of availableTopics) {
        const nextDraft = buildRecommendedAccountDraft(topic, nextDrafts[topic]);
        nextDrafts[topic] = nextDraft;
        const payload = await persistPlaybookDraft(nextDraft);
        lastStorageMode = payload.storageMode || lastStorageMode;
      }

      setDraftScripts(nextDrafts);
      setNotice(
        `Empfohlene Gloria-Standards für ${availableTopics.length} Thema/Themen auf dieses Konto übernommen (${lastStorageMode === "postgres" ? "PostgreSQL" : "Datei-Fallback"}).`,
      );
      setSaveStatus({
        type: "success",
        message: `Empfohlene Standards fuer ${availableTopics.length} Thema/Themen gespeichert.`,
      });
      await loadDashboard();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Empfohlene Standards konnten nicht gespeichert werden.";
      setNotice(errorMessage);
      setSaveStatus({ type: "error", message: errorMessage });
    } finally {
      setBusy(false);
    }
  }

  function handleAddNewTopic() {
    const topic = newTopicInput.trim();
    if (!topic) return;
    setDraftScripts((c) => ({
      ...c,
      [topic]: buildDraftFromPreset(topic),
    }));
    setDetailTopic(topic);
    setNewTopicInput("");
    setShowNewTopicForm(false);
  }

  async function testVoice() {
    setBusy(true);

    setVoicePreview("Vorschau wird geladen ...");
    setVoiceAudioUrl("");

    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: voiceTopic, voiceId: selectedVoiceId || undefined }),
      });

      const payload = (await response.json()) as {
        preview?: string;
        provider?: "elevenlabs";
        audioBase64?: string;
        audioMimeType?: string;
        message?: string;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || payload.message || "Stimmtest konnte nicht geladen werden.");
      }

      setVoicePreview(payload.preview || "Keine Vorschau verfügbar.");

      if (payload.audioBase64 && payload.audioMimeType) {
        const url = `data:${payload.audioMimeType};base64,${payload.audioBase64}`;
        setVoiceAudioUrl(url);
        void new Audio(url).play().catch(() => undefined);
      } else {
        setVoiceAudioUrl("");
        speakText(payload.preview || "");
      }

      setNotice(payload.message || `Stimmtest für ${voiceTopic} gestartet.`);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `${error.message} - die Textvorschau konnte nicht geladen werden.`
          : "Stimmtest konnte nicht geladen werden.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function startAnrufEinzelfirma() {
    if (!anrufEinzelfirmaTarget.trim()) {
      setNotice("Bitte zuerst eine Zielnummer im internationalen Format eingeben, z. B. +492339123456.");
      return;
    }

    setBusy(true);

    try {
      const selectedFrom = anrufEinzelfirmaFromOptions.find((option) => option.number === anrufEinzelfirmaFrom);
      const response = await fetch("/api/telnyx/test-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: anrufEinzelfirmaTarget,
          company: anrufEinzelfirmaCompany,
          contactName: anrufEinzelfirmaContactName,
          topic: anrufEinzelfirmaTopic,
          from: anrufEinzelfirmaFrom || undefined,
          phoneNumberId: selectedFrom?.id,
        }),
      });

      const payload = (await response.json()) as {
        error?: string;
        sid?: string;
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Anruf Einzelfirma konnte nicht gestartet werden.");
      }

      setNotice(`${payload.message || "Anruf gestartet."} SID: ${payload.sid || "-"}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Anruf fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteReport(reportId: string) {
    if (!confirm("Report wirklich komplett löschen? Diese Aktion kann nicht rückgängig gemacht werden.")) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(
        `/api/reports?reportId=${encodeURIComponent(reportId)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        throw new Error("Report konnte nicht gelöscht werden.");
      }

      setNotice("Report erfolgreich gelöscht.");
      setSelectedReport(null);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  function getCrmCustomerType(lead: DashboardData["leads"][number]): "BarmeniaGothaer" | "Agentur-Duic" | "Unbekannt" {
    if (lead.customerOwner === "BarmeniaGothaer" || lead.customerOwner === "Agentur-Duic") {
      return lead.customerOwner;
    }
    const listName = (lead.listName || "").toLowerCase();
    if (/barmen|gothaer/.test(listName)) return "BarmeniaGothaer";
    if (/agentur[-\s]?duic/.test(listName)) return "Agentur-Duic";
    // Fall back to listId prefix convention set at import time
    const listId = (lead.listId || "").toLowerCase();
    if (/barmen|gothaer/.test(listId)) return "BarmeniaGothaer";
    if (/agentur|duic/.test(listId)) return "Agentur-Duic";
    return "Unbekannt";
  }

  function splitProductsInput(value: string): string[] {
    return value
      .split(/[;,|\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function getLeadPipelineStage(lead: DashboardData["leads"][number]) {
    if (lead.crmPipeline?.stage) return lead.crmPipeline.stage;
    if (lead.status === "termin") return "gewonnen" as const;
    if (lead.status === "absage") return "verloren" as const;
    if (lead.status === "angerufen") return "qualifiziert" as const;
    if (lead.status === "wiedervorlage") return "verhandlung" as const;
    return "neu" as const;
  }

  async function saveCurrentCrmSearch() {
    const name = crmViewNameDraft.trim() || `Suche ${new Date().toLocaleDateString("de-DE")}`;
    if (!name) {
      setNotice("Bitte einen Namen für die Suche angeben.");
      return;
    }
    const entry: CrmSavedView = {
      id: `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      search: crmSearch,
      owner: crmTypeFilter,
      customerKind: crmCustomerKindFilter,
      pipelineStage: crmPipelineFilter,
      contactFilter: crmContactFilter,
      createdAt: new Date().toISOString(),
    };
    const nextViews = [entry, ...crmSavedViews.filter((view) => view.name !== name)].slice(0, 20);
    try {
      const persisted = await persistCrmSavedViews(nextViews);
      setCrmSavedViews(persisted);
      setCrmViewNameDraft("");
      setNotice(`Suche "${name}" gespeichert.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Suche konnte nicht gespeichert werden.");
    }
  }

  function getListTrafficLight(params: { pending: number; active: boolean; currentlyDialing?: boolean; runningList: boolean }) {
    if (params.currentlyDialing || params.active || params.runningList) {
      return { color: "blue", label: "Blau", text: "Gloria telefoniert gerade in dieser Liste." };
    }
    if (params.pending <= 0) {
      return { color: "green", label: "Gruen", text: "Liste vollständig bearbeitet." };
    }
    return { color: "red", label: "Rot", text: "Liste ist offen, wird aktuell nicht bearbeitet." };
  }

  async function addCustomerManually() {
    const d = addCustomerDraft;
    const company = d.company.trim();
    const phone = d.phone.trim();
    if (!company || !phone) {
      setNotice("Firma und Telefonnummer sind Pflichtfelder.");
      return;
    }
    setBusy(true);
    try {
      const csvRow = `customerOwner,customerKind,company,contactName,phone,email,addressStreet,addressPostalCode,addressCity,addressCountry,products,topic,note\n"${d.customerType}","${d.customerKind}","${company.replace(/"/g, '""')}","${d.contactName.replace(/"/g, '""')}","${phone.replace(/"/g, '""')}","${d.email.replace(/"/g, '""')}","${d.addressStreet.replace(/"/g, '""')}","${d.addressPostalCode.replace(/"/g, '""')}","${d.addressCity.replace(/"/g, '""')}","${d.addressCountry.replace(/"/g, '""')}","${d.productsInput.replace(/"/g, '""')}","${d.topic}","${d.note.replace(/"/g, '""')}"`;
      const listName = `${d.customerType} | Manuell hinzugefügt`;
      const res = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText: csvRow, listName }),
      });
      const payload = (await res.json()) as { imported?: number; error?: string };
      if (!res.ok) throw new Error(payload.error || "Import fehlgeschlagen");
      setNotice(`Kunde "${company}" angelegt.`);
      setShowAddCustomerModal(false);
      setAddCustomerDraft({ company: "", contactName: "", phone: "", email: "", topic: "", customerType: "Agentur-Duic", customerKind: "firma", addressStreet: "", addressPostalCode: "", addressCity: "", addressCountry: "Deutschland", productsInput: "", note: "" });
      setCrmSearch("");
      setCrmTypeFilter("");
      setCrmCustomerKindFilter("");
      setCrmPipelineFilter("");
      setCrmContactFilter("");
      setCrmTab("customers");
      const refreshed = await loadDashboard();
      await loadCampaignLists();

      if (refreshed) {
        const normalizedPhone = phone.replace(/\s+/g, "");
        const createdLead = refreshed.leads.find((lead) => {
          const byCompany = lead.company.trim().toLowerCase() === company.toLowerCase();
          const candidatePhone = (lead.phone || lead.directDial || "").replace(/\s+/g, "");
          return byCompany && candidatePhone === normalizedPhone;
        }) || refreshed.leads.find((lead) => lead.company.trim().toLowerCase() === company.toLowerCase());

        if (createdLead) {
          setCrmSearch(createdLead.company);
          setSelectedLeadForHistory(createdLead);
        }
      }
    } catch (e) { setNotice(e instanceof Error ? e.message : "Fehler"); }
    finally { setBusy(false); }
  }

  async function createCampaignFromSelection() {
    if (selectedCrmLeads.size === 0 || !campaignFromSelectionName.trim()) return;
    setBusy(true);
    try {
      const selected = data.leads.filter(l => selectedCrmLeads.has(l.id));
      const rows = selected.map(l =>
        `"${(l.customerOwner || getCrmCustomerType(l) || "").replace(/"/g, '""')}","${(l.customerKind || "").replace(/"/g, '""')}","${(l.company || "").replace(/"/g, '""')}","${(l.contactName || "").replace(/"/g, '""')}","${l.phone || l.directDial || ""}","${l.email || ""}","${(l.addressStreet || "").replace(/"/g, '""')}","${(l.addressPostalCode || "").replace(/"/g, '""')}","${(l.addressCity || "").replace(/"/g, '""')}","${(l.addressCountry || "").replace(/"/g, '""')}","${(l.products || []).join("; ").replace(/"/g, '""')}","${campaignFromSelectionTopic}","${(l.note || "").replace(/"/g, '""')}"`
      );
      const csvText = `customerOwner,customerKind,company,contactName,phone,email,addressStreet,addressPostalCode,addressCity,addressCountry,products,topic,note\n${rows.join("\n")}`;
      const res = await fetch("/api/campaigns/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csvText, listName: campaignFromSelectionName }),
      });
      const payload = (await res.json()) as { imported?: number; error?: string };
      if (!res.ok) throw new Error(payload.error || "Fehler beim Erstellen");
      setNotice(`Kampagne "${campaignFromSelectionName}" mit ${payload.imported ?? selected.length} Kontakten erstellt.`);
      setShowCampaignFromSelectionModal(false);
      setSelectedCrmLeads(new Set());
      setCampaignFromSelectionName("");
      await loadDashboard();
      await loadCampaignLists();
    } catch (e) { setNotice(e instanceof Error ? e.message : "Fehler"); }
    finally { setBusy(false); }
  }

  async function exportSelectedCustomers() {
    if (selectedCrmLeads.size === 0) return;
    const selected = data.leads.filter((lead) => selectedCrmLeads.has(lead.id));
    if (selected.length === 0) return;
    const header = [
      "customerOwner",
      "customerKind",
      "company",
      "contactName",
      "phone",
      "directDial",
      "email",
      "addressStreet",
      "addressPostalCode",
      "addressCity",
      "addressCountry",
      "products",
      "topic",
      "status",
      "note",
      "listName",
    ];
    const rows = selected.map((lead) => [
      lead.customerOwner || getCrmCustomerType(lead),
      lead.customerKind || "firma",
      lead.company,
      lead.contactName || "",
      lead.phone || "",
      lead.directDial || "",
      lead.email || "",
      lead.addressStreet || "",
      lead.addressPostalCode || "",
      lead.addressCity || lead.location || "",
      lead.addressCountry || "",
      (lead.products || []).join("; "),
      lead.topic,
      lead.status,
      lead.note || "",
      lead.listName || "",
    ]);
    const csvText = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `crm-kunden-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    setNotice(`${selected.length} Kunden exportiert.`);
  }

  async function saveLeadDetailsFromModal() {
    if (!selectedLeadForHistory || !detailDraft) return;
    setBusy(true);
    try {
      const updates: Partial<DashboardData["leads"][number]> = {
        customerKind: detailDraft.customerKind === "privat" || detailDraft.customerKind === "firma" ? detailDraft.customerKind : undefined,
        customerOwner: detailDraft.customerOwner === "BarmeniaGothaer" || detailDraft.customerOwner === "Agentur-Duic" ? detailDraft.customerOwner : undefined,
        contactName: detailDraft.contactName,
        phone: detailDraft.phone,
        directDial: detailDraft.directDial,
        email: detailDraft.email,
        location: detailDraft.location,
        addressStreet: detailDraft.addressStreet,
        addressPostalCode: detailDraft.addressPostalCode,
        addressCity: detailDraft.addressCity,
        addressCountry: detailDraft.addressCountry,
        products: detailDraft.products,
        crmPipeline: detailDraft.crmPipeline,
        topic: detailDraft.topic,
        note: leadNoteEdit,
      };

      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_lead_details", leadId: selectedLeadForHistory.id, updates }),
      });

      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Kundendetails konnten nicht gespeichert werden.");

      setNotice("Kundendetails gespeichert.");
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Kundendetails konnten nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function addOutlookMailToLead() {
    if (!selectedLeadForHistory) return;
    if (!outlookMailDraft.subject.trim()) {
      setNotice("Bitte mindestens einen Betreff für die Outlook-Mail angeben.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_outlook_email",
          leadId: selectedLeadForHistory.id,
          email: {
            subject: outlookMailDraft.subject,
            body: outlookMailDraft.body,
            to: outlookMailDraft.to,
            sentAt: outlookMailDraft.sentAt ? new Date(outlookMailDraft.sentAt).toISOString() : undefined,
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Outlook-Mail konnte nicht gespeichert werden.");
      setNotice("Outlook-Mail wurde beim Kunden hinterlegt.");
      setOutlookMailDraft({ subject: "", body: "", to: selectedLeadForHistory.email || "", sentAt: "" });
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Outlook-Mail konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function addLeadTaskFromModal() {
    if (!selectedLeadForHistory) return;
    if (!leadTaskDraft.title.trim()) {
      setNotice("Bitte einen Aufgabentitel eingeben.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_lead_task",
          leadId: selectedLeadForHistory.id,
          task: {
            title: leadTaskDraft.title,
            dueAt: leadTaskDraft.dueAt ? new Date(leadTaskDraft.dueAt).toISOString() : undefined,
          },
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Aufgabe konnte nicht erstellt werden.");
      setLeadTaskDraft({ title: "", dueAt: "" });
      setNotice("Aufgabe gespeichert.");
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Aufgabe konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  async function completeLeadTaskFromModal(taskId: string) {
    if (!selectedLeadForHistory) return;
    setBusy(true);
    try {
      const res = await fetch("/api/campaigns/lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete_lead_task",
          leadId: selectedLeadForHistory.id,
          taskId,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(payload.error || "Aufgabe konnte nicht abgeschlossen werden.");
      setNotice("Aufgabe abgeschlossen.");
      await loadDashboard();
      await loadCampaignLists();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Aufgabe konnte nicht abgeschlossen werden.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAllReports() {
    if (
      !confirm(
        "Wirklich ALLE Gesprächsreports unwiderruflich löschen?",
      )
    ) {
      return;
    }
    if (
      !confirm(
        "Letzte Sicherheitsabfrage: Diese Aktion kann nicht rückgängig gemacht werden. Fortfahren?",
      )
    ) {
      return;
    }

    setBusy(true);

    try {
      const response = await fetch(`/api/reports?all=1`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        deletedReports?: number;
      };

      if (!response.ok) {
        throw new Error(payload.error || "Reports konnten nicht gelöscht werden.");
      }

      setSelectedReport(null);
      setNotice(`Alle Gesprächsreports gelöscht (${payload.deletedReports ?? 0} Reports entfernt).`);
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Löschen fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function createUserByAdmin() {
    if (!newUsername || !newPassword || !newRealName || !newCompanyName) {
      setNotice("Bitte alle Pflichtfelder für den Benutzer angeben.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          realName: newRealName,
          companyName: newCompanyName,
          address: newAddress,
          email: newEmail,
          realPhone: newRealPhone,
          gesellschaft: newGesellschaft,
          role: newRole,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Benutzer konnte nicht erstellt werden.");
      }

      setNewUsername("");
      setNewPassword("");
      setNewRealName("");
      setNewCompanyName("");
      setNewAddress("");
      setNewEmail("");
      setNewRealPhone("");
      setNewGesellschaft("");
      setNewRole("user");
      setNotice("Benutzer erfolgreich erstellt.");
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Benutzer konnte nicht erstellt werden.");
    } finally {
      setBusy(false);
    }
  }

  async function createPhoneByAdmin() {
    if (!newPhoneUserId || !newPhoneNumber || !newPhoneLabel) {
      setNotice("Bitte User, Nummer und Label angeben.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/admin/phone-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: newPhoneUserId,
          phoneNumber: newPhoneNumber,
          label: newPhoneLabel,
          active: true,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Rufnummer konnte nicht gespeichert werden.");
      }

      setNewPhoneNumber("");
      setNewPhoneLabel("");
      setNotice("Rufnummer gespeichert.");
      await loadSessionAndAdminData();
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rufnummer konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoneByAdmin(id: string, number: string) {
    if (!confirm(`Rufnummer ${number} wirklich löschen?`)) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/phone-numbers?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Rufnummer konnte nicht gelöscht werden.");
      }

      setNotice(`Rufnummer ${number} gelöscht.`);
      await loadSessionAndAdminData();
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rufnummer konnte nicht gelöscht werden.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteUserByAdmin(userId: string, username: string) {
    if (currentUser?.id === userId) {
      setNotice("Der aktuell angemeldete Master-Benutzer kann hier nicht gelöscht werden.");
      return;
    }

    const confirmed = confirm(`Benutzer \"${username}\" wirklich löschen?`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Benutzer konnte nicht gelöscht werden.");
      }

      setNotice(`Benutzer \"${username}\" wurde gelöscht.`);
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Benutzer konnte nicht gelöscht werden.");
    } finally {
      setBusy(false);
    }
  }

  async function resetUserPassword(userId: string, username: string) {
    const next = window.prompt(`Neues Passwort fuer "${username}":`);
    if (!next || next.trim().length < 6) {
      if (next !== null) setNotice("Passwort muss mindestens 6 Zeichen haben.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Passwort-Reset fehlgeschlagen.");
      setNotice(`Passwort fuer "${username}" gesetzt.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Passwort-Reset fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleUserRole(userId: string, username: string, current: "master" | "user") {
    if (currentUser?.id === userId) {
      setNotice("Eigene Rolle kann nicht geaendert werden.");
      return;
    }
    const target: "master" | "user" = current === "master" ? "user" : "master";
    if (!confirm(`Rolle von "${username}" auf "${target}" setzen?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: target }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Rolle konnte nicht geaendert werden.");
      setNotice(`Rolle fuer "${username}" ist jetzt "${target}".`);
      await loadSessionAndAdminData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Rolle konnte nicht geaendert werden.");
    } finally {
      setBusy(false);
    }
  }

  function startEditUser(user: AdminUser) {
    const phone = user.phoneNumbers?.[0];
    setEditingUserId(user.id);
    setEditDraft({
      username: user.username,
      realName: user.realName,
      companyName: user.companyName,
      address: user.address || "",
      email: user.email || "",
      realPhone: user.realPhone || "",
      gesellschaft: user.gesellschaft || "",
      role: user.role,
      password: "",
      assignedPhone: phone?.phoneNumber || "",
      assignedLabel: phone?.label || "",
      selectedVoiceId: user.selectedVoiceId || "",
      allowedPlaybookTopics: user.allowedPlaybookTopics || [],
    });
  }

  function cancelEditUser() {
    setEditingUserId(null);
    setEditDraft(null);
  }

  async function saveEditUser(user: AdminUser) {
    if (!editDraft) return;
    if (editDraft.password && editDraft.password.length < 6) {
      setNotice("Passwort muss mindestens 6 Zeichen haben.");
      return;
    }

    setBusy(true);
    try {
      const userPayload: Record<string, unknown> = {
        username: editDraft.username,
        realName: editDraft.realName,
        companyName: editDraft.companyName,
        address: editDraft.address,
        email: editDraft.email,
        realPhone: editDraft.realPhone,
        gesellschaft: editDraft.gesellschaft,
        role: editDraft.role,
        selectedVoiceId: editDraft.selectedVoiceId,
        allowedPlaybookTopics: Array.from(new Set(editDraft.allowedPlaybookTopics
          .map((t) => t.trim())
          .filter(Boolean))),
      };
      if (editDraft.password) userPayload.password = editDraft.password;

      const userRes = await fetch(`/api/admin/users/${encodeURIComponent(user.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(userPayload),
      });
      const userJson = (await userRes.json().catch(() => ({}))) as { error?: string };
      if (!userRes.ok) throw new Error(userJson.error || "Benutzer konnte nicht aktualisiert werden.");

      // Phone number sync (single assigned phone per row)
      const existing = user.phoneNumbers?.[0];
      const desiredNumber = editDraft.assignedPhone.trim();
      const desiredLabel = editDraft.assignedLabel.trim() || "Standard";

      if (!existing && desiredNumber) {
        const res = await fetch("/api/admin/phone-numbers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: user.id, phoneNumber: desiredNumber, label: desiredLabel, active: true }),
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht angelegt werden.");
      } else if (existing && !desiredNumber) {
        const res = await fetch(`/api/admin/phone-numbers?id=${encodeURIComponent(existing.id)}`, {
          method: "DELETE",
        });
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht entfernt werden.");
      } else if (existing && desiredNumber) {
        if (existing.phoneNumber !== desiredNumber || existing.label !== desiredLabel) {
          const res = await fetch("/api/admin/phone-numbers", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: existing.id, phoneNumber: desiredNumber, label: desiredLabel, active: existing.active }),
          });
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) throw new Error(j.error || "Rufnummer konnte nicht aktualisiert werden.");
        }
      }

      setNotice(`Benutzer "${editDraft.username}" gespeichert.`);
      cancelEditUser();
      await loadSessionAndAdminData();
      await loadDashboard();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Speichern fehlgeschlagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Image src="/Gloria.png" alt="Gloria" width={38} height={38} className="brand-logo" priority />
          <div>
            <div className="brand-title">Gloria</div>
            <div className="brand-sub">Agentur Duic</div>
          </div>
        </div>
        <nav className="sidebar-nav">
          <button
            className={`nav-item ${activeView === "overview" ? "active" : ""}`}
            onClick={() => setActiveView("overview")}
          >
            <span className="nav-icon" aria-hidden>▦</span>
            <span>Übersicht</span>
          </button>
          <button
            className={`nav-item ${activeView === "calls" ? "active" : ""}`}
            onClick={() => setActiveView("calls")}
          >
            <span className="nav-icon" aria-hidden>☎</span>
            <span>Anrufe</span>
          </button>
          <button
            className={`nav-item ${activeView === "leads" ? "active" : ""}`}
            onClick={() => setActiveView("leads")}
          >
            <span className="nav-icon" aria-hidden>≡</span>
            <span>Aufträge</span>
          </button>
          <button
            className={`nav-item ${activeView === "calendar" ? "active" : ""}`}
            onClick={() => setActiveView("calendar")}
          >
            <span className="nav-icon" aria-hidden>▤</span>
            <span>Kalender</span>
          </button>
          <button
            className={`nav-item ${activeView === "crm" ? "active" : ""}`}
            onClick={() => setActiveView("crm")}
          >
            <span className="nav-icon" aria-hidden>◈</span>
            <span>Kundenmanagement</span>
          </button>
        </nav>
        <div className="sidebar-footer">
          <button
            className={`nav-item ${activeView === "settings" ? "active" : ""}`}
            onClick={() => setActiveView("settings")}
          >
            <span className="nav-icon" aria-hidden>⚙</span>
            <span>Einstellungen</span>
          </button>
          <button
            className={`nav-item ${activeView === "compliance" ? "active" : ""}`}
            onClick={() => setActiveView("compliance")}
          >
            <span className="nav-icon" aria-hidden>§</span>
            <span>Compliance & Ablauf</span>
          </button>
          <a className="nav-item ghost" href="/logout">
            <span className="nav-icon" aria-hidden>↩</span>
            <span>Abmelden</span>
          </a>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <div className="topbar-eyebrow">Agentur Duic Sprockhövel</div>
            <h1 className="topbar-title">
              {activeView === "overview" ? "Übersicht" : null}
              {activeView === "calls" ? "Anrufe" : null}
              {activeView === "leads" ? "Aufträge" : null}
              {activeView === "calendar" ? "Kalender" : null}
              {activeView === "crm" ? "Kundenmanagement" : null}
              {activeView === "settings" ? "Einstellungen" : null}
              {activeView === "compliance" ? "Compliance & Ablauf" : null}
            </h1>
            <p className="topbar-note">{loading ? "Lade Daten ..." : notice}</p>
          </div>
          <div className="topbar-meta">
            <span className="status-pill">
              <span className={`status-dot ${data.reportStorageMode === "postgres" ? "ok" : "warn"}`} />
              Reports: {data.reportStorageMode === "postgres" ? "PostgreSQL" : "Datei"}
            </span>
            <span className="status-pill">
              <span className={`status-dot ${data.topicPoliciesStorageMode === "postgres" ? "ok" : "warn"}`} />
              Topic Policies: {data.topicPoliciesStorageMode === "postgres" ? "PostgreSQL" : "Datei"}
            </span>
            {currentUser ? (
              <span className="user-chip">
                <span className="user-avatar">{(currentUser.username || "?").slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{currentUser.username}</strong>
                  <small>{currentUser.role === "master" ? "Master" : "Nutzer"}</small>
                </span>
              </span>
            ) : null}
          </div>
        </header>

        <div className="view-content">

      {activeView === "overview" ? (
      <>
      <section className="kpi-grid">
        <article className="kpi-card primary">
          <div className="kpi-label">Termine heute</div>
          <div className="kpi-value">{
            (data.reports || []).filter((r) => {
              if (r.outcome !== "Termin" || !r.appointmentAt) return false;
              const d = new Date(r.appointmentAt);
              const today = new Date();
              return d.toDateString() === today.toDateString();
            }).length
          }</div>
          <div className="kpi-sub">{data.metrics.appointments} Termine gesamt</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Gespräche heute</div>
          <div className="kpi-value">{
            (data.reports || []).filter((r) => {
              const d = new Date(r.conversationDate);
              const today = new Date();
              return d.toDateString() === today.toDateString() && reportHasRealConversation(r);
            }).length
          }</div>
          <div className="kpi-sub">{reportingInsights.realConversations} echte Gespräche gesamt</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Offene Wiedervorlagen</div>
          <div className="kpi-value">{data.metrics.callbacksOpen}</div>
          <div className="kpi-sub">Werden automatisch zurückgerufen</div>
        </article>
        <article className="kpi-card">
          <div className="kpi-label">Conversion-Rate</div>
          <div className="kpi-value">{reportingInsights.appointmentRate}%</div>
          <div className="kpi-sub">Termine je Kontakt erreicht</div>
        </article>
      </section>

      <CollapsiblePanel title="Kennzahlen" defaultOpen>
        <section className="stats-grid">
          <article className="stat-card"><span>Wählversuche</span><strong>{data.metrics.dialAttempts}</strong></article>
          <article className="stat-card"><span>Termine</span><strong>{reportingInsights.appointments}</strong></article>
          <article className="stat-card"><span>Wiedervorlagen</span><strong>{reportingInsights.callbacks}</strong></article>
          <article className="stat-card"><span>Absagen</span><strong>{reportingInsights.rejections}</strong></article>
          <article className="stat-card"><span>Nicht erreicht / kein Kontakt</span><strong>{reportingInsights.noContact}</strong></article>
          <article className="stat-card"><span>Gespräch abgebrochen</span><strong>{reportingInsights.aborted}</strong></article>
          <article className="stat-card"><span>Echte Gespräche</span><strong>{reportingInsights.realConversations}</strong></article>
          <article className="stat-card"><span>Ohne Gespräch</span><strong>{reportingInsights.noConversation}</strong></article>
        </section>
      </CollapsiblePanel>

      <CollapsiblePanel title="Reporting & Conversion" defaultOpen={false}>
        {reportingInsights.total === 0 ? (
          <p className="subtle">Noch keine Reports verfügbar. Sobald Gespräche geführt werden, erscheinen hier Funnel, Themen-Performance und Ablehnungsgründe.</p>
        ) : (
          <div className="stack" style={{ gap: "24px" }}>
            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Conversion-Funnel (Report-Basis + Gesprächsqualität)</strong></p>
              <section className="stats-grid">
                <article className="stat-card"><span>Reports gesamt</span><strong>{reportingInsights.total}</strong></article>
                <article className="stat-card"><span>Echte Gespräche</span><strong>{reportingInsights.realConversations}</strong></article>
                <article className="stat-card"><span>Kontakte erreicht</span><strong>{reportingInsights.contacts}<small className="subtle"> ({reportingInsights.contactRate}%)</small></strong></article>
                <article className="stat-card"><span>Termine</span><strong>{reportingInsights.appointments}<small className="subtle"> ({reportingInsights.appointmentRate}% v. Kontakte)</small></strong></article>
                <article className="stat-card"><span>Wiedervorlagen</span><strong>{reportingInsights.callbacks}</strong></article>
                <article className="stat-card"><span>Absagen</span><strong>{reportingInsights.rejections}<small className="subtle"> ({reportingInsights.rejectionRate}% v. Kontakte)</small></strong></article>
                <article className="stat-card"><span>Nicht erreicht / kein Kontakt</span><strong>{reportingInsights.noContact}</strong></article>
                <article className="stat-card"><span>Gespräch abgebrochen</span><strong>{reportingInsights.aborted}</strong></article>
                <article className="stat-card"><span>Kein Kontakt trotz Gespräch</span><strong>{reportingInsights.noContactWithConversation}</strong></article>
              </section>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Performance nach Thema</strong></p>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Thema</th>
                      <th style={{ textAlign: "right" }}>Reports</th>
                      <th style={{ textAlign: "right" }}>Termine</th>
                      <th style={{ textAlign: "right" }}>Absagen</th>
                      <th style={{ textAlign: "right" }}>Wiedervorlage</th>
                      <th style={{ textAlign: "right" }}>Nicht erreicht</th>
                      <th style={{ textAlign: "right" }}>Abgebrochen</th>
                      <th style={{ textAlign: "right" }}>Termin-Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportingInsights.topicStats.map((row) => (
                      <tr key={row.topic}>
                        <td>{row.topic}</td>
                        <td style={{ textAlign: "right" }}>{row.total}</td>
                        <td style={{ textAlign: "right" }}>{row.termin}</td>
                        <td style={{ textAlign: "right" }}>{row.absage}</td>
                        <td style={{ textAlign: "right" }}>{row.wiedervorlage}</td>
                        <td style={{ textAlign: "right" }}>{row.keinKontakt}</td>
                        <td style={{ textAlign: "right" }}>{Math.max(0, Math.min(100, row.keinKontakt || 0))}</td>
                        <td style={{ textAlign: "right" }}><strong>{row.terminRate}%</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Top Ablehnungsgründe</strong></p>
              {reportingInsights.topRejections.length === 0 ? (
                <p className="subtle">Noch keine Absagen erfasst.</p>
              ) : (
                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                  {reportingInsights.topRejections.map((r) => {
                    const pct = reportingInsights.rejections > 0 ? Math.round((r.count / reportingInsights.rejections) * 100) : 0;
                    return (
                      <li key={r.label} style={{ display: "grid", gridTemplateColumns: "260px 1fr 60px", gap: 10, alignItems: "center" }}>
                        <span>{r.label}</span>
                        <span style={{ background: "#e8edf5", borderRadius: 6, height: 10, overflow: "hidden" }}>
                          <span style={{ display: "block", width: `${pct}%`, height: "100%", background: "linear-gradient(135deg, #c24d4d, #a03030)" }} />
                        </span>
                        <span style={{ textAlign: "right" }}><strong>{r.count}</strong> <small className="subtle">({pct}%)</small></span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="subtle" style={{ marginTop: 8, fontSize: "0.85rem" }}>
                Ableitung erfolgt per Textanalyse der Report-Zusammenfassung (Schlagwörter). &quot;Sonstige&quot; umfasst Absagen ohne erkennbares Muster.
              </p>
            </div>

            <div>
              <p className="subtle" style={{ marginBottom: 8 }}><strong>Verlauf letzte 14 Tage</strong></p>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${reportingInsights.days.length}, minmax(28px, 1fr))`, gap: 4, alignItems: "end", minHeight: 120 }}>
                {reportingInsights.days.map((d) => {
                  const h = Math.round((d.gespraeche / reportingInsights.peakDayGespraeche) * 100);
                  const terminPct = d.gespraeche > 0 ? Math.round((d.termine / d.gespraeche) * 100) : 0;
                  const absagePct = d.gespraeche > 0 ? Math.round((d.absagen / d.gespraeche) * 100) : 0;
                  return (
                    <div key={d.key} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <div
                        title={`${d.label}: ${d.gespraeche} Gespräche, ${d.termine} Termine, ${d.absagen} Absagen`}
                        style={{ width: "100%", height: `${Math.max(h, 2)}px`, background: "linear-gradient(180deg, #3c6fb5, #27457a)", borderRadius: 3, position: "relative", display: "flex", flexDirection: "column-reverse" }}
                      >
                        {terminPct > 0 && <div style={{ height: `${terminPct}%`, background: "#2f8f57" }} />}
                        {absagePct > 0 && <div style={{ height: `${absagePct}%`, background: "#c24d4d", opacity: 0.85 }} />}
                      </div>
                      <small className="subtle" style={{ fontSize: "0.7rem" }}>{d.label}</small>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: "0.85rem" }} className="subtle">
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#3c6fb5", marginRight: 4, borderRadius: 2 }} />Gespräche</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#2f8f57", marginRight: 4, borderRadius: 2 }} />Termine</span>
                <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#c24d4d", marginRight: 4, borderRadius: 2 }} />Absagen</span>
              </div>
            </div>
          </div>
        )}
      </CollapsiblePanel>
      </>
      ) : null}

      {activeView === "crm" ? (() => {
        const stages: Array<{ key: string; label: string; color: string }> = [
          { key: "neu", label: "Neu", color: "#6b7280" },
          { key: "qualifiziert", label: "Qualifiziert", color: "#2563eb" },
          { key: "angebot", label: "Angebot", color: "#0ea5e9" },
          { key: "verhandlung", label: "Verhandlung", color: "#d97706" },
          { key: "gewonnen", label: "Gewonnen", color: "#059669" },
          { key: "verloren", label: "Verloren", color: "#dc2626" },
        ];
        const todayCallbacks = data.reports.filter((r) => {
          if (r.outcome !== "Wiedervorlage" || !r.nextCallAt) return false;
          return new Date(r.nextCallAt).toDateString() === new Date().toDateString();
        });

        // Customer list with filters
        const filteredCrmLeads = data.leads.filter((lead) => {
          if (crmTypeFilter && getCrmCustomerType(lead) !== crmTypeFilter) return false;
          if (crmCustomerKindFilter && (lead.customerKind || "firma") !== crmCustomerKindFilter) return false;
          if (crmPipelineFilter && getLeadPipelineStage(lead) !== crmPipelineFilter) return false;
          if (crmContactFilter === "mitEmail" && !lead.email) return false;
          if (crmContactFilter === "ohneEmail" && lead.email) return false;
          if (crmContactFilter === "mitTelefon" && !(lead.phone || lead.directDial)) return false;
          if (crmSearch) {
            const q = crmSearch.toLowerCase();
            return (
              lead.company.toLowerCase().includes(q) ||
              (lead.contactName || "").toLowerCase().includes(q) ||
              (lead.phone || "").includes(q) ||
              (lead.directDial || "").includes(q) ||
              (lead.email || "").toLowerCase().includes(q) ||
              (lead.addressCity || lead.location || "").toLowerCase().includes(q) ||
              lead.topic.toLowerCase().includes(q)
            );
          }
          return true;
        });

        const allFilteredSelected = filteredCrmLeads.length > 0 && filteredCrmLeads.every(l => selectedCrmLeads.has(l.id));

        const typeColors: Record<string, { bg: string; color: string }> = {
          "BarmeniaGothaer": { bg: "#fef3c7", color: "#92400e" },
          "Agentur-Duic": { bg: "#dbeafe", color: "#1e40af" },
          "Unbekannt": { bg: "#f3f4f6", color: "#6b7280" },
        };

        return (
          <section className="stack top-section crm-shell">
            <div className="crm-header-card">
              <div>
                <p className="crm-kicker">Kundenmanagement</p>
                <h2>Kundenmanagement</h2>
                <p className="subtle" style={{ marginTop: 6 }}>
                  Professionelle Kundensteuerung mit Stammdatenfokus im Dashboard und Detailakten für Pipeline, Produkte und Historie.
                </p>
              </div>
              <div className="crm-header-stats">
                <div className="crm-stat-chip"><strong>{data.leads.length}</strong><span>Kunden</span></div>
                <div className="crm-stat-chip"><strong>{data.leads.filter((lead) => lead.status === "wiedervorlage").length}</strong><span>Wiedervorlagen</span></div>
                <div className="crm-stat-chip"><strong>{data.leads.filter((lead) => getLeadPipelineStage(lead) === "gewonnen").length}</strong><span>Gewonnen</span></div>
              </div>
            </div>

            {/* Sub-navigation */}
            <div className="crm-tabs-bar">
              {(["customers", "pipeline", "callbacks"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setCrmTab(tab)}
                  className={`crm-tab-btn ${crmTab === tab ? "active" : ""}`}
                >
                  {tab === "customers" ? `Kundenliste (${data.leads.length})` : tab === "pipeline" ? "Pipeline" : "Wiedervorlagen"}
                </button>
              ))}
            </div>

            {/* === KUNDENVERWALTUNG === */}
            {crmTab === "customers" && (
              <div className="mini-panel crm-table-panel">
                {/* Toolbar */}
                <div className="row spread" style={{ flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap", flex: 1 }}>
                    <input
                      type="text"
                      placeholder="Suche: Firma, Kontakt, Tel, Email, Thema..."
                      value={crmSearch}
                      onChange={e => setCrmSearch(e.target.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <select value={crmTypeFilter} onChange={e => setCrmTypeFilter(e.target.value as typeof crmTypeFilter)} style={{ minWidth: 170 }}>
                      <option value="">Alle Kundentypen</option>
                      <option value="BarmeniaGothaer">🏢 BarmeniaGothaer</option>
                      <option value="Agentur-Duic">🏬 Agentur-Duic</option>
                    </select>
                    <select value={crmCustomerKindFilter} onChange={e => setCrmCustomerKindFilter(e.target.value as typeof crmCustomerKindFilter)} style={{ minWidth: 150 }}>
                      <option value="">Privat + Firma</option>
                      <option value="privat">Privatkunde</option>
                      <option value="firma">Firmenkunde</option>
                    </select>
                    <select value={crmPipelineFilter} onChange={e => setCrmPipelineFilter(e.target.value as typeof crmPipelineFilter)} style={{ minWidth: 160 }}>
                      <option value="">Alle Pipeline-Stufen</option>
                      <option value="neu">Neu</option>
                      <option value="qualifiziert">Qualifiziert</option>
                      <option value="angebot">Angebot</option>
                      <option value="verhandlung">Verhandlung</option>
                      <option value="gewonnen">Gewonnen</option>
                      <option value="verloren">Verloren</option>
                    </select>
                    <select value={crmContactFilter} onChange={e => setCrmContactFilter(e.target.value as typeof crmContactFilter)} style={{ minWidth: 150 }}>
                      <option value="">Alle Kontakte</option>
                      <option value="mitEmail">Mit E-Mail</option>
                      <option value="ohneEmail">Ohne E-Mail</option>
                      <option value="mitTelefon">Mit Telefonnummer</option>
                    </select>
                    <input
                      type="text"
                      placeholder="Suche speichern als..."
                      value={crmViewNameDraft}
                      onChange={(e) => setCrmViewNameDraft(e.target.value)}
                      style={{ minWidth: 180 }}
                    />
                    <button className="btn ghost" onClick={() => void saveCurrentCrmSearch()}>Suche speichern</button>
                    <span className="subtle" style={{ fontSize: "0.8rem" }}>
                      {crmSavedViews.length} gespeicherte Suche(n)
                    </span>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn ghost" onClick={() => setShowCrmImport(v => !v)}>📥 Importieren</button>
                    <button className="btn" onClick={() => setShowAddCustomerModal(true)}>+ Kunde anlegen</button>
                    {selectedCrmLeads.size > 0 && (
                      <button
                        className="btn"
                        style={{ background: "#059669" }}
                        onClick={() => setShowCampaignFromSelectionModal(true)}
                      >
                        📞 Kampagne aus Auswahl ({selectedCrmLeads.size})
                      </button>
                    )}
                    {selectedCrmLeads.size > 0 && (
                      <button className="btn ghost" onClick={() => void exportSelectedCustomers()}>
                        ⤓ Export ({selectedCrmLeads.size})
                      </button>
                    )}
                  </div>
                </div>

                {/* Import Panel */}
                {showCrmImport && (
                  <div style={{ background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 8, padding: "16px", marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <strong>CSV / Excel importieren</strong>
                      <button className="btn ghost" style={{ fontSize: "0.8rem", padding: "4px 8px" }} onClick={() => setShowCrmImport(false)}>✕</button>
                    </div>
                    <div className="field-grid">
                      <div>
                        <label>Kundentyp</label>
                        <select value={crmImportCustomerType} onChange={e => setCrmImportCustomerType(e.target.value as typeof crmImportCustomerType)}>
                          <option value="Agentur-Duic">🏬 Agentur-Duic Kunden</option>
                          <option value="BarmeniaGothaer">🏢 BarmeniaGothaer Kunden</option>
                        </select>
                      </div>
                      <div>
                        <label>Listenname</label>
                        <input value={crmImportListName} onChange={e => setCrmImportListName(e.target.value)} placeholder="z. B. Jahresgespräche August" />
                      </div>
                      <div>
                        <label>Thema (optional, überschreibt Datei)</label>
                        <select value={crmImportTopic} onChange={e => setCrmImportTopic(e.target.value as Topic | "")}>
                          <option value="">-- Thema aus Datei --</option>
                          {TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div>
                        <label>Datei (CSV / XLSX / XLS)</label>
                        <input type="file" accept=".csv,.xlsx,.xls" onChange={e => setCrmImportFile(e.target.files?.[0] || null)} />
                      </div>
                    </div>
                    <p className="subtle" style={{ fontSize: "0.82rem", margin: "8px 0" }}>Format: customerOwner, customerKind, company, contactName, phone, email, addressStreet, addressPostalCode, addressCity, addressCountry, products, topic, note, nextCallAt</p>
                    <div className="row top-gap" style={{ gap: 8 }}>
                      <button
                        className="btn"
                        disabled={busy || !crmImportFile}
                        onClick={async () => {
                          if (!crmImportFile) return;
                          setBusy(true);
                          try {
                            const form = new FormData();
                            form.set("file", crmImportFile);
                            const resolvedListName = crmImportListName.trim() || crmImportFile.name.replace(/\.[^.]+$/, "");
                            form.set("listName", `${crmImportCustomerType} | ${resolvedListName}`);
                            if (crmImportTopic) form.set("topic", crmImportTopic);
                            const res = await fetch("/api/campaigns/import", { method: "POST", body: form, credentials: "same-origin" });
                            const payload = (await res.json()) as { imported?: number; error?: string; listName?: string };
                            if (!res.ok) throw new Error(payload.error || "Import fehlgeschlagen");
                            setNotice(`${payload.imported ?? 0} Kunden importiert in "${payload.listName || resolvedListName}"`);
                            setCrmImportFile(null);
                            setCrmImportListName("");
                            setShowCrmImport(false);
                            await loadDashboard();
                            await loadCampaignLists();
                          } catch (e) { setNotice(e instanceof Error ? e.message : "Fehler"); }
                          finally { setBusy(false); }
                        }}
                      >
                        {busy ? "Importiert..." : "Importieren"}
                      </button>
                      {crmImportFile && <span className="subtle">{crmImportFile.name}</span>}
                    </div>
                  </div>
                )}

                {/* Customer Table */}
                <div style={{ overflowX: "auto" }}>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 32 }}>
                          <input
                            type="checkbox"
                            checked={allFilteredSelected}
                            onChange={e => {
                              const next = new Set(selectedCrmLeads);
                              filteredCrmLeads.forEach(l => e.target.checked ? next.add(l.id) : next.delete(l.id));
                              setSelectedCrmLeads(next);
                            }}
                          />
                        </th>
                        <th>Kundentyp</th>
                        <th>Kundenart</th>
                        <th>Firma</th>
                        <th>Ansprechpartner</th>
                        <th>Telefon</th>
                        <th>Email</th>
                        <th>Strasse</th>
                        <th>PLZ</th>
                        <th>Stadt</th>
                        <th>Land</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCrmLeads.length === 0 && (
                        <tr><td colSpan={12} style={{ textAlign: "center", padding: "24px", color: "#9ca3af" }}>Keine Kunden gefunden</td></tr>
                      )}
                      {filteredCrmLeads.map((lead) => {
                        const custType = getCrmCustomerType(lead);
                        const typeStyle = typeColors[custType] || typeColors["Unbekannt"];
                        const isSelected = selectedCrmLeads.has(lead.id);
                        return (
                          <tr key={lead.id} style={{ background: isSelected ? "#eff6ff" : undefined }}>
                            <td>
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={e => {
                                  const next = new Set(selectedCrmLeads);
                                  e.target.checked ? next.add(lead.id) : next.delete(lead.id);
                                  setSelectedCrmLeads(next);
                                }}
                              />
                            </td>
                            <td>
                              <span style={{ ...typeStyle, borderRadius: 999, padding: "2px 8px", fontSize: "0.78rem", fontWeight: 600, whiteSpace: "nowrap" }}>
                                {custType === "BarmeniaGothaer" ? "🏢" : custType === "Agentur-Duic" ? "🏬" : "❓"} {custType}
                              </span>
                            </td>
                            <td>{lead.customerKind === "privat" ? "Privat" : "Firma"}</td>
                            <td>
                              <button className="link-button" onClick={() => setSelectedLeadForHistory(lead)}>
                                <strong>{lead.company}</strong>
                              </button>
                            </td>
                            <td>{lead.contactName || "-"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{lead.phone || lead.directDial || "-"}</td>
                            <td style={{ fontSize: "0.85rem", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{lead.email || "-"}</td>
                            <td style={{ fontSize: "0.85rem", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{lead.addressStreet || "-"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{lead.addressPostalCode || "-"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{lead.addressCity || lead.location || "-"}</td>
                            <td style={{ fontSize: "0.85rem" }}>{lead.addressCountry || "-"}</td>
                            <td>
                              <button className="btn ghost" style={{ fontSize: "0.8rem", padding: "4px 8px" }} onClick={() => setSelectedLeadForHistory(lead)}>
                                Historie
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {selectedCrmLeads.size > 0 && (
                  <div style={{ marginTop: 12, padding: "8px 12px", background: "#eff6ff", borderRadius: 6, display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ color: "#1e40af", fontWeight: 600 }}>{selectedCrmLeads.size} Kunden ausgewählt</span>
                    <button className="btn" style={{ background: "#059669", padding: "6px 14px", fontSize: "0.85rem" }} onClick={() => setShowCampaignFromSelectionModal(true)}>
                      📞 Kampagne für Gloria erstellen
                    </button>
                    <button className="btn ghost" style={{ fontSize: "0.85rem" }} onClick={() => setSelectedCrmLeads(new Set())}>Auswahl aufheben</button>
                  </div>
                )}
              </div>
            )}

            {/* === SALES PIPELINE === */}
            {crmTab === "pipeline" && (
              <CollapsiblePanel title="CRM-Pipeline" defaultOpen>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(180px, 1fr))", gap: 12, overflowX: "auto", minWidth: 0 }}>
                  {stages.map((stage) => {
                    const leadsInStage = data.leads.filter((l) => getLeadPipelineStage(l) === stage.key);
                    return (
                      <div key={stage.key} style={{ background: "#f8fafc", borderRadius: 8, padding: 12, borderTop: `3px solid ${stage.color}` }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                          <strong style={{ fontSize: "0.9rem" }}>{stage.label}</strong>
                          <span style={{ background: stage.color, color: "white", borderRadius: 999, padding: "2px 8px", fontSize: "0.8rem" }}>{leadsInStage.length}</span>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 400, overflowY: "auto" }}>
                          {leadsInStage.slice(0, 20).map((lead) => {
                            const custType = getCrmCustomerType(lead);
                            const typeStyle = typeColors[custType] || typeColors["Unbekannt"];
                            return (
                              <button
                                key={lead.id}
                                className="link-button"
                                onClick={() => setSelectedLeadForHistory(lead)}
                                style={{ textAlign: "left", background: "white", padding: "8px 10px", borderRadius: 6, border: "1px solid #e5e7eb", width: "100%" }}
                              >
                                <div style={{ fontWeight: 600, fontSize: "0.85rem" }}>{lead.company}</div>
                                <div style={{ color: "#6b7280", fontSize: "0.78rem", marginTop: 2 }}>{lead.contactName || lead.topic}</div>
                                <span style={{ ...typeStyle, borderRadius: 999, padding: "1px 6px", fontSize: "0.7rem", fontWeight: 600 }}>{custType}</span>
                                {lead.nextCallAt ? <div style={{ color: stage.color, fontSize: "0.75rem", marginTop: 2 }}>↻ {formatDate(lead.nextCallAt)}</div> : null}
                              </button>
                            );
                          })}
                          {leadsInStage.length > 20 && <p className="subtle" style={{ fontSize: "0.8rem" }}>+{leadsInStage.length - 20} weitere</p>}
                          {leadsInStage.length === 0 && <p className="subtle" style={{ fontSize: "0.82rem" }}>Leer</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CollapsiblePanel>
            )}

            {/* === WIEDERVORLAGEN === */}
            {crmTab === "callbacks" && (
              <>
                <CollapsiblePanel title="Wiedervorlagen heute" defaultOpen>
                  {todayCallbacks.length === 0 ? (
                    <p className="subtle">Keine fälligen Wiedervorlagen für heute.</p>
                  ) : (
                    <table>
                      <thead><tr><th>Firma</th><th>Kontakt</th><th>Thema</th><th>Fällig</th><th>Notiz</th><th></th></tr></thead>
                      <tbody>
                        {todayCallbacks.map((r) => (
                          <tr key={r.id}>
                            <td><strong>{r.company}</strong></td>
                            <td>{r.contactName || "-"}</td>
                            <td>{r.topic}</td>
                            <td>{formatDate(r.nextCallAt)}</td>
                            <td className="subtle" style={{ maxWidth: 200 }}>{(r.summary || "").slice(0, 80)}{(r.summary || "").length > 80 ? "..." : ""}</td>
                            <td><button className="btn ghost" style={{ fontSize: "0.82rem", padding: "5px 10px" }} onClick={() => setSelectedReport(r)}>Report</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </CollapsiblePanel>
                <CollapsiblePanel title="Alle offenen Wiedervorlagen" defaultOpen={false}>
                  {(() => {
                    const all = data.reports.filter((r) => r.outcome === "Wiedervorlage" && r.nextCallAt).sort((a, b) => Date.parse(a.nextCallAt || "0") - Date.parse(b.nextCallAt || "0"));
                    if (all.length === 0) return <p className="subtle">Keine offenen Wiedervorlagen.</p>;
                    return (
                      <table>
                        <thead><tr><th>Fällig</th><th>Firma</th><th>Kontakt</th><th>Thema</th><th>Zusammenfassung</th><th></th></tr></thead>
                        <tbody>
                          {all.map((r) => {
                            const isOverdue = Date.parse(r.nextCallAt || "0") < Date.now();
                            return (
                              <tr key={r.id} style={{ background: isOverdue ? "#fff5f5" : undefined }}>
                                <td style={{ color: isOverdue ? "#dc2626" : undefined, whiteSpace: "nowrap" }}>{formatDate(r.nextCallAt)}</td>
                                <td><strong>{r.company}</strong></td>
                                <td>{r.contactName || "-"}</td>
                                <td>{r.topic}</td>
                                <td className="subtle" style={{ maxWidth: 220 }}>{(r.summary || "").slice(0, 100)}{(r.summary || "").length > 100 ? "..." : ""}</td>
                                <td><button className="btn ghost" style={{ fontSize: "0.82rem", padding: "5px 10px" }} onClick={() => setSelectedReport(r)}>Report</button></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    );
                  })()}
                </CollapsiblePanel>
              </>
            )}

            {/* === MODAL: Kunde anlegen === */}
            {showAddCustomerModal && (
              <div className="modal-overlay" onClick={() => setShowAddCustomerModal(false)}>
                <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                  <button className="modal-close" onClick={() => setShowAddCustomerModal(false)}>✕</button>
                  <h2>Kunde anlegen</h2>
                  <div className="report-detail-grid top-gap">
                    <div className="report-detail-field">
                      <label>Kundentyp *</label>
                      <select value={addCustomerDraft.customerType} onChange={e => setAddCustomerDraft(d => ({ ...d, customerType: e.target.value as "BarmeniaGothaer" | "Agentur-Duic" }))}>
                        <option value="Agentur-Duic">🏬 Agentur-Duic Kunde</option>
                        <option value="BarmeniaGothaer">🏢 BarmeniaGothaer Kunde</option>
                      </select>
                    </div>
                    <div className="report-detail-field">
                      <label>Kundenart *</label>
                      <select value={addCustomerDraft.customerKind} onChange={e => setAddCustomerDraft(d => ({ ...d, customerKind: e.target.value as "privat" | "firma" }))}>
                        <option value="firma">Firmenkunde</option>
                        <option value="privat">Privatkunde</option>
                      </select>
                    </div>
                    <div className="report-detail-field">
                      <label>Firma *</label>
                      <input value={addCustomerDraft.company} onChange={e => setAddCustomerDraft(d => ({ ...d, company: e.target.value }))} placeholder="Musterbau GmbH" />
                    </div>
                    <div className="report-detail-field">
                      <label>Ansprechpartner</label>
                      <input value={addCustomerDraft.contactName} onChange={e => setAddCustomerDraft(d => ({ ...d, contactName: e.target.value }))} placeholder="Herr Neumann" />
                    </div>
                    <div className="report-detail-field">
                      <label>Telefon *</label>
                      <input value={addCustomerDraft.phone} onChange={e => setAddCustomerDraft(d => ({ ...d, phone: e.target.value }))} placeholder="+492339123456" />
                    </div>
                    <div className="report-detail-field">
                      <label>Email</label>
                      <input value={addCustomerDraft.email} onChange={e => setAddCustomerDraft(d => ({ ...d, email: e.target.value }))} placeholder="info@firma.de" />
                    </div>
                    <div className="report-detail-field report-detail-full">
                      <label>Strasse und Hausnummer</label>
                      <input value={addCustomerDraft.addressStreet} onChange={e => setAddCustomerDraft(d => ({ ...d, addressStreet: e.target.value }))} placeholder="Beispielweg 12" />
                    </div>
                    <div className="report-detail-field">
                      <label>PLZ</label>
                      <input value={addCustomerDraft.addressPostalCode} onChange={e => setAddCustomerDraft(d => ({ ...d, addressPostalCode: e.target.value }))} placeholder="42103" />
                    </div>
                    <div className="report-detail-field">
                      <label>Stadt</label>
                      <input value={addCustomerDraft.addressCity} onChange={e => setAddCustomerDraft(d => ({ ...d, addressCity: e.target.value }))} placeholder="Wuppertal" />
                    </div>
                    <div className="report-detail-field">
                      <label>Land</label>
                      <input value={addCustomerDraft.addressCountry} onChange={e => setAddCustomerDraft(d => ({ ...d, addressCountry: e.target.value }))} placeholder="Deutschland" />
                    </div>
                    <div className="report-detail-field">
                      <label>Produkte</label>
                      <input value={addCustomerDraft.productsInput} onChange={e => setAddCustomerDraft(d => ({ ...d, productsInput: e.target.value }))} placeholder="PKV; Zahn; Pflege" />
                    </div>
                    <div className="report-detail-field">
                      <label>Thema / Anlass (optional)</label>
                      <select value={addCustomerDraft.topic} onChange={e => setAddCustomerDraft(d => ({ ...d, topic: e.target.value as Topic | "" }))}>
                        <option value="">Kein Thema vorgeben</option>
                        {TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div className="report-detail-field report-detail-full">
                      <label>Notiz / Kontext</label>
                      <textarea value={addCustomerDraft.note} onChange={e => setAddCustomerDraft(d => ({ ...d, note: e.target.value }))} rows={3} placeholder="Bisherige Informationen, Besonderheiten..." style={{ width: "100%", resize: "vertical" }} />
                    </div>
                  </div>
                  <div className="row top-gap" style={{ gap: 8 }}>
                    <button className="btn" onClick={() => void addCustomerManually()} disabled={busy || !addCustomerDraft.company.trim() || !addCustomerDraft.phone.trim()}>
                      {busy ? "Speichert..." : "Kunde anlegen"}
                    </button>
                    <button className="btn ghost" onClick={() => setShowAddCustomerModal(false)}>Abbrechen</button>
                  </div>
                </div>
              </div>
            )}

            {/* === MODAL: Kampagne aus Selektion === */}
            {showCampaignFromSelectionModal && (
              <div className="modal-overlay" onClick={() => setShowCampaignFromSelectionModal(false)}>
                <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
                  <button className="modal-close" onClick={() => setShowCampaignFromSelectionModal(false)}>✕</button>
                  <h2>Kampagne für Gloria erstellen</h2>
                  <p className="subtle" style={{ marginTop: 6 }}>{selectedCrmLeads.size} Kunden werden an Gloria übergeben.</p>
                  <div className="report-detail-grid top-gap">
                    <div className="report-detail-field report-detail-full">
                      <label>Kampagnenname *</label>
                      <input value={campaignFromSelectionName} onChange={e => setCampaignFromSelectionName(e.target.value)} placeholder="z. B. Jahresgespräche August 2026" />
                    </div>
                    <div className="report-detail-field report-detail-full">
                      <label>Thema / Anlass für Gloria</label>
                      <select value={campaignFromSelectionTopic} onChange={e => setCampaignFromSelectionTopic(e.target.value as Topic)}>
                        {TOPICS.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="subtle top-gap" style={{ background: "#f8fafc", padding: "10px 12px", borderRadius: 6, fontSize: "0.85rem" }}>
                    <strong>Ausgewählte Kunden:</strong>
                    <ul style={{ margin: "6px 0 0", paddingLeft: 16 }}>
                      {data.leads.filter(l => selectedCrmLeads.has(l.id)).slice(0, 8).map(l => (
                        <li key={l.id}>{l.company}{l.contactName ? ` – ${l.contactName}` : ""}</li>
                      ))}
                      {selectedCrmLeads.size > 8 && <li>... und {selectedCrmLeads.size - 8} weitere</li>}
                    </ul>
                  </div>
                  <div className="row top-gap" style={{ gap: 8 }}>
                    <button className="btn" style={{ background: "#059669" }} onClick={() => void createCampaignFromSelection()} disabled={busy || !campaignFromSelectionName.trim()}>
                      {busy ? "Erstelle..." : "📞 Kampagne starten"}
                    </button>
                    <button className="btn ghost" onClick={() => setShowCampaignFromSelectionModal(false)}>Abbrechen</button>
                  </div>
                </div>
              </div>
            )}
          </section>
        );
      })() : null}
      {activeView === "calls" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Manueller Anruf" defaultOpen={false}>
          <div className="field-grid">
            <div>
              <label>Ausgangsnummer</label>
              <select
                value={anrufEinzelfirmaFrom}
                onChange={(event) => setAnrufEinzelfirmaFrom(event.target.value)}
                disabled={anrufEinzelfirmaFromOptions.length === 0}
              >
                {anrufEinzelfirmaFromOptions.length === 0 ? (
                  <option value="">Keine Nummer konfiguriert</option>
                ) : (
                  anrufEinzelfirmaFromOptions.map((option) => (
                    <option key={option.number} value={option.number}>{option.label} ({option.number})</option>
                  ))
                )}
              </select>
            </div>
            <div>
              <label>Zielnummer</label>
              <input value={anrufEinzelfirmaTarget} onChange={(event) => setAnrufEinzelfirmaTarget(event.target.value)} placeholder="+492339123456" />
            </div>
            <div>
              <label>Firma</label>
              <input value={anrufEinzelfirmaCompany} onChange={(event) => setAnrufEinzelfirmaCompany(event.target.value)} />
            </div>
            <div>
              <label>Ansprechpartner</label>
              <input value={anrufEinzelfirmaContactName} onChange={(event) => setAnrufEinzelfirmaContactName(event.target.value)} />
            </div>
            <div>
              <label>Thema</label>
              <select value={anrufEinzelfirmaTopic} onChange={(event) => setAnrufEinzelfirmaTopic(event.target.value as Topic)}>
                {TOPICS.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
              </select>
            </div>
          </div>
          <div className="row top-gap">
            <button className="btn" onClick={() => void startAnrufEinzelfirma()} disabled={busy || !anrufEinzelfirmaTarget.trim()}>
              {busy ? "Anruf startet ..." : "Anruf starten"}
            </button>
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel title="Gesprächsreports" defaultOpen>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
            <span className="subtle">
              Für jeden Anruf wird genau ein Report geführt. Veraltete Einträge werden automatisch verworfen.
            </span>
            <button
              className="btn danger"
              onClick={() => void deleteAllReports()}
              disabled={busy || reportRows.length === 0}
              title="Alle Gesprächsreports löschen"
            >
              Alle Reports löschen
            </button>
          </div>
          <table>
            <thead>
              <tr><th>Firma</th><th>Thema</th><th>Ergebnis</th><th>Termin / Callback</th><th></th></tr>
            </thead>
            <tbody>
              {reportRows.map((report) => (
                <tr key={report.id}>
                  <td><strong>{report.company}</strong>{report.contactName ? <div className="subtle">{report.contactName}</div> : null}</td>
                  <td>{report.topic}</td>
                  <td>
                    <span className={`status ${report.outcome === "Absage" ? "absage" : report.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                      {formatOutcomeLabel(report.outcome)}
                    </span>
                  </td>
                  <td>{formatDate(report.appointmentAt || report.nextCallAt)}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <button
                        className="btn ghost"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => setSelectedReport(report)}
                      >Details</button>
                      <button
                        className="btn danger"
                        style={{ fontSize: "0.82rem", padding: "5px 10px", whiteSpace: "nowrap" }}
                        onClick={() => void deleteReport(report.id)}
                        disabled={busy}
                        title="Report löschen"
                      >🗑</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CollapsiblePanel>

      </section>
      ) : null}

      {activeView === "leads" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Aufträge per CSV laden" defaultOpen>
          <p className="subtle">Format: customerOwner, customerKind, company, contactName, phone, email, addressStreet, addressPostalCode, addressCity, addressCountry, products, topic, note, nextCallAt</p>
          <label>Listenname</label>
          <input
            value={importListName}
            onChange={(event) => setImportListName(event.target.value)}
            placeholder="z. B. April-Kampagne Industrie"
          />
          <label>Thema (optional, überschreibt Wert aus Datei)</label>
          <select value={importTopic} onChange={(event) => setImportTopic((event.target.value as Topic) || "")}>
            <option value="">-- Thema aus Datei verwenden --</option>
            {TOPICS.map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
          <label>Datei hochladen (CSV / XLSX / XLS)</label>
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(event) => setImportFile(event.target.files?.[0] || null)}
          />
          <div className="row top-gap">
            <button className="btn" onClick={() => void handleFileImport()} disabled={busy || !importFile}>Datei importieren</button>
            {importFile ? <span className="subtle">Ausgewählt: {importFile.name}</span> : null}
          </div>
        </CollapsiblePanel>

        <CollapsiblePanel title="Auftraege" defaultOpen>
          {campaignLists.length > 0 && (
            <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
              <input
                type="text"
                placeholder="Suche nach Firma, Kontakt, Tel, Email..."
                value={leadSearch}
                onChange={(e) => setLeadSearch(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <select
                value={leadStatusFilter}
                onChange={(e) => setLeadStatusFilter(e.target.value)}
                style={{ minWidth: 150 }}
              >
                <option value="">Alle Status</option>
                <option value="neu">Neu</option>
                <option value="angerufen">Angerufen</option>
                <option value="termin">Termin</option>
                <option value="absage">Absage</option>
                <option value="wiedervorlage">Wiedervorlage</option>
              </select>
            </div>
          )}
          {campaignLists.length === 0 ? (
            <p className="subtle">Noch keine Listen vorhanden. Bitte zuerst CSV oder Excel hochladen.</p>
          ) : (
            <div className="stack">
              <p className="subtle">
                Aktive Listen werden automatisch Mo–Fr von 09:00–12:00 und 13:00–17:00 (Europe/Berlin) abgearbeitet. Bei „Kein Kontakt“ wird der Lead nach 1 Tag und danach nach 3 Tagen erneut versucht (max. 3 Versuche).
              </p>
              {Object.entries(campaignLists.reduce<Record<string, CampaignListSummary[]>>((acc, list) => {
                const leadsForList = data.leads.filter((lead) => (lead.listId || "legacy") === list.listId);
                const topic = leadsForList[0]?.topic || "Unkategorisiert";
                acc[topic] = [...(acc[topic] || []), list];
                return acc;
              }, {})).map(([topic, lists]) => (
                <div key={topic} className="stack" style={{ gap: 10 }}>
                  <h3 style={{ marginBottom: 0 }}>Rubrik: {topic}</h3>
                  {lists.map((list) => {
                    const leadsForList = data.leads.filter((lead) => (lead.listId || "legacy") === list.listId);
                    const isRunning = list.active || Boolean(list.currentlyDialing) || runningListSet.has(list.listId);
                    const traffic = getListTrafficLight({ pending: list.pending, active: list.active, currentlyDialing: list.currentlyDialing, runningList: runningListSet.has(list.listId) });

                    return (
                      <div key={list.listId} className="mini-panel">
                        <div className="row spread" style={{ alignItems: "flex-start", gap: 10 }}>
                          <div>
                            <h3>{list.listName}</h3>
                            <div className="row" style={{ gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                              <span className="pill">Gesamt: {list.total}</span>
                              <span className="pill">Offen: {list.pending}</span>
                              <span className="pill">Angerufen: {list.called}</span>
                              <span className="pill">Termine: {list.appointments}</span>
                              <span className="pill">Wiedervorlagen: {list.callbacks}</span>
                              <span className="pill">Absagen: {list.rejections}</span>
                            </div>
                          </div>
                          <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            <span
                              className="pill"
                              title={traffic.text}
                              style={{
                                background: traffic.color === "blue" ? "#dbeafe" : traffic.color === "green" ? "#dcfce7" : "#fee2e2",
                                color: traffic.color === "blue" ? "#1d4ed8" : traffic.color === "green" ? "#166534" : "#991b1b",
                                border: `1px solid ${traffic.color === "blue" ? "#93c5fd" : traffic.color === "green" ? "#86efac" : "#fca5a5"}`,
                              }}
                            >
                              Ampel: {traffic.label}
                            </span>
                            {isRunning ? <span className="pill campaign-status running">Status: laeuft</span> : <span className="pill campaign-status stopped">Status: gestoppt</span>}
                            <button className="btn ghost" onClick={() => setSelectedListForEvaluation(list)}>Auswertung</button>
                            <button
                              className="btn"
                              onClick={() => void controlCampaignList(list.listId, "start")}
                              disabled={busy || isRunning || list.pending === 0}
                            >
                              Starten
                            </button>
                            <button
                              className="btn ghost"
                              onClick={() => void controlCampaignList(list.listId, "stop")}
                              disabled={busy || !isRunning}
                            >
                              Stoppen
                            </button>
                            <button
                              className="btn danger"
                              onClick={() => void controlCampaignList(list.listId, "delete")}
                              disabled={busy}
                            >
                              Loeschen
                            </button>
                          </div>
                        </div>

                        <table className="top-gap">
                          <thead>
                            <tr><th>Firma</th><th>Ort</th><th>Ansprechpartner</th><th>Telefon</th><th>Email</th><th>Thema</th><th>Status</th><th>Ampel</th></tr>
                          </thead>
                          <tbody>
                            {leadsForList.filter((lead) => {
                              if (leadStatusFilter && lead.status !== leadStatusFilter) return false;
                              if (!leadSearch) return true;
                              const q = leadSearch.toLowerCase();
                              return (
                                lead.company.toLowerCase().includes(q) ||
                                (lead.contactName || "").toLowerCase().includes(q) ||
                                (lead.phone || "").includes(q) ||
                                (lead.directDial || "").includes(q) ||
                                (lead.email || "").toLowerCase().includes(q)
                              );
                            }).map((lead) => (
                              <tr key={lead.id}>
                                <td>
                                  <button
                                    className="link-button"
                                    onClick={() => setSelectedLeadForHistory(lead)}
                                    title="Auftragshistorie anzeigen"
                                  >
                                    <strong>{lead.company}</strong>
                                  </button>
                                </td>
                                <td style={{ fontSize: "0.9rem" }}>{lead.addressCity || lead.location || "-"}</td>
                                <td>{lead.contactName || "-"}</td>
                                <td style={{ fontSize: "0.85rem" }}>{lead.phone || lead.directDial || "-"}</td>
                                <td style={{ fontSize: "0.85rem", wordBreak: "break-word", maxWidth: "200px" }}>{lead.email || "-"}</td>
                                <td>{lead.topic}</td>
                                <td>{lead.status}</td>
                                <td>
                                  <span className={`auftrag-ampel ${leadAmpelById[lead.id]?.tone || "info"}`} title={leadAmpelById[lead.id]?.text || ""}>
                                    {leadAmpelById[lead.id]?.label || "Blau"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "calendar" ? (
      <section className="stack top-section">
        <CollapsiblePanel title="Kalender" defaultOpen>
          {currentUser?.calendarFeedToken ? (
            <div className="mini-panel bottom-gap">
              <h3>Kalender abonnieren</h3>
              <p className="subtle">
                Fuegen Sie diese URL in Outlook/Google/Apple als Internet-Kalender hinzu, um Ihre Gloria-Termine automatisch synchron zu halten.
              </p>
              <div className="row top-gap" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
                <input
                  readOnly
                  value={`${typeof window !== "undefined" ? window.location.origin : ""}/api/calendar/feed/${currentUser.calendarFeedToken}`}
                  onFocus={(event) => event.currentTarget.select()}
                  style={{ flex: 1, minWidth: "20rem" }}
                />
                <button
                  className="btn"
                  onClick={() => {
                    const url = `${window.location.origin}/api/calendar/feed/${currentUser.calendarFeedToken}`;
                    void navigator.clipboard.writeText(url);
                  }}
                >
                  Link kopieren
                </button>
              </div>
            </div>
          ) : null}

          <div className="row spread">
            <strong>
              {new Intl.DateTimeFormat("de-DE", {
                month: "long",
                year: "numeric",
              }).format(calendarMonth)}
            </strong>
            <div className="row">
              <button
                className="btn ghost"
                onClick={() =>
                  setCalendarMonth(
                    (current) => new Date(current.getFullYear(), current.getMonth() - 1, 1),
                  )
                }
              >
                ← Monat zurück
              </button>
              <button
                className="btn ghost"
                onClick={() =>
                  setCalendarMonth(
                    (current) => new Date(current.getFullYear(), current.getMonth() + 1, 1),
                  )
                }
              >
                Monat vor →
              </button>
            </div>
          </div>

          <div className="calendar-grid top-gap">
            {["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"].map((weekday) => (
              <div key={weekday} className="calendar-weekday">{weekday}</div>
            ))}
            {calendarDays.map((day) => {
              const isSelected = day.key === selectedDayKey;
              return (
                <button
                  key={day.key}
                  className={`calendar-day ${day.inMonth ? "" : "outside"} ${isSelected ? "selected" : ""}`}
                  onClick={() => setSelectedDayKey(day.key)}
                >
                  <span>{day.date.getDate()}</span>
                  <small>{day.items.length > 0 ? `${day.items.length} Termin(e)` : "-"}</small>
                </button>
              );
            })}
          </div>

          <div className="calendar-detail top-gap">
            <div className="mini-panel">
              <h3>
                Termine am {new Intl.DateTimeFormat("de-DE", { dateStyle: "full" }).format(new Date(selectedDayKey))}
              </h3>
              {selectedDayAppointments.length > 0 ? (
                <div className="calendar-list top-gap">
                  {selectedDayAppointments.map((report) => (
                    <button
                      key={report.id}
                      className="calendar-item"
                      onClick={() => setSelectedReport(report)}
                    >
                      <strong>{formatDate(report.appointmentAt)}</strong>
                      <span>{report.company}{report.contactName ? ` · ${report.contactName}` : ""}</span>
                      <small>{report.topic}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="subtle top-gap">Für diesen Tag sind noch keine Termine eingetragen.</p>
              )}
            </div>
            <div className="mini-panel">
              <h3>Automatische Einträge</h3>
              <p className="subtle top-gap">
                Gloria trägt Termine automatisch nach dem Telefonat ein. Der Gesprächsreport wird direkt mit dem Termin verknüpft und ist per Klick im Detaildialog einsehbar.
              </p>
              <p className="subtle top-gap">
                Quelle: Telefonie-Webhook und Abschlussreport.
              </p>
            </div>
          </div>
        </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "compliance" ? (
      <section className="stack top-section">
              <CollapsiblePanel title="Compliance & Ablauf" defaultOpen>
                <p className="subtle">
                  Dieser Bereich dokumentiert die verbindlichen Leitplanken für Gloria im Live-Telefonieprozess.
                </p>

                <p className="subtle top-gap"><strong>1) Rolle, Offenlegung und Verantwortlichkeit</strong></p>
                <ul>
                  <li>Gloria stellt sich zu Beginn jedes Gesprächs eindeutig als digitale Vertriebsassistentin der Agentur Duic in Sprockhövel vor.</li>
                  <li>Gloria handelt im Auftrag von Matthias Duic und nutzt ausschließlich die hinterlegten, freigegebenen Topic Policies für das jeweilige Thema (z. B. PKV, GKV, bKV, Energie, Gewerbe).</li>
                  <li>Im Empfangskontakt verfolgt Gloria ausschließlich das Ziel einer korrekten Weiterleitung.</li>
                  <li>Im Entscheidergespräch führt Gloria ein fachlich korrektes Orientierungsgespräch mit dem Ziel der Terminvereinbarung.</li>
                  <li>Gloria trifft keine rechtsverbindlichen Aussagen, gibt keine Tarifempfehlungen und keine individuelle Beratung.</li>
                </ul>

                <p className="subtle top-gap"><strong>2) Verhaltensregeln und Gesprächsführung</strong></p>
                <ul>
                  <li>Gloria kommuniziert kurz, klar, höflich, professionell und lösungsorientiert.</li>
                  <li>Gloria verwendet keine erfundenen Fakten und argumentiert ausschließlich auf Basis der hinterlegten Informationen.</li>
                  <li>Gesprächsziele sind Terminvereinbarung, Wiedervorlage (mit dokumentiertem Zeitpunkt) oder eine klare Absage.</li>
                  <li>Während Warteschleifen oder beim Durchstellen befindet sich Gloria im Listen-Only-Modus und startet erst, wenn ein realer Gesprächspartner spricht.</li>
                  <li>Bei Terminierung bietet Gloria konkrete Zeitoptionen an; passen diese nicht, kann der Gesprächspartner eigene Vorschläge machen.</li>
                </ul>

                <p className="subtle top-gap"><strong>3) Gesprächsdokumentation (DSGVO-konform)</strong></p>
                <ul>
                  <li>Gesprächsergebnis, Zusammenfassung und textbasierter Gesprächsverlauf werden im Report dokumentiert.</li>
                  <li>Die Reportdaten werden ausschließlich für Nachbearbeitung, Terminverwaltung und Qualitätskontrolle verwendet.</li>
                  <li>Das Dashboard zeigt keine Tonaufnahmen oder Wiedergabefunktionen an.</li>
                </ul>

                <p className="subtle top-gap"><strong>4) Technischer Prozessablauf</strong></p>
                <ul>
                  <li>Start des Gesprächs über die Telnyx-Call-APIs.</li>
                  <li>Telnyx media streaming: inbound + outbound audio über WebSocket nach /telnyx-stream auf Worker.</li>
                  <li>Die Rollenlogik (Empfang vs. Entscheider) wird kontinuierlich bewertet.</li>
                  <li>Topic-Policy-Fortschritt und Zustände werden signiert im Call-State geführt.</li>
                  <li>Nach Gesprächsende schreibt Gloria den vollständigen Report über /api/calls/webhook zurück ins System.</li>
                  <li>Kalender- und Report-Ansichten beziehen Termine direkt aus den gespeicherten Gesprächsreports.</li>
                </ul>

                <p className="subtle top-gap"><strong>5) Datenschutz, Datenspeicherung und Löschung (DSGVO-konform)</strong></p>
                <p className="subtle top-gap"><strong>5.1 Speicherort</strong></p>
                <ul>
                  <li>Primäre Speicherung erfolgt in PostgreSQL, sobald DATABASE_URL gesetzt ist.</li>
                  <li>Fallback ohne Datenbank: lokale JSON-Dateien unter /data/ (z. B. leads.json, reports.json, topic-policies.json, report-database.json, conversation-events.json).</li>
                  <li>Es werden keine Tonaufnahmen im Dashboard verarbeitet oder bereitgestellt.</li>
                </ul>

                <p className="subtle top-gap"><strong>5.2 Verarbeitete Daten</strong></p>
                <p className="subtle">Verarbeitet werden ausschließlich für den Zweck der Gesprächsdurchführung erforderliche Daten, unter anderem:</p>
                <ul>
                  <li>Firmenname</li>
                  <li>Ansprechpartner</li>
                  <li>Thema des Gesprächs</li>
                  <li>Gesprächsergebnis</li>
                  <li>Termin oder Wiedervorlage</li>
                  <li>Einwilligungsstatus</li>
                  <li>Anzahl der Kontaktversuche</li>
                  <li>Gesprächszusammenfassung</li>
                </ul>

                <p className="subtle top-gap"><strong>5.3 Speicherdauer</strong></p>
                <ul>
                  <li>Alle Gesprächsdaten werden maximal 30 Tage gespeichert, sofern keine gesetzliche Pflicht zur längeren Aufbewahrung besteht.</li>
                  <li>Nach Ablauf der 30 Tage werden die Daten automatisch gelöscht.</li>
                  <li>Gesprächsreports werden ebenfalls nach 30 Tagen gelöscht oder sofort, wenn der Nutzer dies verlangt.</li>
                </ul>

                <p className="subtle top-gap"><strong>5.4 Rechte der Betroffenen</strong></p>
                <p className="subtle">Betroffene können jederzeit:</p>
                <ul>
                  <li>Auskunft über gespeicherte Daten verlangen</li>
                  <li>Berichtigung verlangen</li>
                  <li>Löschung verlangen</li>
                  <li>Widerspruch gegen Verarbeitung einlegen</li>
                  <li>Die Löschfunktion für Reports ist im Dashboard integriert und wirkt sofort auf die gespeicherten Datensätze.</li>
                </ul>

                <p className="subtle top-gap"><strong>6) Externe Dienstleister im Laufzeitpfad</strong></p>
                <ul>
                  <li>Telnyx: Telefonie und Verbindungsstatus</li>
                  <li>OpenAI: Gesprächslogik in freien Dialogphasen</li>
                  <li>ElevenLabs (optional): Sprachsynthese</li>
                </ul>
                <p className="subtle">Alle Dienstleister werden ausschließlich im Rahmen der Auftragsverarbeitung genutzt. Es findet keine Weitergabe zu Werbezwecken statt.</p>
              </CollapsiblePanel>
      </section>
      ) : null}

      {activeView === "settings" ? (
      <section className="stack top-section">
              <CollapsiblePanel title="Globale Gloria-Steuerung" defaultOpen>
                <div className="settings-overview-grid">
                  <div className="mini-panel settings-callout">
                    <h3>Accountweite Standards</h3>
                    <p className="subtle">
                      Hier definieren Sie, wie Gloria kontoweit auftreten soll: sprachlich führend, faktenbasiert,
                      kurz im Dialog und sauber in der Eskalation zu einem Menschen.
                    </p>
                    <ul className="subtle playbook-fixed-list top-gap">
                      <li>Global gilt: maximal zwei kurze Sätze und dann eine klare Frage statt Monologe oder Skriptblöcke.</li>
                      <li>Gloria soll führen wie eine starke Vertriebsassistentin: warm, präzise, reaktiv und ohne Callcenter-Ton.</li>
                      <li>Keine erfundenen Zahlen, keine leeren Metaphern, keine unklaren Versprechen. Relevanz zuerst, danach der nächste Schritt.</li>
                      <li>Menschliche Weiterleitung nur bei echtem Wunsch oder klarer KI-Ablehnung, dann mit sauberer Rückfallzusage zu Jutta Brost.</li>
                      <li>Die Batch-Übernahme schreibt diese Standards direkt in die persistenten Topic Policies Ihres Kontos.</li>
                    </ul>
                    <p className="subtle top-gap">
                      Diese Ebene ist bewusst härter formuliert als einzelne Themen-Prompts: Sie setzt die Grundhaltung,
                      an die sich jedes Thema anschließen muss.
                    </p>
                    <div className="row top-gap">
                      <button className="btn" onClick={() => void applyRecommendedPlaybooksToAccount()} disabled={busy}>
                        Alle Topic Policies vorbefüllen
                      </button>
                    </div>
                  </div>

                  <div className="mini-panel settings-callout">
                    <h3>Stimme & Aussprache prüfen</h3>
                    <p className="subtle">
                      Diese Vorschau prüft Stimme, Tempo und Aussprache für ein Thema. Gesprächsführung,
                      Einwände und Terminierung werden nur in einem echten Testanruf geprüft.
                    </p>
                    <div className="row top-gap">
                      {availableVoices.length > 0 ? (
                        <select value={selectedVoiceId} onChange={(event) => setSelectedVoiceId(event.target.value)}>
                          {availableVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                        </select>
                      ) : null}
                      <select value={voiceTopic} onChange={(event) => setVoiceTopic(event.target.value as Topic)}>
                        {voiceTopicGroups.map((group) => (
                          <optgroup key={group.label} label={group.label}>
                            {group.topics.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                          </optgroup>
                        ))}
                      </select>
                      <button className="btn" onClick={() => void testVoice()} disabled={busy}>
                        {busy ? "Vorschau lädt ..." : "Stimmvorschau abspielen"}
                      </button>
                    </div>
                    <div className="code-box top-gap">{voicePreview || "Noch keine Vorschau geladen."}</div>
                    {voiceAudioUrl ? <audio controls src={voiceAudioUrl} className="audio-player" /> : null}
                    <div className="row top-gap">
                      <button className="btn ghost" onClick={() => setActiveView("calls")}>
                        Echten Testanruf vorbereiten
                      </button>
                    </div>
                  </div>
                </div>

                <div className="mini-panel top-gap">
                  <h3>Gloria lernt aus Gesprächen</h3>
                  <ul>
                    {learning.globalSummary.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                  <div className="insight-grid">
                    {learning.insights.map((insight) => (
                      <div key={insight.topic} className="mini-panel">
                        <h3>{insight.topic}</h3>
                        <p className="subtle">{insight.totalConversations} Gespräche · {insight.appointmentRate}% Terminquote</p>
                        <ul>
                          {insight.recommendations.slice(0, 2).map((recommendation) => <li key={recommendation}>{recommendation}</li>)}
                        </ul>
                        <button className="btn ghost" onClick={() => void applyLearning(insight.topic)} disabled={busy}>Optimierung übernehmen</button>
                        <button className="btn" onClick={() => void optimizeWithAI(insight.topic)} disabled={busy} style={{ marginLeft: 6 }}>KI-Optimierung (Vorschau)</button>
                      </div>
                    ))}
                  </div>
                </div>
              </CollapsiblePanel>

              <CollapsiblePanel title="Themen-Topic-Policy" defaultOpen>
                <div className="row spread">
                  <h2>Themen-Topic-Policy</h2>
                  <div className="row">
                    <select value={detailTopic} onChange={(event) => setDetailTopic(event.target.value as Topic)}>
                      {visiblePlaybookTopicGroups.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.topics.map((topic) => (
                            <option key={topic} value={topic}>{topic}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <button className="btn ghost" onClick={() => setShowNewTopicForm((v) => !v)} style={{ marginLeft: 8 }}>+ Neues Thema</button>
                  </div>
                </div>
                <div className="playbook-category-tabs top-gap">
                  <div className="playbook-category-layout">
                    <aside className="playbook-category-sidebar">
                      {playbookCategoryTabs.map((category) => {
                        const count = playbookCategoryCounts.get(category) || 0;
                        return (
                          <button
                            key={category}
                            type="button"
                            className={`btn ghost playbook-category-tab ${playbookCategoryFilter === category ? "active" : ""}`}
                            onClick={() => setPlaybookCategoryFilter(category)}
                          >
                            <span>{category}</span>
                            <small>{count}</small>
                          </button>
                        );
                      })}
                    </aside>
                    <div className="playbook-topic-strip">
                      <span className="playbook-kicker">Schnellauswahl Themen</span>
                      <div className="playbook-topic-pill-list">
                        {visiblePlaybookTopics.map((topic) => (
                          <button
                            key={topic}
                            type="button"
                            className={`btn ghost playbook-topic-pill ${detailTopic === topic ? "active" : ""}`}
                            onClick={() => setDetailTopic(topic as Topic)}
                          >
                            {topic}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
                <p className="subtle top-gap">
                  Kategorie-Filter aktiv: <strong>{playbookCategoryFilter}</strong>
                </p>
                {showNewTopicForm ? (
                  <div className="row top-gap">
                    <input
                      type="text"
                      placeholder="Thema eingeben, z. B. Immobilienfinanzierung"
                      value={newTopicInput}
                      onChange={(e) => setNewTopicInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleAddNewTopic(); }}
                      style={{ flex: 1 }}
                    />
                    <button className="btn" onClick={handleAddNewTopic} disabled={!newTopicInput.trim()} style={{ marginLeft: 8 }}>Anlegen</button>
                    <button className="btn ghost" onClick={() => { setShowNewTopicForm(false); setNewTopicInput(""); }} style={{ marginLeft: 4 }}>Abbrechen</button>
                  </div>
                ) : null}

                {activeDraft ? (
                  <>
                    <div className="playbook-overview top-gap">
                      <div className="playbook-overview-card primary">
                        <span className="playbook-kicker">Topic-Policy-Cockpit</span>
                        <h3>{detailTopic}</h3>
                        <div className="playbook-topic-meta">
                          <span className="playbook-topic-chip">{detailTopicCategory}</span>
                        </div>
                        <p>
                          Hier sehen und ändern Sie den aktuellen Gesprächsstand für dieses Thema: gemeinsame
                          Leitplanken sowie das getrennte Verhalten am Empfang und beim Entscheider.
                        </p>
                      </div>
                      <div className="playbook-overview-card stat">
                        <span className="playbook-kicker">Konfiguration</span>
                        <strong>{countFilledTopicPolicyFields(activeDraft)}/{TOPIC_POLICY_EDITABLE_FIELDS.length}</strong>
                        <p>aktive Bereiche für dieses Thema</p>
                      </div>
                      <div className="playbook-overview-card stat">
                        <span className="playbook-kicker">Pflichtfragen</span>
                        <strong>{normalizeLineCount(activeDraft.requiredQuestions)}</strong>
                        <p>in Terminierung oder Mail zu sichernde Fragen</p>
                      </div>
                      <div className="playbook-overview-card stat">
                        <span className="playbook-kicker">Modell</span>
                        <strong>{TOPIC_POLICY_EDITABLE_FIELDS.length}</strong>
                        <p>wirksame Steuerfelder pro Thema</p>
                      </div>
                    </div>

                    <p className="subtle top-gap">
                      Änderungen gelten nur für Ihren Account und greifen sofort für neue Gespräche.
                      Kurze, klare Steuertexte sind hier meist wirksamer als lange Textsammlungen.
                    </p>

                    <div className="playbook-grid top-gap">
                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>1. Ziel des Anrufs</strong> <span className="subtle">(gewünschtes Ergebnis)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Beschreiben Sie, welches Ergebnis Gloria anstrebt. Das ist eine Orientierung für das Gespräch, kein starres Skript.
                        </p>
                        <textarea
                          value={activeDraft.callObjective ?? ""}
                          rows={5}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], callObjective: event.target.value } }))}
                        />
                      </div>

                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>2. Worum es bei dem Thema geht</strong> <span className="subtle">(Nutzen und Einordnung)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Hier beschreiben Sie fachlich, worum es im Thema geht, welchen Nutzen der Interessent davon hat
                          und wie Gloria das Thema inhaltlich erklären soll.
                        </p>
                        <textarea
                          value={activeDraft.topicSummary ?? ""}
                          rows={8}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], topicSummary: event.target.value } }))}
                        />
                      </div>

                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>3. Verhalten & Tonalität</strong> <span className="subtle">(wie Gloria führt)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Beschreiben Sie, wie Gloria sprechen, führen und auf den Kunden reagieren soll.
                        </p>
                        <textarea
                          value={activeDraft.behavior ?? ""}
                          rows={9}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], behavior: event.target.value } }))}
                        />
                      </div>

                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>4. Harte Regeln & Verbote</strong> <span className="subtle">(was Gloria immer oder nie tun darf)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Hier definieren Sie Reihenfolgen, No-Gos, Pflichtverhalten und Grenzen für dieses Thema.
                        </p>
                        <textarea
                          value={activeDraft.conversationGuardrails ?? ""}
                          rows={9}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], conversationGuardrails: event.target.value } }))}
                        />
                      </div>

                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>5. Fragen nach Terminbestätigung</strong> <span className="subtle">(eine Frage pro Zeile)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Diese Fragen stellt Gloria erst nach einem bestätigten Termin, einzeln und nur solange der Kunde mitmacht. Bei Ablehnung oder Zeitdruck lässt sie sie aus.
                        </p>
                        <textarea
                          value={activeDraft.requiredQuestions ?? ""}
                          rows={10}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], requiredQuestions: event.target.value } }))}
                        />
                      </div>

                      <div className="mini-panel playbook-card">
                        <h3 className="sub-heading"><strong>6. Beispielantworten</strong> <span className="subtle">(eine Formulierung pro Zeile)</span></h3>
                        <p className="subtle" style={{ marginTop: 0 }}>
                          Diese Sätze sind Stilvorlagen für natürliche Antworten. Gloria soll sie sinngemäß nutzen und nicht mechanisch wiederholen.
                        </p>
                        <textarea
                          value={activeDraft.exampleSentences ?? ""}
                          rows={10}
                          onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], exampleSentences: event.target.value } }))}
                        />
                      </div>
                    </div>

                    <div className="mini-panel playbook-card top-gap">
                      <h3 className="sub-heading"><strong>7. Empfang & Weiterleitung</strong> <span className="subtle">(Glorias Startrolle)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Gloria geht zu Gesprächsbeginn grundsätzlich von einem Empfang aus. Erst wenn die Person klar
                        signalisiert, selbst zuständig zu sein, wechselt sie in das Entscheidergespräch.
                      </p>

                      <div className="playbook-grid">
                        <div>
                          <h4 className="sub-heading">Ziel am Empfang</h4>
                          <textarea
                            value={activeDraft.gatekeeperTask ?? ""}
                            rows={6}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], gatekeeperTask: event.target.value } }))}
                          />
                        </div>

                        <div>
                          <h4 className="sub-heading">Verhalten am Empfang</h4>
                          <textarea
                            value={activeDraft.gatekeeperBehavior ?? ""}
                            rows={6}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], gatekeeperBehavior: event.target.value } }))}
                          />
                        </div>

                        <div>
                          <h4 className="sub-heading">Kurzer Anlass bei Rückfrage</h4>
                          <textarea
                            value={activeDraft.receptionTopicReason ?? ""}
                            rows={6}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], receptionTopicReason: event.target.value } }))}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="mini-panel playbook-card top-gap">
                      <h3 className="sub-heading"><strong>8. Entscheidergespräch</strong> <span className="subtle">(Relevanz, Führung und Ergebnis)</span></h3>
                      <p className="subtle" style={{ marginTop: 0 }}>
                        Diese Werte greifen erst, wenn die Zielperson erreicht wurde oder die Person ihre Zuständigkeit bestätigt hat.
                      </p>

                      <div className="playbook-grid">
                        <div>
                          <h4 className="sub-heading">Aufgabe beim Entscheider</h4>
                          <textarea
                            value={activeDraft.decisionMakerTask ?? ""}
                            rows={7}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], decisionMakerTask: event.target.value } }))}
                          />
                        </div>

                        <div>
                          <h4 className="sub-heading">Verhalten beim Entscheider</h4>
                          <textarea
                            value={activeDraft.decisionMakerBehavior ?? ""}
                            rows={7}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], decisionMakerBehavior: event.target.value } }))}
                          />
                        </div>

                        <div>
                          <h4 className="sub-heading">Fachlicher Kontext & Kundennutzen</h4>
                          <textarea
                            value={activeDraft.decisionMakerContext ?? ""}
                            rows={7}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], decisionMakerContext: event.target.value } }))}
                          />
                        </div>

                        <div>
                          <h4 className="sub-heading">Erfolgskriterium / nächster Schritt</h4>
                          <textarea
                            value={activeDraft.appointmentGoal ?? ""}
                            rows={7}
                            onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], appointmentGoal: event.target.value } }))}
                          />
                        </div>
                      </div>
                    </div>

                    <details className="mini-panel playbook-card playbook-details top-gap" open>
                      <summary><strong>9. Gesprächseinstieg & Dialoganker</strong></summary>
                      <p className="subtle">
                        Konkrete Formulierungsanker für Einstieg, Anlass, Bedarf und Nutzen. Gloria nutzt sie sinngemäß und nicht als starres Skript.
                      </p>
                      <div className="playbook-grid">
                        <div>
                          <h4 className="sub-heading">Begrüßung am Empfang</h4>
                          <textarea value={activeDraft.greetingGatekeeper ?? ""} rows={5} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], greetingGatekeeper: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Begrüßung beim Entscheider</h4>
                          <textarea value={activeDraft.greetingDecisionMaker ?? ""} rows={5} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], greetingDecisionMaker: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Grund des Anrufs</h4>
                          <textarea value={activeDraft.reasonForCall ?? ""} rows={5} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], reasonForCall: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Relevanzfrage</h4>
                          <textarea value={activeDraft.relevanceQuestion ?? ""} rows={5} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], relevanceQuestion: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Beitrags- oder Situationsfrage</h4>
                          <textarea value={activeDraft.contributionQuestion ?? ""} rows={5} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], contributionQuestion: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Hochrechnung / Nutzenbrücke</h4>
                          <textarea value={activeDraft.projectionText ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], projectionText: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Problemaufbau</h4>
                          <textarea value={activeDraft.problemBuildup ?? ""} rows={7} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], problemBuildup: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Übergang zum nächsten Schritt</h4>
                          <textarea value={activeDraft.conceptTransition ?? ""} rows={7} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], conceptTransition: event.target.value } }))} />
                        </div>
                      </div>
                    </details>

                    <details className="mini-panel playbook-card playbook-details top-gap">
                      <summary><strong>10. Fachwissen, Belege & Einwände</strong></summary>
                      <p className="subtle">Themenspezifischer Wissensrahmen und erlaubte Reaktionslinien für Rückfragen und Einwände.</p>
                      <div className="playbook-grid">
                        <div>
                          <h4 className="sub-heading">Kernwissen für die KI</h4>
                          <textarea value={activeDraft.aiKeyInfo ?? ""} rows={9} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], aiKeyInfo: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Erlaubtes Wissen & Grenzen</h4>
                          <textarea value={activeDraft.knowledge ?? ""} rows={9} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], knowledge: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Belegpunkte / belastbare Fakten</h4>
                          <textarea value={activeDraft.proofPoints ?? ""} rows={8} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], proofPoints: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Einwandbibliothek</h4>
                          <textarea value={activeDraft.objectionResponses ?? ""} rows={8} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], objectionResponses: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Aktiver Einwandleitfaden</h4>
                          <textarea value={activeDraft.objectionHandling ?? ""} rows={7} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], objectionHandling: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Menschliche Übergabe</h4>
                          <textarea value={activeDraft.transferHandling ?? ""} rows={7} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], transferHandling: event.target.value } }))} />
                        </div>
                      </div>
                    </details>

                    <details className="mini-panel playbook-card playbook-details top-gap">
                      <summary><strong>11. Terminierung & vorhandene Bausteine</strong></summary>
                      <p className="subtle">Abschluss, Bestätigung und bestehende Fallback-Texte des gewählten Themas.</p>
                      <div className="playbook-grid">
                        <div>
                          <h4 className="sub-heading">Terminübergang / Abschluss</h4>
                          <textarea value={activeDraft.close ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], close: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Terminbestätigung</h4>
                          <textarea value={activeDraft.appointmentConfirmation ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], appointmentConfirmation: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Freigegebene Terminslots</h4>
                          <textarea value={activeDraft.availableAppointmentSlots ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], availableAppointmentSlots: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Einwilligungsfrage</h4>
                          <textarea value={activeDraft.consentPrompt ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], consentPrompt: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Bestehender Einstieg (Fallback)</h4>
                          <textarea value={activeDraft.opener ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], opener: event.target.value } }))} />
                        </div>
                        <div>
                          <h4 className="sub-heading">Bestehende Bedarfsfrage (Fallback)</h4>
                          <textarea value={activeDraft.discovery ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], discovery: event.target.value } }))} />
                        </div>
                      </div>
                    </details>

                    {normalizeTopicKey(detailTopic).includes("private krankenversicherung") ? (
                      <details className="mini-panel playbook-card playbook-details top-gap">
                        <summary><strong>12. PKV-Terminvorbereitung</strong></summary>
                        <p className="subtle">Optionale Vorbereitung nach bestätigtem Termin; vorhandene Werte werden unverändert angezeigt.</p>
                        <div className="playbook-grid">
                          <div>
                            <h4 className="sub-heading">Einleitung der Basisfragen</h4>
                            <textarea value={activeDraft.pkvHealthIntro ?? ""} rows={6} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], pkvHealthIntro: event.target.value } }))} />
                          </div>
                          <div>
                            <h4 className="sub-heading">Basis- und Gesundheitsfragen</h4>
                            <textarea value={activeDraft.pkvHealthQuestions ?? ""} rows={12} onChange={(event) => setDraftScripts((c) => ({ ...c, [detailTopic]: { ...c[detailTopic], pkvHealthQuestions: event.target.value } }))} />
                          </div>
                        </div>
                      </details>
                    ) : null}

                    <div className="row top-gap">
                      <button className="btn" onClick={() => void saveScript(detailTopic)} disabled={busy}>Topic Policy speichern</button>
                      <span className="subtle">Die Topic Policy wird gespeichert und sofort von Gloria für neue Gespräche verwendet.</span>
                    </div>
                    {saveStatus ? (
                      <p
                        className="subtle"
                        role="status"
                        style={{
                          marginTop: 8,
                          color: saveStatus.type === "success" ? "#1f7a42" : "#b42318",
                          fontWeight: 700,
                        }}
                      >
                        {saveStatus.message}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="subtle">Für dieses Thema ist noch keine Topic Policy geladen.</p>
                )}
              </CollapsiblePanel>

              <CollapsiblePanel title="Technische Systemregeln" defaultOpen>
                <div className="settings-overview-grid">
                  <div className="mini-panel settings-callout">
                    <h3>Fest im System verdrahtet</h3>
                    <ul className="subtle playbook-fixed-list top-gap">
                      <li>Technische Audio- und Pausenmeldungen waehrend Streaming oder Fehlerfaellen.</li>
                      <li>Das eigentliche Telnyx-Transferziel und die technische Weiterleitung an Jutta Brost.</li>
                      <li>Globale Phasenlogik wie Terminbestaetigung, Websocket-Handling und feste Sicherheitsregeln.</li>
                    </ul>
                  </div>
                  <div className="mini-panel settings-callout">
                    <h3>Technische Hinweise</h3>
                    <ul className="subtle playbook-fixed-list top-gap">
                      <li>Topic Policies steuern den Gespraechsinhalt, nicht aber Telnyx-REST oder den Websocket-Lifecycle.</li>
                      <li>Die Weiterleitung an Menschen wird technisch ueber den Worker und Telnyx umgesetzt; die Topic Policy steuert nur das Wann und Wie der Ansage.</li>
                      <li>Globale Compliance- und Ablaufregeln bleiben separat dokumentiert und sollten nicht in Themenfelder kopiert werden.</li>
                    </ul>
                    <p className="subtle top-gap">Fuer die vollstaendige Dokumentation siehe den Bereich „Compliance & Ablauf“ in der linken Navigation.</p>
                  </div>
                </div>
              </CollapsiblePanel>

              <CollapsiblePanel title="Benutzer & Rufnummern" defaultOpen>
                {currentUser?.role === "master" ? (
                  <>
                    <p className="subtle">Master-Admin Bereich: Benutzer vollständig verwalten – inklusive zugewiesener Rufnummer.</p>

                    <div className="mini-panel top-gap">
                      <h3>Neuen Benutzer anlegen</h3>
                      <div className="field-grid top-gap">
                        <div>
                          <label>Benutzername</label>
                          <input value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
                        </div>
                        <div>
                          <label>Passwort</label>
                          <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                        </div>
                        <div>
                          <label>Vollständiger Name</label>
                          <input value={newRealName} onChange={(event) => setNewRealName(event.target.value)} />
                        </div>
                        <div>
                          <label>Firmenname</label>
                          <input value={newCompanyName} onChange={(event) => setNewCompanyName(event.target.value)} />
                        </div>
                        <div className="full-row">
                          <label>Adresse</label>
                          <input value={newAddress} onChange={(event) => setNewAddress(event.target.value)} placeholder="Straße, PLZ Ort" />
                        </div>
                        <div>
                          <label>E-Mail</label>
                          <input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} />
                        </div>
                        <div>
                          <label>Reale Rufnummer</label>
                          <input value={newRealPhone} onChange={(event) => setNewRealPhone(event.target.value)} placeholder="+49..." />
                        </div>
                        <div>
                          <label>Gesellschaft</label>
                          <input value={newGesellschaft} onChange={(event) => setNewGesellschaft(event.target.value)} placeholder="z. B. Barmenia, Allianz" />
                        </div>
                        <div>
                          <label>Rolle</label>
                          <select value={newRole} onChange={(event) => setNewRole(event.target.value as "master" | "user")}>
                            <option value="user">user</option>
                            <option value="master">master</option>
                          </select>
                        </div>
                      </div>
                      <div className="row top-gap">
                        <button className="btn" onClick={() => void createUserByAdmin()} disabled={busy}>Benutzer anlegen</button>
                      </div>
                      <p className="subtle top-gap" style={{ fontSize: "0.8rem" }}>
                        Hinweis: Die zugewiesene Rufnummer (Anrufer-ID) kann nach dem Anlegen über „Bearbeiten&quot; gesetzt werden.
                      </p>
                    </div>

                    <div className="mini-panel top-gap">
                      <h3>Benutzerliste</h3>
                      <table className="top-gap">
                        <thead>
                          <tr>
                            <th>Benutzername</th>
                            <th>Name</th>
                            <th>Firma</th>
                            <th>Adresse</th>
                            <th>E-Mail</th>
                            <th>Reale Rufnummer</th>
                            <th>Zugew. Rufnummer</th>
                            <th>Gesellschaft</th>
                            <th>Rolle</th>
                            <th style={{ width: 1 }}>Aktion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminUsers.map((entry) => {
                            const isEditing = editingUserId === entry.id;
                            const phone = entry.phoneNumbers?.[0];
                            return (
                              <Fragment key={entry.id}>
                                <tr>
                                  <td>{entry.username}</td>
                                  <td>{entry.realName}</td>
                                  <td>{entry.companyName}</td>
                                  <td>{entry.address || <span className="subtle">—</span>}</td>
                                  <td>{entry.email || <span className="subtle">—</span>}</td>
                                  <td>{entry.realPhone || <span className="subtle">—</span>}</td>
                                  <td>{phone ? `${phone.phoneNumber}${phone.label ? ` (${phone.label})` : ""}` : <span className="subtle">—</span>}</td>
                                  <td>{entry.gesellschaft || <span className="subtle">—</span>}</td>
                                  <td>{entry.role}</td>
                                  <td>
                                    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                                      <button
                                        className="btn ghost"
                                        onClick={() => (isEditing ? cancelEditUser() : startEditUser(entry))}
                                        disabled={busy}
                                      >
                                        {isEditing ? "Abbrechen" : "Bearbeiten"}
                                      </button>
                                      <button
                                        className="btn danger"
                                        onClick={() => void deleteUserByAdmin(entry.id, entry.username)}
                                        disabled={busy || currentUser?.id === entry.id}
                                      >
                                        Löschen
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                                {isEditing && editDraft ? (
                                  <tr>
                                    <td colSpan={10} style={{ background: "var(--surface-soft)" }}>
                                      <div className="field-grid">
                                        <div>
                                          <label>Benutzername</label>
                                          <input value={editDraft.username} onChange={(e) => setEditDraft({ ...editDraft, username: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>Vollständiger Name</label>
                                          <input value={editDraft.realName} onChange={(e) => setEditDraft({ ...editDraft, realName: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>Firmenname</label>
                                          <input value={editDraft.companyName} onChange={(e) => setEditDraft({ ...editDraft, companyName: e.target.value })} />
                                        </div>
                                        <div>
                                          <label>E-Mail</label>
                                          <input type="email" value={editDraft.email} onChange={(e) => setEditDraft({ ...editDraft, email: e.target.value })} />
                                        </div>
                                        <div className="full-row">
                                          <label>Adresse</label>
                                          <input value={editDraft.address} onChange={(e) => setEditDraft({ ...editDraft, address: e.target.value })} placeholder="Straße, PLZ Ort" />
                                        </div>
                                        <div>
                                          <label>Zugewiesene Rufnummer (Anrufer-ID)</label>
                                          <select
                                            value={editDraft.assignedPhone}
                                            onChange={(e) => {
                                              const nextNumber = e.target.value;
                                              const selected = assignedPhoneOptions.find((entry) => entry.number === nextNumber);
                                              setEditDraft({
                                                ...editDraft,
                                                assignedPhone: nextNumber,
                                                assignedLabel: selected?.label || (nextNumber ? editDraft.assignedLabel : ""),
                                              });
                                            }}
                                          >
                                            <option value="">Keine Zuweisung</option>
                                            {assignedPhoneOptions.map((entry) => (
                                              <option key={entry.number} value={entry.number}>
                                                {entry.number} ({entry.label})
                                              </option>
                                            ))}
                                          </select>
                                        </div>
                                        <div>
                                          <label>Label</label>
                                          <input value={editDraft.assignedLabel} onChange={(e) => setEditDraft({ ...editDraft, assignedLabel: e.target.value })} placeholder="z. B. Vertrieb" />
                                        </div>
                                        <div>
                                          <label>Reale Rufnummer</label>
                                          <input value={editDraft.realPhone} onChange={(e) => setEditDraft({ ...editDraft, realPhone: e.target.value })} placeholder="+49..." />
                                        </div>
                                        <div>
                                          <label>Gesellschaft</label>
                                          <input value={editDraft.gesellschaft} onChange={(e) => setEditDraft({ ...editDraft, gesellschaft: e.target.value })} placeholder="z. B. Barmenia, Allianz" />
                                        </div>
                                        <div>
                                          <label>Rolle</label>
                                          <select value={editDraft.role} onChange={(e) => setEditDraft({ ...editDraft, role: e.target.value as "master" | "user" })} disabled={currentUser?.id === entry.id}>
                                            <option value="user">user</option>
                                            <option value="master">master</option>
                                          </select>
                                        </div>
                                        <div>
                                          <label>Stimme (ElevenLabs)</label>
                                          <select value={editDraft.selectedVoiceId} onChange={(e) => setEditDraft({ ...editDraft, selectedVoiceId: e.target.value })}>
                                            <option value="">Gloria Standard</option>
                                            {availableVoices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                                          </select>
                                        </div>
                                        <div className="full-row">
                                          <label>Erlaubte Topic-Policy-Themen (Checkbox-Auswahl; keine Auswahl = alle)</label>
                                          <div
                                            className="top-gap"
                                            style={{
                                              display: "grid",
                                              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                                              gap: 8,
                                            }}
                                          >
                                            {TOPICS.map((topic) => {
                                              const checked = editDraft.allowedPlaybookTopics.includes(topic);
                                              return (
                                                <label key={topic} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                                  <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={(e) => {
                                                      const next = e.target.checked
                                                        ? [...editDraft.allowedPlaybookTopics, topic]
                                                        : editDraft.allowedPlaybookTopics.filter((value) => value !== topic);
                                                      setEditDraft({ ...editDraft, allowedPlaybookTopics: next });
                                                    }}
                                                  />
                                                  <span>{topic}</span>
                                                </label>
                                              );
                                            })}
                                          </div>
                                          <p className="subtle" style={{ marginTop: 8 }}>
                                            Wenn kein Thema markiert ist, darf der Benutzer alle Themen nutzen.
                                          </p>
                                        </div>
                                        <div>
                                          <label>Passwort ändern (leer = unverändert)</label>
                                          <input type="password" value={editDraft.password} onChange={(e) => setEditDraft({ ...editDraft, password: e.target.value })} placeholder="Neues Passwort (mind. 6 Zeichen)" />
                                        </div>
                                      </div>
                                      <div className="row top-gap" style={{ gap: 8 }}>
                                        <button className="btn" onClick={() => void saveEditUser(entry)} disabled={busy}>Speichern</button>
                                        <button className="btn ghost" onClick={cancelEditUser} disabled={busy}>Abbrechen</button>
                                      </div>
                                    </td>
                                  </tr>
                                ) : null}
                              </Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="mini-panel top-gap">
                      <h3>Telefonnummern verwalten</h3>
                      <p className="subtle">
                        Hier sehen Sie alle hinterlegten Telefonnummern und können neue Nummern direkt einem Benutzer zuweisen.
                      </p>
                      <div className="field-grid top-gap">
                        <div>
                          <label>Benutzer</label>
                          <select value={newPhoneUserId} onChange={(event) => setNewPhoneUserId(event.target.value)}>
                            <option value="">Bitte wählen</option>
                            {adminUsers.map((entry) => (
                              <option key={entry.id} value={entry.id}>
                                {entry.username} · {entry.realName}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label>Telefonnummer</label>
                          <input
                            value={newPhoneNumber}
                            onChange={(event) => setNewPhoneNumber(event.target.value)}
                            placeholder="+49..."
                          />
                        </div>
                        <div>
                          <label>Label</label>
                          <input
                            value={newPhoneLabel}
                            onChange={(event) => setNewPhoneLabel(event.target.value)}
                            placeholder="z. B. Vertrieb Inbound"
                          />
                        </div>
                      </div>
                      <div className="row top-gap">
                        <button className="btn" onClick={() => void createPhoneByAdmin()} disabled={busy}>
                          Telefonnummer hinzufügen
                        </button>
                      </div>

                      <table className="top-gap">
                        <thead>
                          <tr>
                            <th>Benutzer</th>
                            <th>Label</th>
                            <th>Rufnummer</th>
                            <th>Status</th>
                            <th style={{ width: 1 }}>Aktion</th>
                          </tr>
                        </thead>
                        <tbody>
                          {managedPhoneNumbers.map((entry) => {
                            const owner = adminUsers.find((user) => user.id === entry.userId);
                            return (
                              <tr key={entry.id}>
                                <td>{owner ? `${owner.username} · ${owner.realName}` : entry.userId}</td>
                                <td>{entry.label}</td>
                                <td>{entry.phoneNumber}</td>
                                <td>{entry.active ? "aktiv" : "inaktiv"}</td>
                                <td>
                                  <button
                                    className="btn danger"
                                    onClick={() => void deletePhoneByAdmin(entry.id, entry.phoneNumber)}
                                    disabled={busy}
                                  >
                                    Löschen
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="subtle">Ihre zugewiesenen Rufnummern:</p>
                    <table className="top-gap">
                      <thead>
                        <tr><th>Label</th><th>Rufnummer</th><th>Status</th></tr>
                      </thead>
                      <tbody>
                        {managedPhoneNumbers.map((entry) => (
                          <tr key={entry.id}>
                            <td>{entry.label}</td>
                            <td>{entry.phoneNumber}</td>
                            <td>{entry.active ? "aktiv" : "inaktiv"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </CollapsiblePanel>
      </section>
      ) : null}

        </div>
      </main>

      {selectedLeadForHistory && (() => {
        const latestReport = selectedLeadReports[0];
        const hasAppointment = selectedLeadReports.some((report) => report.outcome === "Termin");
        const hasRejection = selectedLeadReports.some((report) => report.outcome === "Absage");
        const hasCallback = selectedLeadReports.some((report) => report.outcome === "Wiedervorlage");
        const callbackCount = selectedLeadReports.filter((report) => report.outcome === "Wiedervorlage").length;
        const callCount = selectedLeadReports.length;
        const canEditSensitiveCrmFields = currentUser?.role === "master";
        const openTasks = (selectedLeadForHistory.tasks || []).filter((task) => task.status === "open");
        const doneTasks = (selectedLeadForHistory.tasks || []).filter((task) => task.status === "done");
        const recentActivities = (selectedLeadForHistory.activities || [])
          .slice()
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        const upcomingDate = selectedLeadForHistory.nextCallAt || latestReport?.nextCallAt;
        const statusHeadline = hasAppointment
          ? "Termin vereinbart"
          : hasRejection
            ? "Absage erhalten"
            : hasCallback
              ? "Wiedervorlage aktiv"
              : selectedLeadForHistory.status === "angerufen"
                ? "In Bearbeitung"
                : selectedLeadForHistory.status === "wiedervorlage"
                  ? "Wiedervorlage aktiv"
                  : selectedLeadForHistory.status === "absage"
                    ? "Absage"
                    : selectedLeadForHistory.status === "termin"
                      ? "Termin"
                      : "Offen";

        return (
          <div className="modal-overlay" onClick={() => setSelectedLeadForHistory(null)}>
            <div className="modal lead-history-modal" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedLeadForHistory(null)}>✕</button>
              <h2>Auftragshistorie: {selectedLeadForHistory.company}</h2>
              <p className="subtle" style={{ marginTop: 6 }}>
                Ansprechpartner: {selectedLeadForHistory.contactName || "-"} · Thema: {selectedLeadForHistory.topic}
              </p>

              <div className="row top-gap" style={{ gap: 6, flexWrap: "wrap" }}>
                {([
                  { key: "stammdaten", label: "Stammdaten" },
                  { key: "pipeline", label: "Pipeline" },
                  { key: "historie", label: "Historie" },
                  { key: "kommunikation", label: "Kommunikation" },
                  { key: "termine", label: "Termine" },
                  { key: "aufgaben", label: "Aufgaben" },
                ] as const).map((tab) => (
                  <button
                    key={tab.key}
                    className={`btn ${crmDetailTab === tab.key ? "" : "ghost"}`}
                    style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                    onClick={() => setCrmDetailTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {crmDetailTab === "stammdaten" ? <div className="lead-status-grid top-gap">
                <div className="mini-panel">
                  <label className="lead-kicker">Aktueller Stand</label>
                  <h3 style={{ marginTop: 4 }}>{statusHeadline}</h3>
                  <p className="subtle" style={{ marginTop: 6 }}>
                    Letzter Kontakt: {latestReport ? formatDate(latestReport.conversationDate) : "Noch kein Anruf protokolliert"}
                  </p>
                  <p className="subtle" style={{ marginTop: 6 }}>
                    Nächster geplanter Anruf: {formatDate(upcomingDate)}
                  </p>
                </div>
                <div className="mini-panel">
                  <label className="lead-kicker">Auftragskennzahlen</label>
                  <div className="lead-status-pills top-gap">
                    <span className="status-pill">Anrufversuche: {selectedLeadForHistory.attempts}</span>
                    <span className="status-pill">Reports: {callCount}</span>
                    <span className="status-pill">Wiedervorlagen: {callbackCount}</span>
                    <span className={`status-pill ${hasAppointment ? "ok" : ""}`}>Termin: {hasAppointment ? "Ja" : "Nein"}</span>
                    <span className={`status-pill ${hasRejection ? "danger" : ""}`}>Absage: {hasRejection ? "Ja" : "Nein"}</span>
                    <span className={`status-pill ${hasCallback ? "warn" : ""}`}>Wiedervorlage offen: {hasCallback ? "Ja" : "Nein"}</span>
                  </div>
                </div>
              </div> : null}

              {crmDetailTab === "stammdaten" ? <div className="report-detail-grid top-gap">
                <div className="report-detail-field">
                  <label>Lead-Status</label>
                  <p>{selectedLeadForHistory.status}</p>
                </div>
                <div className="report-detail-field">
                  <label>Kundenart</label>
                  <select
                    value={detailDraft?.customerKind || "firma"}
                    onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), customerKind: e.target.value as "privat" | "firma" }))}
                  >
                    <option value="firma">Firmenkunde</option>
                    <option value="privat">Privatkunde</option>
                  </select>
                </div>
                <div className="report-detail-field">
                  <label>Zuordnung</label>
                  <select
                    value={detailDraft?.customerOwner || ""}
                    disabled={!canEditSensitiveCrmFields}
                    onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), customerOwner: (e.target.value || undefined) as "BarmeniaGothaer" | "Agentur-Duic" | undefined }))}
                  >
                    <option value="">Nicht gesetzt</option>
                    <option value="Agentur-Duic">Agentur-Duic</option>
                    <option value="BarmeniaGothaer">BarmeniaGothaer</option>
                  </select>
                </div>
                <div className="report-detail-field">
                  <label>Ansprechpartner</label>
                  <input value={detailDraft?.contactName || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), contactName: e.target.value }))} />
                </div>
                <div className="report-detail-field">
                  <label>Telefon</label>
                  <input value={detailDraft?.phone || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), phone: e.target.value }))} placeholder="+49..." />
                </div>
                <div className="report-detail-field">
                  <label>Durchwahl</label>
                  <input value={detailDraft?.directDial || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), directDial: e.target.value }))} placeholder="optional" />
                </div>
                <div className="report-detail-field">
                  <label>E-Mail</label>
                  <input value={detailDraft?.email || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), email: e.target.value }))} placeholder="kunde@email.de" />
                </div>
                <div className="report-detail-field">
                  <label>Thema</label>
                  <select value={detailDraft?.topic || selectedLeadForHistory.topic} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), topic: e.target.value as Topic }))}>
                    {TOPICS.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="report-detail-field">
                  <label>Quellliste</label>
                  <p>{selectedLeadForHistory.listName || "Standardliste"}</p>
                </div>
                <div className="report-detail-field report-detail-full">
                  <label>Strasse und Hausnummer</label>
                  <input value={detailDraft?.addressStreet || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), addressStreet: e.target.value }))} placeholder="Beispielweg 12" />
                </div>
                <div className="report-detail-field">
                  <label>PLZ</label>
                  <input value={detailDraft?.addressPostalCode || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), addressPostalCode: e.target.value }))} placeholder="42103" />
                </div>
                <div className="report-detail-field">
                  <label>Stadt</label>
                  <input value={detailDraft?.addressCity || detailDraft?.location || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), addressCity: e.target.value, location: e.target.value }))} placeholder="Wuppertal" />
                </div>
                <div className="report-detail-field">
                  <label>Land</label>
                  <input value={detailDraft?.addressCountry || ""} onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), addressCountry: e.target.value }))} placeholder="Deutschland" />
                </div>
                <div className="report-detail-field">
                  <label>Produkte</label>
                  <input
                    value={(detailDraft?.products || []).join("; ")}
                    onChange={(e) => setDetailDraft((draft) => ({ ...(draft || {}), products: splitProductsInput(e.target.value) }))}
                    placeholder="PKV; Zahn; Pflege"
                  />
                </div>
                <div className="report-detail-field report-detail-full">
                  <label>Notiz</label>
                  <textarea
                    value={leadNoteEdit}
                    onChange={(e) => setLeadNoteEdit(e.target.value)}
                    rows={3}
                    style={{ width: "100%", marginTop: 4, resize: "vertical" }}
                    placeholder="Notiz hinzufügen..."
                  />
                  <button className="btn" style={{ marginTop: 8 }} disabled={busy} onClick={() => void saveLeadDetailsFromModal()}>
                    Kundendaten speichern
                  </button>
                </div>
              </div> : null}

              {crmDetailTab === "pipeline" ? <div className="report-detail-grid top-gap">
                {!canEditSensitiveCrmFields ? <p className="subtle">Pipeline-Felder koennen nur von Master-Usern bearbeitet werden.</p> : null}
                <div className="report-detail-field">
                  <label>Pipeline-Phase</label>
                  <select
                    value={detailDraft?.crmPipeline?.stage || getLeadPipelineStage(selectedLeadForHistory)}
                    disabled={!canEditSensitiveCrmFields}
                    onChange={(e) => setDetailDraft((draft) => ({
                      ...(draft || {}),
                      crmPipeline: {
                        stage: e.target.value as NonNullable<DashboardData["leads"][number]["crmPipeline"]>["stage"],
                        valueEUR: draft?.crmPipeline?.valueEUR,
                        probability: draft?.crmPipeline?.probability,
                        expectedCloseAt: draft?.crmPipeline?.expectedCloseAt,
                        updatedAt: new Date().toISOString(),
                      },
                    }))}
                  >
                    <option value="neu">Neu</option>
                    <option value="qualifiziert">Qualifiziert</option>
                    <option value="angebot">Angebot</option>
                    <option value="verhandlung">Verhandlung</option>
                    <option value="gewonnen">Gewonnen</option>
                    <option value="verloren">Verloren</option>
                  </select>
                </div>
                <div className="report-detail-field">
                  <label>Potentialwert (EUR)</label>
                  <input
                    type="number"
                    min={0}
                    disabled={!canEditSensitiveCrmFields}
                    value={detailDraft?.crmPipeline?.valueEUR ?? ""}
                    onChange={(e) => setDetailDraft((draft) => ({
                      ...(draft || {}),
                      crmPipeline: {
                        stage: draft?.crmPipeline?.stage || getLeadPipelineStage(selectedLeadForHistory),
                        valueEUR: e.target.value ? Number(e.target.value) : undefined,
                        probability: draft?.crmPipeline?.probability,
                        expectedCloseAt: draft?.crmPipeline?.expectedCloseAt,
                        updatedAt: new Date().toISOString(),
                      },
                    }))}
                  />
                </div>
                <div className="report-detail-field">
                  <label>Abschlusswahrscheinlichkeit (%)</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    disabled={!canEditSensitiveCrmFields}
                    value={detailDraft?.crmPipeline?.probability ?? ""}
                    onChange={(e) => setDetailDraft((draft) => ({
                      ...(draft || {}),
                      crmPipeline: {
                        stage: draft?.crmPipeline?.stage || getLeadPipelineStage(selectedLeadForHistory),
                        valueEUR: draft?.crmPipeline?.valueEUR,
                        probability: e.target.value ? Number(e.target.value) : undefined,
                        expectedCloseAt: draft?.crmPipeline?.expectedCloseAt,
                        updatedAt: new Date().toISOString(),
                      },
                    }))}
                  />
                </div>
                <div className="report-detail-field">
                  <label>Voraussichtlicher Abschluss</label>
                  <input
                    type="datetime-local"
                    disabled={!canEditSensitiveCrmFields}
                    value={detailDraft?.crmPipeline?.expectedCloseAt ? new Date(detailDraft.crmPipeline.expectedCloseAt).toISOString().slice(0, 16) : ""}
                    onChange={(e) => setDetailDraft((draft) => ({
                      ...(draft || {}),
                      crmPipeline: {
                        stage: draft?.crmPipeline?.stage || getLeadPipelineStage(selectedLeadForHistory),
                        valueEUR: draft?.crmPipeline?.valueEUR,
                        probability: draft?.crmPipeline?.probability,
                        expectedCloseAt: e.target.value ? new Date(e.target.value).toISOString() : undefined,
                        updatedAt: new Date().toISOString(),
                      },
                    }))}
                  />
                </div>
                <div className="report-detail-field report-detail-full">
                  <button className="btn" style={{ marginTop: 8 }} disabled={busy || !canEditSensitiveCrmFields} onClick={() => void saveLeadDetailsFromModal()}>
                    Pipeline speichern
                  </button>
                </div>
              </div> : null}

              {crmDetailTab === "historie" ? <div className="report-detail-field report-detail-full top-gap">
                <label>Anrufhistorie</label>
                {selectedLeadReports.length > 0 ? (
                  <div className="lead-history-list">
                    {selectedLeadReports.map((report) => (
                      <div key={report.id} className="lead-history-item">
                        <div className="row spread" style={{ alignItems: "flex-start" }}>
                          <div>
                            <strong>{formatDate(report.conversationDate)}</strong>
                            <p className="subtle" style={{ margin: "4px 0 0" }}>
                              Ergebnis: {report.outcome}
                              {report.appointmentAt ? ` · Termin: ${formatDate(report.appointmentAt)}` : ""}
                              {report.nextCallAt ? ` · Nächster Anruf: ${formatDate(report.nextCallAt)}` : ""}
                            </p>
                          </div>
                          <button className="btn ghost" onClick={() => setSelectedReport(report)}>
                            Vollen Report öffnen
                          </button>
                        </div>
                        {report.summary ? (
                          <p className="lead-history-summary">{report.summary.slice(0, 320)}{report.summary.length > 320 ? " ..." : ""}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="subtle" style={{ marginTop: 8 }}>
                    Für diese Firma liegen noch keine Gesprächsreports vor. Der Auftrag ist aktuell im Lead-Status sichtbar und wird bei neuen Anrufen hier automatisch ergänzt.
                  </p>
                )}
              </div> : null}

              {crmDetailTab === "historie" ? <div className="report-detail-field report-detail-full top-gap">
                <label>Aktivitäts-Timeline</label>
                {recentActivities.length === 0 ? (
                  <p className="subtle" style={{ marginTop: 8 }}>Noch keine CRM-Aktivitäten protokolliert.</p>
                ) : (
                  <div className="lead-history-list" style={{ marginTop: 8 }}>
                    {recentActivities.map((activity) => (
                      <div key={activity.id} className="lead-history-item">
                        <strong>{activity.message}</strong>
                        <p className="subtle" style={{ marginTop: 4 }}>{formatDate(activity.createdAt)} · Typ: {activity.type}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div> : null}

              {crmDetailTab === "termine" ? <div className="report-detail-field report-detail-full top-gap">
                <label>Termine mit diesem Kunden</label>
                {selectedLeadReports.filter((report) => report.outcome === "Termin").length === 0 ? (
                  <p className="subtle" style={{ marginTop: 8 }}>Noch keine Termine protokolliert.</p>
                ) : (
                  <table style={{ marginTop: 8 }}>
                    <thead><tr><th>Gespräch</th><th>Terminzeit</th><th>Zusammenfassung</th></tr></thead>
                    <tbody>
                      {selectedLeadReports.filter((report) => report.outcome === "Termin").map((report) => (
                        <tr key={`appointment-${report.id}`}>
                          <td>{formatDate(report.conversationDate)}</td>
                          <td>{formatDate(report.appointmentAt)}</td>
                          <td style={{ maxWidth: 380 }}>{(report.summary || "").slice(0, 140)}{(report.summary || "").length > 140 ? "..." : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div> : null}

              {crmDetailTab === "kommunikation" ? <div className="report-detail-field report-detail-full top-gap">
                <label>E-Mail-Verlauf (Gloria + Outlook)</label>
                {(selectedLeadForHistory.emailHistory || []).length === 0 ? (
                  <p className="subtle" style={{ marginTop: 8 }}>Bisher keine E-Mails dokumentiert.</p>
                ) : (
                  <div className="lead-history-list" style={{ marginTop: 8 }}>
                    {(selectedLeadForHistory.emailHistory || []).map((mail) => (
                      <div key={mail.id} className="lead-history-item">
                        <div className="row spread" style={{ alignItems: "flex-start" }}>
                          <div>
                            <strong>{mail.subject}</strong>
                            <p className="subtle" style={{ margin: "4px 0 0" }}>
                              Quelle: {mail.source === "outlook" ? "Outlook" : "Gloria"} · Empfänger: {mail.to || "-"} · Gesendet: {formatDate(mail.sentAt || mail.createdAt)}
                            </p>
                          </div>
                        </div>
                        {mail.body ? <p className="lead-history-summary">{mail.body}</p> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div> : null}

              {crmDetailTab === "kommunikation" ? <div className="report-detail-field report-detail-full top-gap">
                <label>Outlook-Mail hinzufügen</label>
                <div className="report-detail-grid">
                  <div className="report-detail-field report-detail-full">
                    <label>Betreff *</label>
                    <input value={outlookMailDraft.subject} onChange={(e) => setOutlookMailDraft((d) => ({ ...d, subject: e.target.value }))} placeholder="z. B. Unterlagen angefordert" />
                  </div>
                  <div className="report-detail-field">
                    <label>An</label>
                    <input value={outlookMailDraft.to} onChange={(e) => setOutlookMailDraft((d) => ({ ...d, to: e.target.value }))} placeholder="kunde@email.de" />
                  </div>
                  <div className="report-detail-field">
                    <label>Gesendet am (optional)</label>
                    <input type="datetime-local" value={outlookMailDraft.sentAt} onChange={(e) => setOutlookMailDraft((d) => ({ ...d, sentAt: e.target.value }))} />
                  </div>
                  <div className="report-detail-field report-detail-full">
                    <label>Inhalt</label>
                    <textarea value={outlookMailDraft.body} onChange={(e) => setOutlookMailDraft((d) => ({ ...d, body: e.target.value }))} rows={3} style={{ width: "100%", resize: "vertical" }} />
                  </div>
                </div>
                <button className="btn" style={{ marginTop: 8 }} disabled={busy || !outlookMailDraft.subject.trim()} onClick={() => void addOutlookMailToLead()}>
                  Outlook-Mail speichern
                </button>
              </div> : null}

              {crmDetailTab === "aufgaben" ? <div className="report-detail-field report-detail-full top-gap">
                <label>Aufgaben</label>
                <div className="report-detail-grid" style={{ marginTop: 8 }}>
                  <div className="report-detail-field report-detail-full">
                    <label>Neue Aufgabe *</label>
                    <input value={leadTaskDraft.title} onChange={(e) => setLeadTaskDraft((draft) => ({ ...draft, title: e.target.value }))} placeholder="z. B. Unterlagen nachfassen" />
                  </div>
                  <div className="report-detail-field">
                    <label>Fällig am (optional)</label>
                    <input type="datetime-local" value={leadTaskDraft.dueAt} onChange={(e) => setLeadTaskDraft((draft) => ({ ...draft, dueAt: e.target.value }))} />
                  </div>
                </div>
                <button className="btn" style={{ marginTop: 8 }} disabled={busy || !leadTaskDraft.title.trim()} onClick={() => void addLeadTaskFromModal()}>
                  Aufgabe anlegen
                </button>

                <div className="top-gap">
                  <strong>Offene Aufgaben ({openTasks.length})</strong>
                  {openTasks.length === 0 ? (
                    <p className="subtle" style={{ marginTop: 8 }}>Keine offenen Aufgaben.</p>
                  ) : (
                    <div className="lead-history-list" style={{ marginTop: 8 }}>
                      {openTasks.map((task) => (
                        <div key={task.id} className="lead-history-item">
                          <div className="row spread" style={{ gap: 10, alignItems: "center" }}>
                            <div>
                              <strong>{task.title}</strong>
                              <p className="subtle" style={{ marginTop: 4 }}>Erstellt: {formatDate(task.createdAt)}{task.dueAt ? ` · Fällig: ${formatDate(task.dueAt)}` : ""}</p>
                            </div>
                            <button className="btn ghost" onClick={() => void completeLeadTaskFromModal(task.id)} disabled={busy}>Als erledigt markieren</button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="top-gap">
                  <strong>Erledigte Aufgaben ({doneTasks.length})</strong>
                  {doneTasks.length === 0 ? (
                    <p className="subtle" style={{ marginTop: 8 }}>Noch keine erledigten Aufgaben.</p>
                  ) : (
                    <div className="lead-history-list" style={{ marginTop: 8 }}>
                      {doneTasks.map((task) => (
                        <div key={task.id} className="lead-history-item">
                          <strong>{task.title}</strong>
                          <p className="subtle" style={{ marginTop: 4 }}>Erledigt: {formatDate(task.completedAt || task.createdAt)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div> : null}
            </div>
          </div>
        );
      })()}

      {selectedReport && (() => {
        const conversationLines = buildConversationLines(selectedReport.summary || "");
        const lostStage = selectedReport.outcome !== "Termin" && selectedReport.outcome !== "Wiedervorlage"
          ? detectLostStage(selectedReport.summary || "")
          : null;

        return (
          <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <button className="modal-close" onClick={() => setSelectedReport(null)}>✕</button>
              <h2>{selectedReport.company}</h2>
              <div className="row" style={{ marginTop: 8 }}>
                <span className={`status ${selectedReport.outcome === "Absage" ? "absage" : selectedReport.outcome === "Wiedervorlage" ? "wiedervorlage" : ""}`}>
                  {selectedReport.outcome}
                </span>
                <span className="subtle" style={{ fontSize: "0.85rem" }}>{formatDate(selectedReport.conversationDate)}</span>
              </div>

              <div className="report-detail-grid">
                <div className="report-detail-field">
                  <label>Ansprechpartner</label>
                  <p>{selectedReport.contactName || "–"}</p>
                </div>
                <div className="report-detail-field">
                  <label>Thema</label>
                  <p>{selectedReport.topic}</p>
                </div>
                <div className="report-detail-field">
                  <label>Direkte Durchwahl</label>
                  <p>{selectedReport.directDial || "–"}</p>
                </div>
                <div className="report-detail-field">
                  <label>Gesprächsversuche</label>
                  <p>{selectedReport.attempts}</p>
                </div>
                {/* Outcome analysis */}
                <div className="report-detail-field report-detail-full">
                  <label>Gesprächsergebnis</label>
                  {selectedReport.outcome === "Termin" ? (
                    <p className="summary-box" style={{ background: "rgba(47,143,87,0.1)", borderColor: "rgba(47,143,87,0.3)" }}>
                      ✓ Termin vereinbart{selectedReport.appointmentAt ? ` am ${formatDate(selectedReport.appointmentAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Wiedervorlage" ? (
                    <p className="summary-box" style={{ background: "rgba(183,135,34,0.12)", borderColor: "rgba(183,135,34,0.3)" }}>
                      ⟳ Wiedervorlage{selectedReport.nextCallAt ? ` – nächster Anruf am ${formatDate(selectedReport.nextCallAt)}` : ""}
                    </p>
                  ) : selectedReport.outcome === "Absage" ? (
                    <p className="summary-box" style={{ background: "rgba(194,77,77,0.1)", borderColor: "rgba(194,77,77,0.3)" }}>
                      ✗ Absage — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  ) : selectedReport.summary.toLowerCase().includes("abgebrochen") ? (
                    <p className="summary-box" style={{ background: "rgba(130,100,160,0.08)", borderColor: "rgba(130,100,160,0.2)" }}>
                      – Gespräch abgebrochen — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  ) : (
                    <p className="summary-box" style={{ background: "rgba(100,120,160,0.08)", borderColor: "rgba(100,120,160,0.2)" }}>
                      – Nicht erreicht / kein Kontakt — verloren bei: <strong>{lostStage}</strong>
                    </p>
                  )}
                </div>

                {/* Conversation flow */}
                {conversationLines.length > 0 && (
                  <div className="report-detail-field report-detail-full">
                    <label>Gesprächsverlauf</label>
                    <div style={{ display: "grid", gap: 6, marginTop: 4 }}>
                      {conversationLines.map((line, i) => (
                        <div
                          key={i}
                          style={{
                            padding: "6px 10px",
                            borderRadius: 8,
                            fontSize: "0.88rem",
                            background: line.speaker === "Gloria" ? "rgba(43,101,217,0.07)" : "rgba(32,57,93,0.05)",
                            borderLeft: `3px solid ${line.speaker === "Gloria" ? "var(--blue-500)" : "var(--gold-500)"}`,
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: "0.78rem", color: line.speaker === "Gloria" ? "var(--blue-600)" : "var(--gold-600)" }}>
                            {line.speaker}
                          </span>
                          <br />
                          {line.text}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="report-detail-field report-detail-full">
                  <label>Gesprächsprotokoll (Reaktionszeit pro Gloria-Antwort)</label>
                  <p className="subtle" style={{ marginTop: 0, marginBottom: 8 }}>
                    Vollständiger textbasierter Verlauf aus der Live-Transkription, damit nachvollziehbar bleibt, was gesprochen wurde.
                  </p>
                  {transcriptLoading ? (
                    <p className="subtle" style={{ marginTop: 6 }}>Wird geladen …</p>
                  ) : transcriptEvents.length === 0 ? (
                    (() => {
                      // Fallback: parse transcript from summary field (stored by finalize.ts)
                      const lines = (selectedReport?.summary || "").split("\n");
                      const transcriptStart = lines.findIndex(l => l.startsWith("--- GESPRÄCHSVERLAUF ---"));
                      const summaryLines = transcriptStart >= 0
                        ? lines.slice(transcriptStart + 1).filter(l => l.startsWith("Gloria:") || l.startsWith("Interessent:"))
                        : lines.filter(l => l.startsWith("Gloria:") || l.startsWith("Interessent:"));
                      if (summaryLines.length > 0) {
                        return (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                            {summaryLines.map((line, i) => {
                              const isGloria = line.startsWith("Gloria:");
                              const text = line.replace(/^(Gloria|Interessent):\s*/, "");
                              return (
                                <div
                                  key={i}
                                  style={{
                                    padding: "8px 10px",
                                    borderRadius: 6,
                                    background: isGloria ? "rgba(40, 92, 180, 0.06)" : "rgba(190, 130, 30, 0.06)",
                                    borderLeft: `3px solid ${isGloria ? "var(--blue-600, #2563eb)" : "var(--gold-600, #b45309)"}`,
                                  }}
                                >
                                  <div style={{ fontWeight: 700, fontSize: "0.78rem", color: isGloria ? "#2563eb" : "#b45309", marginBottom: 4 }}>
                                    {isGloria ? "Gloria" : "Interessent"}
                                  </div>
                                  <div style={{ fontSize: "0.92rem" }}>{text}</div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      }
                      return (
                        <p className="subtle" style={{ marginTop: 6 }}>
                          Für diesen Anruf liegt kein Live-Mitschnitt vor. Das passiert typischerweise bei älteren
                          Calls ohne Streaming oder wenn die Pipeline vorzeitig beendet wurde.
                        </p>
                      );
                    })()
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                      {transcriptEvents.map((entry) => {
                        const isGloria = entry.speaker === "Gloria";
                        const ts = entry.spokenAt || entry.createdAt;
                        const tsLabel = ts
                          ? new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                          : "";
                        return (
                          <div
                            key={entry.id}
                            style={{
                              padding: "8px 10px",
                              borderRadius: 6,
                              background: isGloria ? "rgba(40, 92, 180, 0.06)" : "rgba(190, 130, 30, 0.06)",
                              borderLeft: `3px solid ${isGloria ? "var(--blue-600)" : "var(--gold-600)"}`,
                            }}
                          >
                            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                              <span
                                style={{
                                  fontWeight: 700,
                                  fontSize: "0.78rem",
                                  color: isGloria ? "var(--blue-600)" : "var(--gold-600)",
                                }}
                              >
                                {entry.speaker}
                              </span>
                              {tsLabel && (
                                <span className="subtle" style={{ fontSize: "0.72rem", fontFamily: "monospace" }}>
                                  {tsLabel}
                                </span>
                              )}
                              {isGloria && typeof entry.latencyMs === "number" && (
                                <span
                                  style={{
                                    fontSize: "0.72rem",
                                    fontFamily: "monospace",
                                    color:
                                      entry.latencyMs > 2500
                                        ? "#b54545"
                                        : entry.latencyMs > 1500
                                          ? "#a07020"
                                          : "#3a8c4a",
                                  }}
                                  title="Reaktionszeit: Pause zwischen Ende der Anrufer-Aussage und Glorias Sprechbeginn."
                                >
                                  Reaktion: {(entry.latencyMs / 1000).toFixed(2)} s
                                </span>
                              )}
                            </div>
                            <div style={{ marginTop: 4, fontSize: "0.92rem", lineHeight: 1.45 }}>{entry.text}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="report-detail-field report-detail-full">
                  <label>Zusammenfassung (Rohdaten)</label>
                  <pre className="code-box" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>
                    {selectedReport.summary || "Kein Protokoll vorhanden."}
                  </pre>
                </div>

                {selectedReport.callSid && (
                  <div className="report-detail-field">
                    <label>Call-SID</label>
                    <p style={{ fontFamily: "monospace", fontSize: "0.82rem", color: "#4f6588" }}>{selectedReport.callSid}</p>
                  </div>
                )}
                <div className="report-detail-field">
                  <label>E-Mail-Report an</label>
                  <p>{selectedReport.emailedTo || "–"}</p>
                </div>

                {/* Delete whole report */}
                <div className="report-detail-field report-detail-full" style={{ borderTop: "1px solid var(--mist-200)", paddingTop: 14, marginTop: 4 }}>
                  <button
                    className="btn danger"
                    onClick={() => void deleteReport(selectedReport.id)}
                    disabled={busy}
                  >Report komplett löschen</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
