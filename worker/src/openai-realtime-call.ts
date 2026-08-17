import type { IncomingMessage } from "node:http";
import { fetch } from "undici";
import WebSocket, { type WebSocket as ServerWebSocket } from "ws";
import { computeFreeSlots, freeSlotsToPrompt, loadBusySlots } from "./busy.js";
import { postReport } from "./finalize.js";
import { log } from "./log.js";
import { newContext, type CallContext } from "./state.js";
import { loadTopicPolicy, topicPolicyToSystemPrompt } from "./topic-policy-prompt.js";

type TelnyxFrame =
  | { event: "connected" }
  | {
      event: "start";
      stream_id: string;
      start: {
        call_control_id: string;
        client_state?: string;
        media_format?: { encoding?: string; sample_rate?: number };
      };
    }
  | {
      event: "media";
      stream_id: string;
      media: { track: string; payload: string };
    }
  | { event: "stop" }
  | { event: "error"; payload?: { code?: number; title?: string; detail?: string } };

type ClientState = {
  company?: string;
  contactName?: string;
  leadNote?: string;
  topic?: string;
  leadId?: string;
  userId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  previousSummary?: string;
  isCallback?: number;
};

type RealtimeMessage = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  error?: { message?: string };
  response?: {
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
    }>;
  };
};

type RealtimeToolCall = {
  name: string;
  callId: string;
  argumentsJson: string;
};

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "confirm_appointment",
    description: "Speichert einen vom Kunden eindeutig bestätigten Termin. Erst aufrufen, nachdem Datum und Uhrzeit ausdrücklich bestätigt wurden.",
    parameters: {
      type: "object",
      properties: {
        slot_phrase: {
          type: "string",
          description: "Der bestätigte Termin auf Deutsch mit Wochentag, Datum und Uhrzeit.",
        },
      },
      required: ["slot_phrase"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "transfer_to_human",
    description: "Übergibt das laufende Gespräch an einen Menschen, wenn der Kunde dies ausdrücklich verlangt.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "end_call",
    description: "Beendet den Anruf ausschließlich nach einer klar verständlichen deutschen Verabschiedung oder einer eindeutigen deutschen Ablehnung. Niemals bei kurzen, unklaren, fragmentarischen oder fremdsprachig wirkenden ASR-Texten; dann erst auf Deutsch nachfragen.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

function decodeClientState(raw?: string): ClientState {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ClientState;
  } catch {
    return {};
  }
}

export function openAiAudioFormat(encoding?: string): "audio/pcma" | "audio/pcmu" {
  const normalized = (encoding || process.env.TELNYX_STREAM_BIDIRECTIONAL_CODEC || "PCMU")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized.includes("PCMA") || normalized.includes("ALAW")
    ? "audio/pcma"
    : "audio/pcmu";
}

function splitPreparationQuestions(policy: { topic?: string; requiredQuestions?: string; requiredData?: string; pkvHealthQuestions?: string } | null): string[] {
  const source = /private\s+krankenversicherung|pkv/i.test(policy?.topic || "")
    ? policy?.pkvHealthQuestions || policy?.requiredQuestions || policy?.requiredData
    : policy?.requiredQuestions || policy?.requiredData;
  const fallback = /private\s+krankenversicherung|pkv/i.test(policy?.topic || "")
    ? "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?\nKönnten Sie mir Ihre Körpergröße nennen?\nWie ist Ihr aktuelles Gewicht?\nBei welchem Krankenversicherer sind Sie derzeit versichert?\nWie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?\nGibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?\nNehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?\nGab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?\nGab es in den letzten zehn Jahren psychische Behandlungen?\nFehlen aktuell Zähne oder ist Zahnersatz geplant?\nBestehen bei Ihnen bekannte Allergien?"
    : "";
  return (source || fallback)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3);
}

function isPreparationConsent(text: string): "granted" | "declined" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (/^(?:ja\b|gerne\b|klar\b|okay\b|ok\b|passt\b|in ordnung\b|machen wir\b)/i.test(normalized)) return "granted";
  if (/^(?:nein\b|nö\b|lieber nicht|keine zeit|nicht jetzt|später|möchte ich nicht)/i.test(normalized)) return "declined";
  return "unknown";
}

export function isLikelyNoiseTranscript(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-zäöüßı0-9:?!.\s-]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;
  if (/^(?:good to|does that|thank you much|i know|anlıyorum|어\?|aso|gute tag|tag|gutes|ich bin ab|hera|fariha|mhm|hmm|hm+|äh+|uh+|oh+)[.!?]*$/i.test(normalized)) return true;
  if (normalized.length <= 2 && !/^(?:ja|ne|nein|ok|okay|jo|nö|hm)$/i.test(normalized)) return true;
  return false;
}

function hasClearFarewellOrRejection(ctx: CallContext): boolean {
  const latestUserText = [...ctx.transcript].reverse().find((turn) => turn.role === "user")?.text || "";
  return /\b(?:auf\s+wiederh[öo]ren|tsch[üu]ss|wiedersehen|einen\s+sch[öo]nen\s+tag|kein\s+interesse|nicht\s+interessiert|bitte\s+nicht|beenden\s+sie|legen\s+sie\s+auf)\b/i.test(latestUserText);
}

function buildKnownConversationFacts(ctx: CallContext): string {
  const userText = ctx.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const facts: string[] = [];
  if (/\b(?:gesetzlich|gkv)\b/i.test(userText)) facts.push("Versicherungsstatus: gesetzlich versichert (bereits geklärt; nicht erneut fragen).");
  else if (/\b(?:privat|pkv)\b/i.test(userText)) facts.push("Versicherungsstatus: privat versichert (bereits geklärt; nicht erneut fragen).");
  const contribution = userText.match(/\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend)[a-zäöüß-]*\s+euro)\b/i)?.[0];
  if (contribution) facts.push(`Aktueller Monatsbeitrag: ${contribution} (bereits genannt; nicht erneut fragen).`);
  return facts.length ? `BEREITS GEKLÄRTE FAKTEN:\n- ${facts.join("\n- ")}\nDiese Angaben sind verbindlich und haben Vorrang vor allgemeinen Policy-Fragen.` : "";
}

function isPreparationQuestionAnswered(question: string, ctx: CallContext): boolean {
  const userText = ctx.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  if (/versicher|privat|gesetzlich|pkv|gkv/i.test(question)) return /\b(?:privat|gesetzlich|pkv|gkv)\b/i.test(userText);
  if (/monatsbeitrag|beitrag.*krankenversicherung/i.test(question)) return /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro)\b/i.test(userText);
  return false;
}

export function buildRequiredPkvSequenceInstruction(ctx: CallContext): string {
  if (ctx.topicKind !== "pkv") return "";
  const userText = ctx.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const assistantText = ctx.transcript.filter((turn) => turn.role === "assistant").map((turn) => turn.text).join(" ");
  const hasContribution = /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro)\b/i.test(userText);
  const hasTenYearProjection = /(?:in\s+zehn\s+jahren|zehn[- ]jahres|10[- ]jahres|10\s+jahren)/i.test(assistantText);
  const hasRetirementQuestion = /(?:bis\s+zum\s+ruhestand|bis\s+zur\s+rente|ruhestand|rente).*(?:fühlen|planung|planen)|(?:fühlen|planung|planen).*(?:ruhestand|rente)/i.test(assistantText);
  if (hasContribution && !hasTenYearProjection) {
    return "ZWINGENDER NÄCHSTER SCHRITT: Der Kunde hat seinen aktuellen Monatsbeitrag genannt. Gib jetzt ausschließlich eine konkrete Hochrechnung mit genau diesem Betrag. Sage ausdrücklich: 'in zehn Jahren'. Nenne heutigen Betrag, Betrag in zehn Jahren und monatlichen Unterschied. Keine Terminfrage, keine Konzeptbeschreibung, keine Versicherungsstatusfrage.";
  }
  if (hasContribution && hasTenYearProjection && !hasRetirementQuestion) {
    return "ZWINGENDER NÄCHSTER SCHRITT: Die Zehn-Jahres-Hochrechnung ist erfolgt. Frage jetzt ausschließlich: 'Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?' Warte danach auf die Antwort. Keine Terminfrage.";
  }
  return "";
}

function isLikelyIncompleteAssistantTurn(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length < 45) return false;
  return !/[.!?؟]$/.test(normalized);
}

export function canConfirmRealtimeAppointment(ctx: CallContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.topicKind !== "pkv") return { ok: true };

  const userText = ctx.transcript
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");
  const assistantText = ctx.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");
  const hasInsuranceStatus = /\b(?:privat(?:e[nrsm]?\s+krankenversicherung)?|pkv|gesetzlich(?:e[nrsm]?\s+krankenversicherung)?|gkv)\b/i.test(userText);
  const hasContribution = /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend)[a-zäöüß-]*\s+euro)\b/i.test(userText);
  const hasProjection = /(?:vier\s+prozent|4\s*%)\s+(?:pro\s+jahr)?[\s\S]{0,160}(?:zehn\s+jahr|10\s+jahr)|(?:zehn\s+jahr|10\s+jahr)[\s\S]{0,160}(?:vier\s+prozent|4\s*%)/i.test(assistantText);
  const conceptQuestionIndex = ctx.transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) =>
      turn.role === "assistant" && /(?:arbeitsweise|ersten termin|zweiten termin|tarifoptimierung|beitragsentlastung|altersrückstellung)/i.test(turn.text),
    )
    .at(-1)?.index;
  const interestQuestionIndex = ctx.transcript
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn, index }) =>
      turn.role === "assistant"
      && (conceptQuestionIndex === undefined || index >= conceptQuestionIndex)
      && /(?:sinnvoll|interessiert|hilfreich|termin.*(?:vereinbaren|abstimmen)|einordnung.*(?:passt|hilft)|klarheit|entwicklung.*(?:fühlen|planung)|persönliche.*sicht|was bedeutet)/i.test(turn.text),
    )
    .at(-1)?.index;
  const interestAnswer = interestQuestionIndex === undefined
    ? ""
    : ctx.transcript.slice(interestQuestionIndex + 1).find((turn) => turn.role === "user")?.text || "";
  const hasInterest = /^(?:ja\b|ja,?\s*(?:gerne|bitte|das\s+(?:ist|wäre)|tendenziell|grundsätzlich)|gerne\b|interessant\b|hilfreich\b|das\s+macht\s+sinn|klingt\s+gut|möchte\s+ich|will\s+ich)/i.test(interestAnswer.trim());
  const hasOfferedSlotSelection = /(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|vormittag|nachmittag|uhr|\d{1,2}:\d{2})/i.test(userText)
    && /(?:zwei\s+(?:konkrete\s+)?(?:termine|vorschläge|optionen)|(?:termine|vorschläge)\s*:\s*[^.]+\s+(?:oder|bzw\.?)[^.]+)/i.test(assistantText)
    && /(?:passt|gut|nehme|wäre|gerne|ja|september|oktober|november|dezember|januar|februar|märz|april|mai|juni|juli|august)/i.test(userText);

  if (!hasInsuranceStatus) return { ok: false, reason: "Vor einer Terminbestätigung fehlt die Versicherungsart." };
  if (!hasContribution) return { ok: false, reason: "Vor einer Terminbestätigung fehlt der aktuelle Monatsbeitrag." };
  if (!hasProjection) return { ok: false, reason: "Zeige zuerst anhand des genannten Beitrags eine konkrete Zehn-Jahres-Hochrechnung mit rund vier Prozent pro Jahr." };
  if (!hasInterest) return { ok: false, reason: "Hole nach Hochrechnung und persönlicher Relevanz erst eine eindeutige Zustimmung auf den nächsten Schritt ein." };
  if (hasOfferedSlotSelection) return { ok: true };
  return { ok: true };
}

export function isOfferedSlotPhrase(ctx: CallContext, phrase: string): boolean {
  const normalize = (value: string) => value
    .toLowerCase()
    .replace(/[^a-zäöüß0-9:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const normalizedPhrase = normalize(phrase);
  const offeredText = normalize(ctx.freeSlotsPrompt || "");
  return normalizedPhrase.length > 10 && offeredText.includes(normalizedPhrase);
}

export function buildRealtimeInstructions(ctx: CallContext): string {
  const company = ctx.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel";
  const owner = ctx.ownerRealName?.trim() || "Matthias Duic";
  const target = ctx.contactName?.trim();
  const today = new Date().toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });

  const parts = [
    `Du bist Gloria, die digitale Assistentin von ${company}, und telefonierst im Auftrag von ${owner}.`,
    `Heute ist ${today}. Du führst ein echtes deutsches Telefongespräch, keinen Fragebogen und kein Skript.`,
    "Höre auf Bedeutung, Ton und Absicht der letzten Äußerung. Antworte zuerst darauf und entscheide erst dann frei, welcher nächste Schritt sinnvoll ist.",
    "Sprich natürlich, klar und in kurzen Gesprächsabschnitten. Stelle höchstens eine Frage pro Turn. Formuliere die Frage möglichst als letzten Satz. Sobald du eine Frage gestellt hast, beendest du deinen Turn vollständig und sprichst nicht weiter, bis der Kunde geantwortet hat. Keine Absätze, keine Wiederholung derselben Rechnung.",
    "Keine Vorrede und keine zweiteilige Antwort bei normalen Gesprächsbeiträgen. Beginne direkt mit der eigentlichen Antwort und formuliere den vollständigen Turn in einer zusammenhängenden Audioantwort. Verwende im PKV-Gespräch nicht das abstrakte Wort 'Arbeitsweise'; sprich stattdessen konkret über Vertrag, Beitragsverlauf, Zahlen und mögliche Optionen.",
    "Sprich ausschließlich klares Standarddeutsch. Verwende niemals Englisch, keine englischen Füllwörter und keinen hörbaren fremden Akzent oder Dialekt. Wenn eine Äußerung unklar ist, frage kurz auf Deutsch nach.",
    "Lass den Gesprächspartner vollständig ausreden. Eine kurze Pause, ein Atemholen, ein 'äh', 'mhm' oder eine Korrektur beendet den Kundenturn nicht. Warte, bis der Gedanke erkennbar abgeschlossen ist, statt dazwischenzusprechen.",
    "WICHTIG BEI UNKLAREM AUDIO: Ein einzelnes Wort, ein Fragment, ein fremdsprachig wirkender Text oder ein kurzer Laut wie 'mhm', 'aha', 'okay' oder 'Anlıyorum' ist keine Zustimmung, keine Terminwahl und keine Verabschiedung. Frage dann genau einmal kurz auf Deutsch nach, was der Kunde meint. Beende den Anruf niemals auf dieser Grundlage.",
    "Topic Policies sind fachliche Leitplanken, kein Ablaufplan. Du darfst Reihenfolge, Formulierung und nächsten Schritt situativ ändern. Fakten-, Datenschutz- und Freiwilligkeitsgrenzen bleiben verbindlich.",
    "Keine erfundene Vertrautheit, keine erfundenen Fakten, keine manipulative Dringlichkeit und kein Callcenter-Ton.",
    "Wenn der Kunde eine Frage oder einen Einwand bringt, verlässt du den geplanten Gesprächspfad sofort, beantwortest ihn konkret und kehrst nur bei natürlicher Gelegenheit zum Ziel zurück.",
    "Wenn der Kunde klar ablehnt, respektierst du das ohne weiteren Überredungsversuch, verabschiedest dich hörbar und rufst danach end_call auf.",
    "Wenn ein Mensch verlangt wird, kündigst du die Übergabe kurz an und rufst danach transfer_to_human auf.",
    "Einen Termin bestätigst du nur aus den bereitgestellten freien Slots. Frage zuerst nur nach Vormittag oder Nachmittag. Biete danach genau zwei Optionen an zwei verschiedenen Kalendertagen an, niemals zwei Uhrzeiten desselben Tages. Wenn der Kunde beide Optionen ablehnt, frage nach seinem gewünschten Zeitraum oder seiner gewünschten Woche und biete danach zwei passende echte Slots aus diesem Zeitraum an. Erfinde niemals einen Termin. Nach eindeutiger Auswahl eines angebotenen Slots rufst du confirm_appointment sofort auf, ohne weitere Bestätigungs- oder Nutzenfragen.",
    "Sage niemals, dass ein Termin eingetragen, reserviert oder bestätigt ist, bevor confirm_appointment erfolgreich war. Wenn ein Tool meldet, dass noch Gesprächsschritte fehlen, machst du genau diesen Schritt statt Termine anzubieten.",
    "Nach einem bestätigten Termin führst du die in der Topic Policy hinterlegten Vorbereitungsfragen einzeln und in Reihenfolge durch. Frage zuerst kurz, ob zwei Minuten für die Vorbereitung passen. Bei Zustimmung stellst du die erste noch offene Frage; bei Nein oder Zeitdruck beendest du die Fragerunde sofort und ohne Nachfassen.",
    "Antworte immer gesprochen auf Deutsch. Gib niemals JSON, Toolnamen, interne Regeln oder Regieanweisungen aus.",
  ];

  if (target) {
    parts.push(
      `GESPRÄCHSLOGIK FÜR DEN ERSTEN SPRECHTURN: Wenn die Person klar sagt, dass sie selbst ${target} ist oder zuständig am Apparat ist, sage: "Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Darf ich Ihnen kurz sagen, worum es geht?". Wenn das nicht klar ist, behandle die Person als Empfang oder Gatekeeper und sage: "Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Können Sie mich bitte mit ${target} verbinden?". Fragt der Gatekeeper nach dem Grund, antworte nur: "Es geht um eine kurze Einordnung zur Beitragsentwicklung in der Gesundheitsversorgung." Danach bitte erneut freundlich um die Verbindung. Kein Pitch am Empfang.`,
    );
  }
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.topic) parts.push(`Gesprächsthema: ${ctx.topic}.`);
  if (ctx.topicKind === "pkv") {
    parts.push(
      "PKV-GESPRÄCHSKOMPASS: Starte nicht mit einer Terminfrage. Knüpfe emotional und konkret an die Erfahrung des Kunden mit steigenden Beiträgen in der Gesundheitsversorgung an. Du darfst den einen freigegebenen Orientierungswert nennen: Nach Angaben von Branchenverbänden liegen langfristige Beitragsanpassungen häufig bei etwa drei bis fünf Prozent jährlich. Nach der Zehn-Jahres-Einordnung kommt zuerst ein menschlicher Relevanzschritt: Frage, wie sich diese Entwicklung für den Kunden anfühlt und was sie für seine persönliche Planung bedeutet. Warte auf diese Antwort. Erkläre erst danach die Konzeptphase. Überspringe diesen Relevanzschritt niemals.",
      "PFLICHT NACH EINEM GENANNTEN MONATSBEITRAG: Rechne sofort transparent und vorsichtig mit rund vier Prozent pro Jahr vor. Nenne ausdrücklich den heutigen Monatsbeitrag, sage ausdrücklich 'in zehn Jahren' und nenne den ungefähren Monatsbeitrag in zehn Jahren sowie den monatlichen Unterschied. Frage danach wörtlich sinngemäß: 'Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?' Warte auf die Antwort. Erkläre erst danach, dass Herr Duic genau dort ansetzt: Er schafft Klarheit über Vertrag, Beitragsverlauf und persönliche Zahlen und prüft als mögliche Optionen Tarifoptimierung, Altersrückstellungen, Beitragsentlastungstarife und mögliche Steuervorteile zur Gegenfinanzierung der verbleibenden Beiträge im Alter. Nichts davon als Garantie oder Empfehlung darstellen. Erst nach dieser persönlichen Einordnung und Zustimmung darfst du einen Termin anbieten.",
      "HARTE REIHENFOLGE VOR JEDEM TERMIN: Solange der Kunde noch keinen aktuellen Monatsbeitrag genannt bekommen hat, darfst du weder nach einem Termin fragen noch Tage, Uhrzeiten oder Zeitfenster anbieten. Nach dem Beitrag musst du zuerst eine konkrete Zehn-Jahres-Hochrechnung mit dem echten Betrag geben, ausdrücklich 'in zehn Jahren' sagen, danach nach der Entwicklung bis zum Ruhestand und der persönlichen Planung fragen, die Antwort abwarten, dann Klarheit und die möglichen Optionen erklären und erst danach das Termininteresse abfragen. Ein unklarer ASR-Text wie 'hera' ist keine Zustimmung und darf keinen Schritt voranbringen.",
      "KONZEPTERKLÄRUNG NUR AUF KONKRETE KUNDENFRAGE: Erkläre den Ablauf mit erstem Analyse-Termin, persönlichem Konzept und anschließend offenen Fragen nur, wenn der Kunde ausdrücklich fragt, wie Herr Duic vorgeht, was im Termin passiert oder wie die möglichen Optionen funktionieren. Im normalen Ablauf keine ausführliche Drei-Termine-Erklärung und keine Frage 'Wäre diese Klarheit hilfreich?'. Nach der persönlichen Relevanzfrage und Zustimmung direkt zur Terminpräferenz übergehen.",
      "KUNDENNUTZEN: Sage ausdrücklich, was der Kunde davon hat: Klarheit über die persönliche Entwicklung, konkrete prüfbare Optionen und einen nachvollziehbaren Weg zu einem im Alter planbaren und bezahlbaren Beitrag für die Gesundheitsversorgung. Herr Duic hilft Unternehmern, Komplexität zu reduzieren und sich nicht allein auf steigende Bescheide verlassen zu müssen. Frage danach, ob genau diese Klarheit für den Kunden hilfreich wäre. Erst nach dieser Antwort darfst du einen Termin anbieten.",
      "COMPLIANCE: Keine pauschalen Erfolgsversprechen, keine Garantie für null Euro und keine individuelle Steuer-, Rechts- oder Tarifempfehlung am Telefon. Eine vertraglich garantierte Entlastung darf erst nach Prüfung des konkreten Konzepts genannt werden.",
      "Versicherungsart, heutiger Beitrag, Hochrechnung und echte Zustimmung sind Voraussetzungen für einen PKV-Termin. Ein unklarer ASR-Text, ein bloßes 'ja', ein Füllwort oder ein missverstandenes Wort ist niemals eine Zustimmung. Frage dann kurz nach, statt fortzufahren.",
      "Nach einem bestätigten Termin bedeutet ein Nein auf eine Vorbereitungsfrage: 'Kein Problem, dann lassen wir das für den Termin offen.' Stelle diese Frage nicht erneut und fahre nicht mit einem Fragenkatalog fort.",
    );
  }
  if (ctx.leadNote?.trim()) parts.push(`Hilfreicher Lead-Kontext: ${ctx.leadNote.trim()}`);
  if (ctx.isCallback && ctx.previousSummary?.trim()) {
    parts.push(`Dies ist ein vereinbarter Rückruf. Letzter Stand: ${ctx.previousSummary.trim()}`);
  }
  if (ctx.topicPolicyPrompt) parts.push(ctx.topicPolicyPrompt);
  if (ctx.freeSlotsPrompt) parts.push(ctx.freeSlotsPrompt);
  if (ctx.confirmedSlotPhrase) {
    parts.push(`Bereits bestätigter Termin: ${ctx.confirmedSlotPhrase}. Diesen Termin nicht verändern.`);
  }

  return parts.join("\n\n");
}

async function notifyCallAction(ctx: CallContext, action: "transfer" | "hangup"): Promise<void> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN || "";
  if (!baseUrl || !token) return;

  try {
    await fetch(`${baseUrl}/api/telnyx/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ callControlId: ctx.callSid }),
    });
  } catch (error) {
    log.error(`realtime.${action}_failed`, {
      callSid: ctx.callSid,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleOpenAiRealtimeTelnyxStream(
  telnyx: ServerWebSocket,
  _req: IncomingMessage,
): Promise<void> {
  let ctx: CallContext | null = null;
  let openai: WebSocket | null = null;
  let streamId = "";
  let inputAudioFormat: "audio/pcma" | "audio/pcmu" = "audio/pcma";
  let outputAudioFormat: "audio/pcma" | "audio/pcmu" = "audio/pcma";
  let sessionReady = false;
  let closed = false;
  let reportPosted = false;
  let silenceOpenerTimer: NodeJS.Timeout | null = null;
  let activeResponse = false;
  let responseCancelPending = false;
  let queuedResponseInstructions: string | null = null;
  let responseFlushTimer: NodeJS.Timeout | null = null;
  let activeAssistantItemId = "";
  let outboundAudioBytes = 0;
  let outboundAudioBuffer = Buffer.alloc(0);
  let playbackTimer: NodeJS.Timeout | null = null;
  const playbackQueue: Buffer[] = [];
  let assistantTranscript = "";
  let assistantTranscriptDeltaSeen = false;
  let assistantContinuationRequested = false;
  let responseCreateNotBefore = 0;
  let preparationQuestions: string[] = [];
  let preparationMode: "none" | "awaiting_consent" | "asking" | "complete" = "none";
  let preparationQuestionIndex = 0;
  const pendingUserTranscripts: string[] = [];
  const queuedAudio: string[] = [];
  const handledToolCalls = new Set<string>();
  const interruptedItemIds = new Set<string>();

  const sendOpenAi = (event: Record<string, unknown>): boolean => {
    if (!openai || openai.readyState !== WebSocket.OPEN) return false;
    openai.send(JSON.stringify(event));
    return true;
  };

  const sendTelnyx = (event: Record<string, unknown>): boolean => {
    if (telnyx.readyState !== telnyx.OPEN) return false;
    telnyx.send(JSON.stringify(event));
    return true;
  };

  const clearPlaybackQueue = () => {
    playbackQueue.length = 0;
    if (playbackTimer) {
      clearTimeout(playbackTimer);
      playbackTimer = null;
    }
  };

  const pumpPlaybackQueue = () => {
    playbackTimer = null;
    if (closed || playbackQueue.length === 0) {
      if (!closed) flushQueuedResponse();
      return;
    }
    const frame = playbackQueue.shift();
    if (!frame) return;
    if (sendTelnyx({ event: "media", stream_id: streamId, media: { payload: frame.toString("base64") } })) {
      outboundAudioBytes += frame.length;
    }
    if (playbackQueue.length > 0) {
      playbackTimer = setTimeout(pumpPlaybackQueue, 20);
    } else {
      flushQueuedResponse();
    }
  };

  const enqueuePlaybackFrame = (frame: Buffer) => {
    playbackQueue.push(frame);
    if (!playbackTimer) pumpPlaybackQueue();
  };

  const updateSession = () => {
    if (!ctx || !sessionReady) return;
    const configuredSpeed = Number.parseFloat(process.env.OPENAI_REALTIME_SPEED?.trim() || "0.88");
    const speed = Number.isFinite(configuredSpeed) ? Math.min(1.1, Math.max(0.75, configuredSpeed)) : 0.88;
    sendOpenAi({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        max_output_tokens: 1000,
        instructions: buildRealtimeInstructions(ctx),
        reasoning: { effort: process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim() || "low" },
        tools: REALTIME_TOOLS,
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: inputAudioFormat },
            transcription: {
              model: process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-4o-mini-transcribe",
              language: "de",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.7,
              silence_duration_ms: 1200,
              prefix_padding_ms: 300,
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: outputAudioFormat },
            voice: process.env.OPENAI_REALTIME_VOICE?.trim() || "marin",
            speed,
          },
        },
      },
    });
  };

  const requestResponse = (instructions?: string) => {
    const facts = ctx ? buildKnownConversationFacts(ctx) : "";
    const sequence = ctx ? buildRequiredPkvSequenceInstruction(ctx) : "";
    const responseInstructions = [facts, sequence, instructions].filter(Boolean).join("\n\n");
    const delay = Math.max(0, responseCreateNotBefore - Date.now());
    if (activeResponse || responseCancelPending || playbackQueue.length > 0 || playbackTimer || delay > 0) {
      if (queuedResponseInstructions === null) queuedResponseInstructions = responseInstructions;
      log.info("realtime.response_ignored_while_active", {
        callSid: ctx?.callSid,
        instructionsPreview: responseInstructions.slice(0, 80) || "none",
        cancelPending: responseCancelPending,
        playbackPending: playbackQueue.length > 0 || Boolean(playbackTimer),
      });
      if (!responseFlushTimer) {
        responseFlushTimer = setTimeout(() => {
          responseFlushTimer = null;
          flushQueuedResponse();
        }, Math.max(20, delay));
      }
      return false;
    }
    sendOpenAi({
      type: "response.create",
      ...(responseInstructions ? { response: { instructions: responseInstructions } } : {}),
    });
    return true;
  };

  const flushQueuedResponse = () => {
    if (activeResponse || responseCancelPending || queuedResponseInstructions === null) return;
    if (playbackQueue.length > 0 || playbackTimer) {
      if (!responseFlushTimer) {
        responseFlushTimer = setTimeout(() => {
          responseFlushTimer = null;
          flushQueuedResponse();
        }, 20);
      }
      return;
    }
    const instructions = queuedResponseInstructions;
    queuedResponseInstructions = null;
    requestResponse(instructions);
  };

  const sendToolResult = (callId: string, result: Record<string, unknown>) => {
    sendOpenAi({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
  };

  const processUserTranscript = (transcript: string) => {
    if (!ctx) return;
    const currentContext = ctx;
    assistantContinuationRequested = false;
    currentContext.lastUserFinalAt = Date.now();
    currentContext.transcript.push({ role: "user", text: transcript, at: Date.now() });
    log.info("realtime.user_said", { callSid: currentContext.callSid, text: transcript });

    const nextPreparationQuestion = () => preparationQuestions.find((question) => !isPreparationQuestionAnswered(question, currentContext));

    if (preparationMode === "awaiting_consent") {
      const consent = isPreparationConsent(transcript);
      if (consent === "granted") {
        preparationMode = "asking";
        preparationQuestionIndex = 0;
        const question = nextPreparationQuestion();
        if (question) requestResponse(`Stelle ausschließlich diese Vorbereitungsfrage: "${question}"`);
        else requestResponse("Die bereits geklärten Angaben reichen für die Vorbereitung. Frage nur noch nach der E-Mail-Adresse für die Terminbestätigung.");
      } else if (consent === "declined") {
        preparationMode = "complete";
        requestResponse("Akzeptiere die Absage an die Vorbereitungsfragen ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.");
      } else {
        requestResponse("Die Antwort war unklar. Frage freundlich noch einmal nur, ob zwei Minuten für kurze Vorbereitungsfragen passen.");
      }
    } else if (preparationMode === "asking") {
      preparationQuestionIndex += 1;
      const nextQuestion = preparationQuestions[preparationQuestionIndex];
      const unansweredQuestion = nextQuestion && !isPreparationQuestionAnswered(nextQuestion, currentContext) ? nextQuestion : preparationQuestions.slice(preparationQuestionIndex + 1).find((question) => !isPreparationQuestionAnswered(question, currentContext));
      if (unansweredQuestion) {
        requestResponse(`Bedanke dich knapp und stelle ausschließlich die nächste Vorbereitungsfrage: "${unansweredQuestion}"`);
      } else {
        preparationMode = "complete";
        requestResponse("Die Vorbereitungsfragen sind vollständig. Bedanke dich kurz und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.");
      }
    } else {
      requestResponse();
    }
  };

  const handleToolCall = async (tool: RealtimeToolCall) => {
    if (!ctx || handledToolCalls.has(tool.callId)) return;
    handledToolCalls.add(tool.callId);

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tool.argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      sendToolResult(tool.callId, { ok: false, error: "invalid_arguments" });
      requestResponse();
      return;
    }

    if (tool.name === "confirm_appointment") {
      const phrase = typeof args.slot_phrase === "string" ? args.slot_phrase.trim() : "";
      const eligibility = canConfirmRealtimeAppointment(ctx);
      if (!phrase) {
        sendToolResult(tool.callId, { ok: false, error: "missing_slot_phrase" });
      } else if (!isOfferedSlotPhrase(ctx, phrase)) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: "slot_not_offered", instruction: "Dieser Termin steht nicht in der bereitgestellten freien Slotliste. Biete nur zwei echte freie Slots aus der Liste an." });
        requestResponse("Der gewünschte Termin steht so nicht in den freien Vorschlägen. Biete bitte ausschließlich zwei konkrete freie Termine aus der bereitgestellten Liste an.");
      } else if (!eligibility.ok) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: "appointment_not_ready", instruction: eligibility.reason });
      } else {
        ctx.confirmedSlotPhrase = phrase;
        log.info("realtime.slot_locked", { callSid: ctx.callSid, slot: phrase });
        sendToolResult(tool.callId, { ok: true, confirmed_slot: phrase });
        updateSession();
        if (preparationQuestions.length > 0) {
          preparationMode = "awaiting_consent";
          requestResponse(
            `Bestätige nur den Termin ${phrase}. Frage danach exakt: "Für die Vorbereitung würde ich Ihnen noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?"`,
          );
          return;
        }
      }
      requestResponse();
      return;
    }

    if (tool.name === "transfer_to_human") {
      sendToolResult(tool.callId, { ok: true });
      log.info("realtime.transfer", { callSid: ctx.callSid });
      await notifyCallAction(ctx, "transfer");
      return;
    }

    if (tool.name === "end_call") {
      if (!hasClearFarewellOrRejection(ctx)) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: "unclear_hangup_request", instruction: "Frage auf Deutsch kurz nach, ob der Kunde das Gespräch beenden möchte. Hänge nicht auf." });
        requestResponse("Das habe ich nicht eindeutig verstanden. Möchten Sie das Gespräch beenden, oder sollen wir kurz weitermachen?");
        return;
      }
      sendToolResult(tool.callId, { ok: true });
      log.info("realtime.hangup", { callSid: ctx.callSid });
      await notifyCallAction(ctx, "hangup");
    }
  };

  const connectOpenAi = () => {
    if (!ctx || openai) return;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1";

    openai = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    openai.on("open", () => {
      sessionReady = true;
      updateSession();
      for (const payload of queuedAudio.splice(0)) {
        sendOpenAi({ type: "input_audio_buffer.append", audio: payload });
      }
      log.info("realtime.connected", { callSid: ctx?.callSid, model, inputAudioFormat, outputAudioFormat });
    });

    openai.on("message", (data: WebSocket.RawData) => {
      let message: RealtimeMessage;
      try {
        message = JSON.parse(data.toString()) as RealtimeMessage;
      } catch {
        return;
      }

      if (message.type === "error") {
        const errorMessage = message.error?.message || "unknown_realtime_error";
        if (/cancellation failed: no active response found/i.test(errorMessage)) {
          return;
        }
        log.error("realtime.session_error", {
          callSid: ctx?.callSid,
          error: errorMessage,
        });
        return;
      }

      if (message.type === "input_audio_buffer.speech_started") {
        if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
        silenceOpenerTimer = null;
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = message.transcript?.trim();
        if (ctx && transcript) {
          if (isLikelyNoiseTranscript(transcript)) {
            log.info("realtime.ignored_noise_transcript", { callSid: ctx.callSid, text: transcript });
            return;
          }
          if (activeResponse) {
            pendingUserTranscripts.push(transcript);
            log.info("realtime.user_queued_until_response_done", { callSid: ctx.callSid, text: transcript });
          } else {
            processUserTranscript(transcript);
          }
        }
        return;
      }

      if (message.type === "response.created") {
        activeResponse = true;
        activeAssistantItemId = "";
        outboundAudioBytes = 0;
        outboundAudioBuffer = Buffer.alloc(0);
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.output_audio.delta" || message.type === "response.audio.delta") {
        if (message.delta) {
          activeAssistantItemId = message.item_id || activeAssistantItemId;
          outboundAudioBuffer = Buffer.concat([outboundAudioBuffer, Buffer.from(message.delta, "base64")]);
          while (outboundAudioBuffer.length >= 160) {
            const frame = outboundAudioBuffer.subarray(0, 160);
            outboundAudioBuffer = outboundAudioBuffer.subarray(160);
            enqueuePlaybackFrame(frame);
          }
        }
        return;
      }

      if (message.type === "response.output_audio.done") {
        if (outboundAudioBuffer.length > 0) {
          const silenceByte = outputAudioFormat === "audio/pcma" ? 0xd5 : 0xff;
          const frame = Buffer.concat([
            outboundAudioBuffer,
            Buffer.alloc(160 - outboundAudioBuffer.length, silenceByte),
          ]);
          enqueuePlaybackFrame(frame);
          outboundAudioBuffer = Buffer.alloc(0);
        }
        return;
      }

      if (message.type === "response.output_audio_transcript.delta" || message.type === "response.audio_transcript.delta") {
        assistantTranscript += message.delta || "";
        assistantTranscriptDeltaSeen = true;
        return;
      }

      if (message.type === "response.output_audio_transcript.done" || message.type === "response.audio_transcript.done") {
        if (message.item_id && interruptedItemIds.delete(message.item_id)) return;
        if (!assistantTranscriptDeltaSeen && message.transcript) assistantTranscript += message.transcript;
        return;
      }

      if (message.type === "response.function_call_arguments.done" && message.name && message.call_id) {
        void handleToolCall({
          name: message.name,
          callId: message.call_id,
          argumentsJson: message.arguments || "{}",
        });
        return;
      }

      if (message.type === "response.done") {
        const transcript = assistantTranscript.replace(/\s+/g, " ").trim();
        if (ctx && transcript) {
          const latencyMs = ctx.lastUserFinalAt ? Date.now() - ctx.lastUserFinalAt : undefined;
          ctx.transcript.push({ role: "assistant", text: transcript, at: Date.now(), latencyMs });
          log.info("realtime.gloria_said", { callSid: ctx.callSid, text: transcript, latencyMs });
        }
        activeResponse = false;
        responseCancelPending = false;
        responseCreateNotBefore = Date.now() + 180;
        if (isLikelyIncompleteAssistantTurn(transcript) && !assistantContinuationRequested) {
          assistantContinuationRequested = true;
          log.warn("realtime.incomplete_response_recovery", {
            callSid: ctx?.callSid,
            text: transcript,
          });
          requestResponse("Deine letzte Antwort wurde technisch mitten im Satz beendet. Setze den angefangenen Satz unmittelbar und natürlich zu Ende. Wiederhole den bereits gesprochenen Teil nicht. Stelle danach höchstens eine kurze Frage und warte dann auf den Kunden.");
          assistantTranscript = "";
          assistantTranscriptDeltaSeen = false;
          return;
        }
        assistantContinuationRequested = false;
        for (const item of message.response?.output || []) {
          if (item.type === "function_call" && item.name && item.call_id) {
            void handleToolCall({
              name: item.name,
              callId: item.call_id,
              argumentsJson: item.arguments || "{}",
            });
          }
        }
        const nextUserTranscript = pendingUserTranscripts.splice(0).join(" ").replace(/\s+/g, " ").trim();
        if (nextUserTranscript) processUserTranscript(nextUserTranscript);
        flushQueuedResponse();
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.cancelled" || message.type === "response.canceled") {
        activeResponse = false;
        responseCancelPending = false;
        flushQueuedResponse();
      }
    });

    openai.on("close", (code, reason) => {
      sessionReady = false;
      log.info("realtime.closed", { callSid: ctx?.callSid, code, reason: reason.toString() });
    });

    openai.on("error", (error) => {
      log.error("realtime.socket_error", { callSid: ctx?.callSid, error: error.message });
    });
  };

  telnyx.on("message", (raw) => {
    let frame: TelnyxFrame;
    try {
      frame = JSON.parse(raw.toString()) as TelnyxFrame;
    } catch {
      return;
    }

    if (frame.event === "start") {
      const state = decodeClientState(frame.start.client_state);
      streamId = frame.stream_id;
      inputAudioFormat = openAiAudioFormat(frame.start.media_format?.encoding);
      outputAudioFormat = openAiAudioFormat(process.env.TELNYX_STREAM_BIDIRECTIONAL_CODEC || "PCMA");
      ctx = newContext({
        callSid: frame.start.call_control_id,
        streamSid: frame.stream_id,
        userId: state.userId,
        leadId: state.leadId,
        company: state.company,
        contactName: state.contactName,
        leadNote: state.leadNote,
        topic: state.topic,
        ownerRealName: state.ownerRealName,
        ownerCompanyName: state.ownerCompanyName,
        ownerGesellschaft: state.ownerGesellschaft,
        previousSummary: state.previousSummary,
        isCallback: state.isCallback === 1,
      });
      log.info("realtime.call_started", {
        callSid: ctx.callSid,
        streamSid: streamId,
        inputAudioFormat,
        outputAudioFormat,
        topic: ctx.topic,
      });
      connectOpenAi();

      void loadTopicPolicy({ userId: ctx.userId, topic: ctx.topic }).then((policy) => {
        if (!ctx || !policy) return;
        ctx.topicPolicyPrompt = topicPolicyToSystemPrompt(policy);
        preparationQuestions = splitPreparationQuestions(policy);
        updateSession();
        log.info("realtime.topic_policy_applied", { callSid: ctx.callSid, topic: policy.topic });
      });

      void loadBusySlots({ userId: ctx.userId }).then((slots) => {
        if (!ctx) return;
        const busySlots = slots || [];
        const free = computeFreeSlots(busySlots, {
          daysAhead: 60,
          maxCount: 40,
          bufferMinutes: 90,
          minLeadDays: 7,
        });
        ctx.freeSlotsPrompt = freeSlotsToPrompt(free);
        updateSession();
        log.info("realtime.calendar_applied", { callSid: ctx.callSid, busy: busySlots.length, free: free.length });
      }).catch(() => undefined);

      const silenceMs = Math.max(2500, Number.parseInt(process.env.TELNYX_SILENCE_OPENER_MS || "4200", 10));
      silenceOpenerTimer = setTimeout(() => {
        if (!ctx || activeResponse) return;
        sendOpenAi({
          type: "response.create",
          response: {
            instructions: "Am anderen Ende ist noch niemand hörbar. Begrüße jetzt kurz, stelle dich transparent vor und frage nach dem gewünschten Ansprechpartner. Dann warte.",
          },
        });
      }, silenceMs);
      return;
    }

    if (frame.event === "media") {
      if (frame.media.track === "outbound" || frame.media.track === "outbound_track") return;
      if (!sessionReady) {
        queuedAudio.push(frame.media.payload);
        if (queuedAudio.length > 500) queuedAudio.shift();
      } else {
        sendOpenAi({ type: "input_audio_buffer.append", audio: frame.media.payload });
      }
      return;
    }

    if (frame.event === "stop") {
      try {
        openai?.close(1000, "call_finished");
      } catch {
        /* ignore */
      }
      try {
        telnyx.close(1000, "stop");
      } catch {
        /* ignore */
      }
    }
  });

  telnyx.on("close", async (code, reason) => {
    if (closed) return;
    closed = true;
    clearPlaybackQueue();
    if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
    try {
      openai?.close(1000, "telnyx_closed");
    } catch {
      /* ignore */
    }
    log.info("realtime.telnyx_closed", { callSid: ctx?.callSid, code, reason: reason.toString() });
    if (ctx && !reportPosted) {
      reportPosted = true;
      await postReport(ctx).catch((error) => {
        log.error("realtime.finalize_failed", {
          callSid: ctx?.callSid,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  telnyx.on("error", (error) => {
    log.error("realtime.telnyx_error", { callSid: ctx?.callSid, error: error.message });
  });
}
