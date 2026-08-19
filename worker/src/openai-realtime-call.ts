import type { IncomingMessage } from "node:http";
import { fetch } from "undici";
import type { WebSocket as ServerWebSocket } from "ws";
import { appointmentOfferInstruction, convertSlotPhraseForSpeech, decideAppointment, detectAppointmentPreference, isSuppliedAppointmentSlot } from "./appointment-controller.js";
import { planBargeIn } from "./barge-in-controller.js";
import { formatAmountForSpeech } from "./preparation-controller.js";
import { computeFreeSlots, freeSlotsToPrompt, loadBusySlots } from "./busy.js";
import { advanceContactRouting, createContactRoutingState, instructionForContactRouting, type ContactRoutingState } from "./contact-routing-controller.js";
import { classifyConversationEvent, instructionForConversationEvent, isConversationEndingText, isUnclearConversationText } from "./conversation-event-controller.js";
import { postReport } from "./finalize.js";
import { log } from "./log.js";
import { OpenAiRealtimeSession, type RealtimeServerEvent } from "./openai-realtime-session.js";
import { isElevenLabsConfigured, streamElevenLabsAudio } from "./elevenlabs-tts.js";
import { assessPkvConversation, instructionForPkvStage, instructionForPkvStep, advancePkvStep, extractContributionPhrase, type PkvConversationAssessment, type ConversationTurn } from "./pkv-conversation-controller.js";
import { advancePreparation, beginPreparation, createPreparationState, type PreparationState } from "./preparation-controller.js";
import { RealtimeResponseController } from "./realtime-response-controller.js";
import { newContext, type CallContext } from "./state.js";
import { TelnyxPlayback } from "./telnyx-playback.js";
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

type RealtimeToolCall = {
  name: string;
  callId: string;
  argumentsJson: string;
};

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "confirm_appointment",
    description: "Speichert einen vom Kunden eindeutig bestätigten Termin. Erst aufrufen, nachdem der Kunde einen angebotenen Wochentag oder Slot klar ausgewählt und eine Rückbestätigung wie 'ja, das passt' gegeben hat. Niemals bei Hallo, Bitte, Mhm oder unklarem Audio.",
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

export function isLikelyNoiseTranscript(text: string): boolean {
  return isUnclearConversationText(text);
}

export function isSyntheticTranscriptionPrompt(text: string): boolean {
  return /deutsches telefonat zur privaten krankenversicherung|achte besonders auf eigennamen.*euro[- ]?betr[aä]ge/i.test(text.trim());
}

function hasClearFarewellOrRejection(ctx: CallContext): boolean {
  const latestUserText = [...ctx.transcript].reverse().find((turn) => turn.role === "user")?.text || "";
  return isConversationEndingText(latestUserText);
}

function buildKnownConversationFacts(ctx: CallContext): string {
  const userText = ctx.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const facts: string[] = [];
  if (/\b(?:gesetzlich|gkv)\b/i.test(userText)) facts.push("Versicherungsstatus: gesetzlich versichert (bereits geklärt; nicht erneut fragen).");
  else if (/\b(?:privat|pkv)\b/i.test(userText)) facts.push("Versicherungsstatus: privat versichert (bereits geklärt; nicht erneut fragen).");
  const contribution = userText.match(/\b(?:\d{1,3}(?:\.\d{3})+|\d{2,5})(?:,\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend)[a-zäöüß-]*\s+euro\b/i)?.[0];
  if (contribution) facts.push(`Aktueller Monatsbeitrag: ${contribution} (bereits genannt; nicht erneut fragen).`);
  return facts.length ? `BEREITS GEKLÄRTE FAKTEN:\n- ${facts.join("\n- ")}\nDiese Angaben sind verbindlich und haben Vorrang vor allgemeinen Policy-Fragen.` : "";
}

export function buildRequiredPkvSequenceInstruction(ctx: CallContext): string {
  if (ctx.topicKind !== "pkv") return "";
  if (ctx.dialogState.pkvStep >= 5) return "";
  const userText = ctx.transcript.filter(t => t.role === "user").map(t => t.text).join(" ");
  const contributionPhrase = extractContributionPhrase(userText);
  return `AKTUELLER GESPRÄCHSSCHRITT: ${instructionForPkvStep(ctx.dialogState.pkvStep, contributionPhrase)}`;
}

function isRelevantPkvStageAnswer(stage: string, text: string): boolean {
  const normalized = text.toLowerCase();
  if (stage === "need_relevance") {
    return /\b(?:ja|nein|entwicklung|beitrag|steiger|belast|sorge|ruhestand|rente|planung|teuer|hoch|spür|sp[uü]r|wahrnehm|angst|problem)\b/i.test(normalized);
  }
  if (stage === "need_contribution") {
    return /\b(?:\d{2,5}|euro|€|beitrag|monatlich|monat|zahlen|kost|weiß\s+ich\s+nicht|weiss\s+ich\s+nicht|keine\s+ahnung)\b/i.test(normalized);
  }
  return true;
}

export function buildRealtimeResponseInstructions(
  ctx: CallContext,
  instructions?: string,
  includeSequence = true,
): string {
  const facts = buildKnownConversationFacts(ctx);
  const sequence = includeSequence ? buildRequiredPkvSequenceInstruction(ctx) : "";
  return convertNumbersForSpeech([facts, instructions, sequence].filter(Boolean).join("\n\n"));
}

export function shouldRestoreDecisionMakerIntro(params: {
  decisionMakerIntroWasLastResponse: boolean;
  playbackPending: boolean;
}): boolean {
  // Re-trigger intro if it was interrupted mid-playback by a barge-in.
  return params.decisionMakerIntroWasLastResponse && params.playbackPending;
}

function isLikelyIncompleteAssistantTurn(text: string): boolean {
  const normalized = text.replace(/["“”'»«]+$/g, "").replace(/\s+/g, " ").trim();
  if (normalized.length < 45) return false;
  return !/[.!?؟]$/.test(normalized);
}

const DECISION_MAKER_INTRO = "Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Darf ich Ihnen kurz sagen, worum es geht?";

export function canConfirmRealtimeAppointment(ctx: CallContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.topicKind !== "pkv") return { ok: true };
  if (ctx.dialogState.pkvStep >= 5) return { ok: true };
  const userText = ctx.transcript.filter(t => t.role === "user").map(t => t.text).join(" ");
  const contributionPhrase = extractContributionPhrase(userText);
  return { ok: false, reason: instructionForPkvStep(ctx.dialogState.pkvStep, contributionPhrase) };
}

export function isOfferedSlotPhrase(ctx: CallContext, phrase: string): boolean {
  return isSuppliedAppointmentSlot(ctx.freeSlotsPrompt, phrase);
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
    "Sprich natürlich, klar und in passenden Gesprächsabschnitten. Setze kurze natürliche Pausen mit Kommas und kurzen Sätzen, statt lange Satzketten oder Aufzählungen zu sprechen. Stelle höchstens eine Frage pro Turn. Formuliere die Frage möglichst als letzten Satz. Sobald du eine Frage gestellt hast, beendest du deinen Turn vollständig und sprichst nicht weiter, bis der Kunde geantwortet hat. Keine Absätze, keine Wiederholung derselben Rechnung.",
    "Keine Vorrede und keine zweiteilige Antwort bei normalen Gesprächsbeiträgen. Beginne direkt mit der eigentlichen Antwort und formuliere den vollständigen Turn in einer zusammenhängenden Audioantwort. Verwende im PKV-Gespräch nicht das abstrakte Wort 'Arbeitsweise'; sprich stattdessen konkret über Vertrag, Beitragsverlauf, Zahlen und mögliche Optionen.",
    "Sprich ausschließlich klares Standarddeutsch. Verwende niemals Englisch, keine englischen Füllwörter und keinen hörbaren fremden Akzent oder Dialekt. Wenn eine Äußerung unklar ist, frage kurz auf Deutsch nach.",
    "Lass den Gesprächspartner vollständig ausreden. Eine kurze Pause, ein Atemholen, ein 'äh', 'mhm' oder eine Korrektur beendet den Kundenturn nicht. Warte, bis der Gedanke erkennbar abgeschlossen ist, statt dazwischenzusprechen.",
    "WICHTIG BEI UNKLAREM AUDIO: Ein einzelnes Wort, ein Fragment, ein fremdsprachig wirkender Text oder ein kurzer Laut wie 'mhm', 'aha', 'okay' oder 'Anlıyorum' ist keine Zustimmung, keine Terminwahl und keine Verabschiedung. Frage dann genau einmal kurz auf Deutsch nach, was der Kunde meint. Beende den Anruf niemals auf dieser Grundlage.",
    "Die Topic Policy steuert Anlass, Kundennutzen, Einwandbehandlung und Gesprächsführung für dieses Thema. Universell verbindlich bleiben nur Transparenz, Freiwilligkeit, Datenschutz, die Terminlogik und fachliche Grenzen.",
    "Sprich menschlich, ruhig, freundlich und auf Augenhöhe. Keine Callcenter-Monologe, keine künstliche Vertrautheit, keine erfundenen Fakten, keine manipulative Dringlichkeit.",
      "Nimm die letzte Aussage des Kunden zuerst emotional und inhaltlich auf: Benenne kurz seine konkrete Perspektive oder Sorge in eigenen Worten, ohne zu dramatisieren. Gib dann genau einen nachvollziehbaren nächsten Schritt und höchstens eine Frage. Keine Standardfloskel wie 'Dann ist das sinnvoll', wenn der Kunde gerade etwas anderes gesagt hat.",
      "Nach einer Unterbrechung setzt du nur an der offenen Stelle an. Wiederhole weder die komplette Vorstellung noch den bereits gesprochenen Satz. Wenn die Äußerung unklar war, frage kurz nach; wenn sie verständlich war, antworte direkt auf ihren Inhalt.",
    "Gib niemals zu, dass du etwas erfunden hast, dass deine Information ungenau ist, oder dass du dich geirrt hast. Wenn du einen Fehler bemerkst oder unsicher bist, korrigiere dich diskret und fahre mit Sicherheit fort—Beispiel: nicht 'Ich kann das nicht sauber herleiten, ohne etwas zu erfinden', sondern 'Lass mich das anders erklären' oder direkt die nächste passende Frage. Vertrauen bauen heißt: immer kompetent wirken, auch wenn du eine Aussage anpasst.",
    "Wenn der Kunde eine Frage oder einen Einwand bringt, verlässt du den geplanten Gesprächspfad sofort, beantwortest ihn konkret und kehrst nur bei natürlicher Gelegenheit zum Ziel zurück.",
    "Wenn der Kunde klar ablehnt, respektierst du das ohne weiteren Überredungsversuch, verabschiedest dich hörbar und rufst danach end_call auf.",
    "Wenn ein Mensch verlangt wird, kündigst du die Übergabe kurz an und rufst danach transfer_to_human auf.",
    "Einen Termin bestätigst du nur aus den bereitgestellten freien Slots. Frage zuerst nur nach Vormittag oder Nachmittag und biete danach zwei Optionen an verschiedenen Kalendertagen an. Bei 'Der Donnerstag' oder 'der zweite Termin' frage zuerst kurz zurück: 'Meinen Sie Donnerstag, den ... um ... Uhr?' Rufe confirm_appointment erst nach einem klaren 'Ja, das passt' oder einer vollständigen eindeutigen Bestätigung auf. Bei Hallo, Bitte, Mhm, Wiederholungsbitten oder unklarem Audio niemals bestätigen.",
    "Sage niemals, dass ein Termin eingetragen, reserviert oder bestätigt ist, bevor confirm_appointment erfolgreich war. Wenn ein Tool meldet, dass noch Gesprächsschritte fehlen, machst du genau diesen Schritt statt Termine anzubieten.",
    "Nach einem bestätigten Termin führst du die in der Topic Policy hinterlegten Vorbereitungsfragen einzeln und in Reihenfolge durch. Frage zuerst kurz, ob zwei Minuten für die Vorbereitung passen. Bei Zustimmung stellst du die erste noch offene Frage. Ein Nein auf eine einzelne Gesundheitsfrage beendet die Fragerunde nicht: Akzeptiere es kurz, frage diese Frage nicht erneut und stelle die nächste Frage. Nur ein Nein zur gesamten Fragerunde oder ausdrücklicher Zeitdruck beendet die Fragerunde.",
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
      "PKV-GESPRÄCHSZIEL: Führe das Gespräch natürlich durch diese Phasen:\n" +
      "1. ERLAUBNIS: Frage ob du kurz sagen darfst worum es geht. Warte auf Zustimmung.\n" +
      "2. RELEVANZ: Erwähne kurz, dass PKV-Beiträge jährlich steigen, und frage wie der Kunde das erlebt. Warte auf Antwort.\n" +
      "3. BEITRAG: Biete Hochrechnung an und frage nach aktuellem Monatsbeitrag. Warte.\n" +
      "4. HOCHRECHNUNG: Rechne Beitrag auf 10 Jahre und Ruhestand hoch. Frage ob der Kunde das so schon betrachtet hat.\n" +
      "5. KONZEPT: Erkläre Herrn Duics Ansatz (Beitragsanalyse, Altersrückstellungen, Steuervorteile). Frage ob das interessant ist.\n" +
      "6. TERMIN: Bei Ja → Terminvorschläge, Gesundheitsfragen (oder per Mail), freundliche Verabschiedung.\n" +
      "REGEL: Nur eine Frage pro Turn. Nie dieselbe Frage wiederholen. In eigenen natürlichen Worten formulieren.",
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
  
  // Dialog state: Track which questions have been asked to prevent repetition
  if (ctx.dialogState.askedQuestions.size > 0) {
    const askedCount = ctx.dialogState.askedQuestions.size;
    parts.push(
      `BEREITS GESTELLTE FRAGEN (${askedCount}): Du hast bereits ${askedCount} Frage(n) gestellt. ` +
      `Stelle diese Fragen nicht erneut. Wenn der Kunde die Antwort wiederholt oder zu einer anderen Frage überleitet, ` +
      `akzeptiere das und stelle nur neue Fragen, die noch nicht geklärt sind.`,
    );
  }

  // Phase-specific instructions to keep conversation on track
  const phase = ctx.dialogState.phase;
  if (phase === "opener") {
    parts.push(
      "PHASE: ERÖFFNUNG - Du befindest dich in der Eröffnungsphase. Deine Aufgabe: " +
      "Freundliche Begrüßung, kurze Erklärung warum du anrufst, und Zustimmung zum Gespräch bekommen. " +
      "Stelle KEINE inhaltlichen Fragen zu Versicherung, Beiträgen oder Kundensituation.",
    );
  } else if (phase === "discovery") {
    parts.push(
      "PHASE: BEDARFSKLÄRUNG - Du befindest dich in der Discovery-Phase. Deine Aufgabe: " +
      "Verstehe die aktuelle Situation des Kunden (Alter, Beitrag, Versicherungsstatus, Bedenken). " +
      "Stelle gezielt Fragen die den Nutzen unserer Analyse erklären. Keine Termin-Angebote in dieser Phase.",
    );
  } else if (phase === "objection") {
    parts.push(
      "PHASE: EINWAND-HANDLING - Du befindest dich in der Objection-Handling-Phase. Deine Aufgabe: " +
      "Der Kunde hat einen Einwand oder Bedenken. Nimm ihn ernst, verstehe die konkrete Sorge, " +
      "und beantworte ihn sachlich mit Fokus auf den Nutzen des Termins. Nach Einwand-Handling, zurück zu Discovery.",
    );
  } else if (phase === "close" || phase === "done") {
    parts.push(
      "PHASE: TERMIN/ABSCHLUSS - Du befindest dich in der Abschlussphase. Deine Aufgabe: " +
      "Termin anbieten und bestätigen, oder bei Ablehnung respektvoll verabschieden. " +
      "Keine neuen Discovery-Fragen mehr.",
    );
  }
  
  parts.push("VERBINDLICHE ERSTKONTAKT-REGEL: Dies ist grundsätzlich eine Neukundenakquise und der erste Kontakt. Behaupte niemals, der Kunde habe eine Anfrage gestellt, Unterlagen gesendet oder um einen Rückruf geboten, außer der Rückruf ist ausdrücklich als Rückruf gekennzeichnet. Verwende am Gesprächsbeginn den vorgegebenen Erstkontakt-Wortlaut und beginne nicht mit der Versicherungsfrage.");

  const instructions = parts.join("\n\n");
  return convertNumbersForSpeech(instructions);
}

/**
 * Update dialog phase based on call state.
 * Only checks USER turns for objection detection to avoid false positives from Gloria's own phrasing.
 */
function updateDialogPhase(ctx: CallContext): void {
  const old = ctx.dialogState.phase;

  if (ctx.confirmedSlotPhrase) {
    ctx.dialogState.phase = "done";
  } else if (ctx.dialogState.phase === "opener" && ctx.transcript.length > 3) {
    ctx.dialogState.phase = "discovery";
  } else if (ctx.dialogState.phase === "discovery") {
    // Only check the last USER turn, not assistant turns (avoids false objection triggers)
    const lastUserTurn = [...ctx.transcript].reverse().find(t => t.role === "user");
    if (lastUserTurn && /\b(?:nein|kein interesse|keine zeit|wir haben|bereits|schon|nicht interessiert|ruf.*nicht.*an|keine.*anrufe)\b/i.test(lastUserTurn.text)) {
      ctx.dialogState.phase = "objection";
    }
  }

  if (old !== ctx.dialogState.phase) {
    log.info("realtime.dialog_phase_changed", {
      callSid: ctx.callSid,
      from: old,
      to: ctx.dialogState.phase,
    });
  }
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

/**
 * Rotate transcript to prevent memory leak in long-running calls.
 * Keeps only recent turns + summary of oldest turns when length exceeds threshold.
 */
function rotateTranscriptIfNeeded(ctx: CallContext): void {
  const MAX_TRANSCRIPT_LENGTH = 250;
  const RETENTION_AFTER_ROTATION = 120;
  
  if (ctx.transcript.length > MAX_TRANSCRIPT_LENGTH) {
    const discardedTurns = ctx.transcript.slice(0, ctx.transcript.length - RETENTION_AFTER_ROTATION);
    const retainedTurns = ctx.transcript.slice(ctx.transcript.length - RETENTION_AFTER_ROTATION);
    
    // Create brief summary of discarded turns (including dialog state info)
    const userTurnsCount = discardedTurns.filter(t => t.role === "user").length;
    const assistantTurnsCount = discardedTurns.filter(t => t.role === "assistant").length;
    const askedQuestionsCount = ctx.dialogState.askedQuestions.size;
    
    const summaryText = 
      `[Transcript Rotation: ${discardedTurns.length} älteren Turns gerotiert (${userTurnsCount} Kunde, ${assistantTurnsCount} Gloria). ` +
      `Gesprächsverlauf bis hierher: Termin-Qualifizierung fortlaufend. ` +
      `Aktuelles Dialog-Fortschritt: Phase=${ctx.dialogState.phase}, ${askedQuestionsCount} Fragen bereits gestellt.]`;
    
    ctx.transcript = [
      { role: "assistant", text: summaryText, at: discardedTurns[0]?.at || Date.now() },
      ...retainedTurns,
    ];
    
    log.info("realtime.transcript_rotated", {
      callSid: ctx.callSid,
      discarded: discardedTurns.length,
      retained: retainedTurns.length,
      dialogPhase: ctx.dialogState.phase,
      askedQuestions: askedQuestionsCount,
    });
  }
}

export async function handleOpenAiRealtimeTelnyxStream(
  telnyx: ServerWebSocket,
  _req: IncomingMessage,
): Promise<void> {
  let ctx: CallContext | null = null;
  let openaiSession: OpenAiRealtimeSession | null = null;
  let streamId = "";
  let inputAudioFormat: "audio/pcma" | "audio/pcmu" = "audio/pcma";
  let outputAudioFormat: "audio/pcma" | "audio/pcmu" = "audio/pcma";
  let closed = false;
  let reportPosted = false;
  let silenceOpenerTimer: NodeJS.Timeout | null = null;
  let assistantTranscript = "";
  let assistantTranscriptDeltaSeen = false;
  let assistantContinuationRequested = false;
  let activeAssistantItemId = "";
  let assistantAudioBytes = 0;
  let ttsAbortController: AbortController | null = null;
  let ttsTurn = 0;
  let responseInterrupted = false;
  let currentAssistantTurnIndex: number | undefined;
  let decisionMakerIntroPending = false;
  let decisionMakerIntroWasLastResponse = false;
  let preparationState: PreparationState = createPreparationState();
  let contactRouting: ContactRoutingState | null = null;
  let unclearClarificationPending = false;
  let userIsSpeaking = false;
  let transferWaitingStartedAt: number | null = null;
  let ttsPlaybackStartedAt: number | null = null; // timestamp when current TTS started playing
  let lastPkvAssessment: PkvConversationAssessment | null = null;
  let lastPkvAssessmentTranscriptLength = -1;
  const pendingUserTranscripts: string[] = [];
  const handledToolCalls = new Set<string>();

  const sendOpenAi = (event: Record<string, unknown>): boolean => {
    return openaiSession?.send(event) ?? false;
  };

  const sendTelnyx = (event: Record<string, unknown>): boolean => {
    if (telnyx.readyState !== telnyx.OPEN) return false;
    telnyx.send(JSON.stringify(event));
    return true;
  };

  const playback = new TelnyxPlayback({
    prebufferFrames: 3,
    sendFrame: (frame) => sendTelnyx({
      event: "media",
      stream_id: streamId,
      media: { payload: frame.toString("base64") },
    }),
    onIdle: () => responses.flush(),
  });

  const responses = new RealtimeResponseController({
    sendResponse: (instructions) => sendOpenAi({
      type: "response.create",
      ...(instructions ? { response: { instructions } } : {}),
    }),
    isPlaybackPending: () => playback.isPending(),
    onDeferred: ({ instructions, playbackPending }) => {
      log.info("realtime.response_queued", {
        callSid: ctx?.callSid,
        instructionsPreview: instructions.slice(0, 80) || "none",
        playbackPending,
      });
    },
  });

  const updateSession = () => {
    if (!ctx || !openaiSession?.isReady()) return;
    const vadThreshold = Number.parseFloat(process.env.OPENAI_REALTIME_VAD_THRESHOLD?.trim() || "0.75");
    const silenceDurationMs = Number.parseInt(process.env.OPENAI_REALTIME_SILENCE_MS?.trim() || "1400", 10);
    const prefixPaddingMs = Number.parseInt(process.env.OPENAI_REALTIME_PREFIX_PADDING_MS?.trim() || "400", 10);
    const maxOutputTokens = Number.parseInt(process.env.OPENAI_REALTIME_MAX_OUTPUT_TOKENS?.trim() || "520", 10);
    sendOpenAi({
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["text"],
        max_output_tokens: maxOutputTokens,
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
              prompt: process.env.OPENAI_TRANSCRIBE_PROMPT?.trim()
                || "Deutsches Telefonat zur privaten Krankenversicherung. Achte besonders auf Eigennamen, Firmennamen, Neumann, Duic, Zahlen, Euro-Betraege sowie gesetzlich und privat.",
            },
            turn_detection: {
              type: "server_vad",
              threshold: vadThreshold,
              silence_duration_ms: silenceDurationMs,
              prefix_padding_ms: prefixPaddingMs,
              create_response: false,
              interrupt_response: false,
            },
          },
        },
      },
    });
  };

  const speakWithElevenLabs = async (text: string): Promise<void> => {
    if (!isElevenLabsConfigured()) {
      log.error("realtime.elevenlabs_not_configured", { callSid: ctx?.callSid });
      playback.interrupt();
      return;
    }

    const turn = ++ttsTurn;
    const controller = new AbortController();
    ttsAbortController?.abort();
    ttsAbortController = controller;
    const outputFormat = outputAudioFormat === "audio/pcma" ? "alaw_8000" : "ulaw_8000";
    let audioBytes = 0;
    ttsPlaybackStartedAt = Date.now(); // track when TTS starts

    try {
      await streamElevenLabsAudio(text, outputFormat, controller.signal, (chunk) => {
        if (controller.signal.aborted || turn !== ttsTurn || responseInterrupted) return;
        audioBytes += chunk.length;
        playback.appendBase64Audio(chunk.toString("base64"));
      }, ctx?.voiceProfile);
      if (!controller.signal.aborted && turn === ttsTurn && !responseInterrupted) {
        playback.finishAudio(outputFormat === "alaw_8000" ? 0xd5 : 0xff);
        if (audioBytes === 0) {
          log.warn("realtime.elevenlabs_empty_audio", { callSid: ctx?.callSid, text: text.slice(0, 60) });
          playback.interrupt();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        log.error("realtime.elevenlabs_failed", {
          callSid: ctx?.callSid,
          error: error instanceof Error ? error.message : String(error),
        });
        playback.interrupt();
      }
    } finally {
      if (ttsAbortController === controller) ttsAbortController = null;
    }
  };

  const requestResponse = (instructions?: string) => {
    const responseInstructions = ctx ? buildRealtimeResponseInstructions(ctx, instructions) : instructions || "";
    return responses.request(responseInstructions);
  };

  const requestEventResponse = (instructions: string) => {
    const responseInstructions = ctx ? buildRealtimeResponseInstructions(ctx, instructions, false) : instructions;
    return responses.request(responseInstructions);
  };

  const cachedAssessPkvConversation = (transcript: ConversationTurn[]): PkvConversationAssessment => {
    // Cache result if transcript length hasn't changed
    if (lastPkvAssessmentTranscriptLength === transcript.length && lastPkvAssessment) {
      return lastPkvAssessment;
    }
    lastPkvAssessment = assessPkvConversation(transcript);
    lastPkvAssessmentTranscriptLength = transcript.length;
    return lastPkvAssessment;
  };

  const requestDecisionMakerIntro = () => {
    decisionMakerIntroPending = true;
    requestResponse("Der Entscheider ist jetzt bestätigt. Sage exakt diesen Wortlaut und nichts anderes: \"Guten Tag, mein Name ist Gloria. Ich bin die digitale Vertriebsassistentin von Herrn Duic und rufe in seinem Auftrag an. Darf ich Ihnen kurz sagen, worum es geht?\" Verwende nicht das Wort Anfrage. Starte noch nicht mit Beitrag, Versicherung oder Termin.");
  };

  const requestInterruptedIntroContinuation = () => {
    decisionMakerIntroPending = false;
    requestResponse("Begrüße den Kunden kurz, ohne die vollständige Vorstellung zu wiederholen, und frage nur: 'Darf ich Ihnen kurz sagen, worum es geht?' Danach vollständig warten.");
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
    if (isSyntheticTranscriptionPrompt(transcript)) {
      log.warn("realtime.synthetic_transcript_ignored", { callSid: ctx.callSid, text: transcript });
      return;
    }
    const currentContext = ctx;
    assistantContinuationRequested = false;
    currentContext.lastUserFinalAt = Date.now();
    currentContext.transcript.push({ role: "user", text: transcript, at: Date.now() });
    rotateTranscriptIfNeeded(currentContext);
    
    // Track answered questions (any user response after a question is implicitly answering)
    currentContext.dialogState.answeredQuestions.add(`turn-${currentContext.transcript.length}`);
    updateDialogPhase(currentContext);
    // Reset deduplication so same instruction can fire again after user speaks
    responses.clearLastHash();
    // Invalidate PKV assessment cache to force re-evaluation with new user turn
    lastPkvAssessmentTranscriptLength = -1;
    
    log.info("realtime.user_said", { callSid: currentContext.callSid, text: transcript });

    const event = classifyConversationEvent(transcript);
    if (event.type === "unclear") {
      if (!unclearClarificationPending) {
        unclearClarificationPending = true;
        requestEventResponse(instructionForConversationEvent(event));
      }
      return;
    }
    unclearClarificationPending = false;

    if (contactRouting?.stage === "decision_maker" && decisionMakerIntroPending) {
        requestInterruptedIntroContinuation();
      return;
    }

    if (event.type === "clear_rejection") {
      requestEventResponse(instructionForConversationEvent(event));
      return;
    }

    if (contactRouting && contactRouting.stage !== "decision_maker") {
      contactRouting = advanceContactRouting(contactRouting, transcript);
      currentContext.detectedVoicemail = contactRouting.stage === "voicemail";
      currentContext.queueDetected = contactRouting.stage === "waiting_for_transfer";
      currentContext.waitingForDecisionMaker = contactRouting.stage === "gatekeeper"
        || contactRouting.stage === "waiting_for_transfer";
      log.info("realtime.contact_routing", {
        callSid: currentContext.callSid,
        stage: contactRouting.stage,
      });

      if (contactRouting.stage === "voicemail") {
        void notifyCallAction(currentContext, "hangup");
        return;
      }
      if (contactRouting.stage === "waiting_for_transfer") {
        transferWaitingStartedAt = transferWaitingStartedAt || Date.now();
        return;
      }
      if (contactRouting.stage !== "decision_maker") {
        requestEventResponse(instructionForContactRouting(contactRouting));
        return;
      }
      requestDecisionMakerIntro();
      return;
    }

    if (currentContext.topicKind === "pkv") {
      // For PKV: invalidate the assessment cache since transcript changed
      lastPkvAssessmentTranscriptLength = -1;
    }

    if (preparationState.stage === "inactive") {
      // ── PKV: step-based state machine ──────────────────────────────────────
      if (currentContext.topicKind === "pkv") {
        const currentStep = currentContext.dialogState.pkvStep;

        // Customer asks a question or raises an objection → answer then return to current step
        if (event.type === "customer_question" || event.type === "objection") {
          const userTextAll = currentContext.transcript.filter(t => t.role === "user").map(t => t.text).join(" ");
          const returnInstruction = `Nach der Antwort kehre direkt zur aktuellen Aufgabe zurück: ${instructionForPkvStep(currentStep, extractContributionPhrase(userTextAll))}`;
          requestEventResponse(instructionForConversationEvent(event, returnInstruction));
          return;
        }

        // Normal answer: advance step
        const advance = advancePkvStep(currentStep, transcript);

        if (advance.shouldEnd) {
          requestEventResponse("Bedanke dich beim Kunden für das Gespräch, verabschiede dich freundlich und rufe dann end_call auf.");
          return;
        }

        const nextStep = advance.nextStep as 0 | 1 | 2 | 3 | 4 | 5;
        if (nextStep !== currentStep) {
          currentContext.dialogState.pkvStep = nextStep;
          log.info("realtime.pkv_step_advanced", { callSid: currentContext.callSid, from: currentStep, to: nextStep });
        }

        // Step 5: appointment scheduling — use existing appointment logic
        if (currentContext.dialogState.pkvStep === 5) {
          const offer = appointmentOfferInstruction(
            currentContext.freeSlotsPrompt,
            detectAppointmentPreference(currentContext.transcript),
          );
          if (offer) { requestEventResponse(offer); return; }
        }

        const userTextAll = currentContext.transcript.filter(t => t.role === "user").map(t => t.text).join(" ");
        const instruction = instructionForPkvStep(currentContext.dialogState.pkvStep, extractContributionPhrase(userTextAll));
        requestEventResponse(instruction);
        return;
      }

      // ── Non-PKV flow ────────────────────────────────────────────────────────
      if (event.type === "customer_question" || event.type === "objection") {
        requestEventResponse(instructionForConversationEvent(event));
        return;
      }
      requestEventResponse(instructionForConversationEvent(event));
      return;
    }

    const transition = advancePreparation(preparationState, transcript, currentContext.transcript);
    preparationState = transition.state;
    requestEventResponse(transition.instruction);
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
      const decision = decideAppointment({
        turns: ctx.transcript,
        topicKind: ctx.topicKind === "pkv" ? "pkv" : "other",
        freeSlotsPrompt: ctx.freeSlotsPrompt,
        slotPhrase: phrase,
      });
      if (!decision.ok && decision.error === "slot_not_offered") {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: decision.error, instruction: decision.instruction });
        requestResponse("Der gewünschte Termin steht so nicht in den freien Vorschlägen. Biete bitte ausschließlich zwei konkrete freie Termine aus der bereitgestellten Liste an.");
      } else if (!decision.ok) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: decision.error, instruction: decision.instruction });
      } else {
        const speechSlotPhrase = convertSlotPhraseForSpeech(decision.slotPhrase);
        ctx.confirmedSlotPhrase = speechSlotPhrase;
        log.info("realtime.slot_locked", { callSid: ctx.callSid, slot: decision.slotPhrase, speechSlot: speechSlotPhrase, preference: decision.preference });
        sendToolResult(tool.callId, { ok: true, confirmed_slot: speechSlotPhrase });
        updateSession();
        const transition = beginPreparation(preparationState, speechSlotPhrase, ctx.transcript);
        preparationState = transition.state;
        requestResponse(transition.instruction);
        return;
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
    if (!ctx || openaiSession) return;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1";

    let handleRealtimeEvent = (_message: RealtimeServerEvent): void => undefined;
    openaiSession = new OpenAiRealtimeSession({
      apiKey,
      model,
      onOpen: () => {
        updateSession();
        log.info("realtime.connected", { callSid: ctx?.callSid, model, inputAudioFormat, outputAudioFormat });
      },
      onEvent: (message) => handleRealtimeEvent(message),
      onClose: (code, reason) => {
        log.info("realtime.closed", { callSid: ctx?.callSid, code, reason });
      },
      onError: (error) => {
        log.error("realtime.socket_error", { callSid: ctx?.callSid, error: error.message });
      },
    });

    handleRealtimeEvent = (message) => {

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
        userIsSpeaking = true;
        // Check transfer timeout: if waiting for transfer >45 seconds, auto-hangup
        if (contactRouting?.stage === "waiting_for_transfer" && transferWaitingStartedAt) {
          const waitingMs = Date.now() - transferWaitingStartedAt;
          const TRANSFER_TIMEOUT_MS = 45000; // 45 seconds
          if (waitingMs > TRANSFER_TIMEOUT_MS) {
            log.info("realtime.transfer_timeout", { callSid: ctx?.callSid, waitingMs });
            void notifyCallAction(ctx!, "hangup");
            return;
          }
        }
        if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
        silenceOpenerTimer = null;

        // Minimum TTS protection: don't interrupt ElevenLabs within first 800ms of playback
        // This prevents echo/noise false positives from silencing Gloria's greeting
        const MIN_TTS_PLAY_MS = 800;
        const ttsAge = ttsPlaybackStartedAt ? Date.now() - ttsPlaybackStartedAt : Infinity;
        const playbackPending = playback.isPending();

        if (shouldRestoreDecisionMakerIntro({ decisionMakerIntroWasLastResponse, playbackPending })) {
          decisionMakerIntroPending = true;
        }

        // Compute audioEndMs WITHOUT interrupting first
        const sentBytes = playback.bytesSent();
        const audioEndMs = Math.ceil(sentBytes / 160) * 20;

        const plan = planBargeIn({
          responseActive: responses.isActive(),
          playbackPending,
          assistantItemId: activeAssistantItemId || undefined,
          audioEndMs,
          assistantAudioBytes,
        });

        // Only actually interrupt if: plan says to AND TTS has played long enough
        if (plan.interrupted && ttsAge >= MIN_TTS_PLAY_MS) {
          ttsTurn += 1;
          ttsAbortController?.abort();
          const interruption = playback.interrupt();
          responseInterrupted = true;
          responses.markInterruptRequested();
          if (plan.clearTelnyxPlayback) sendTelnyx({ event: "clear" });
          for (const event of plan.openAiEvents) sendOpenAi(event);
          if (ctx && currentAssistantTurnIndex !== undefined) {
            ctx.transcript.splice(currentAssistantTurnIndex, 1);
            currentAssistantTurnIndex = undefined;
          }
          ttsPlaybackStartedAt = null;
          log.info("realtime.barge_in", {
            callSid: ctx?.callSid,
            itemId: activeAssistantItemId || undefined,
            audioEndMs: interruption.audioEndMs,
            playbackCleared: plan.clearTelnyxPlayback,
            ttsAgeMs: Math.round(ttsAge),
          });
        } else if (plan.interrupted && ttsAge < MIN_TTS_PLAY_MS) {
          log.info("realtime.barge_in_suppressed", {
            callSid: ctx?.callSid,
            ttsAgeMs: Math.round(ttsAge),
            reason: "tts_too_new",
          });
        }
        return;
      }

      if (message.type === "input_audio_buffer.speech_stopped") {
        userIsSpeaking = false;
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = message.transcript?.trim();
        if (ctx && transcript) {
          if (isLikelyNoiseTranscript(transcript)) {
            log.info("realtime.unclear_transcript", { callSid: ctx.callSid, text: transcript });
          }
          if (responses.isActive()) {
            pendingUserTranscripts.push(transcript);
            log.info("realtime.user_queued_until_response_done", { callSid: ctx.callSid, text: transcript });
          } else {
            processUserTranscript(transcript);
          }
        }
        return;
      }

      if (message.type === "response.created") {
        responses.markCreated();
        playback.startResponse();
        ttsPlaybackStartedAt = Date.now(); // track TTS start for barge-in protection
        activeAssistantItemId = "";
        assistantAudioBytes = 0;
        responseInterrupted = false;
        decisionMakerIntroWasLastResponse = false;
        currentAssistantTurnIndex = undefined;
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.output_audio.delta" || message.type === "response.audio.delta") {
        if (!responseInterrupted && message.delta) {
          activeAssistantItemId = message.item_id || activeAssistantItemId;
          assistantAudioBytes += Buffer.from(message.delta, "base64").length;
          playback.appendBase64Audio(message.delta);
        }
        return;
      }

      if (message.type === "response.output_audio.done") {
        if (!responseInterrupted) playback.finishAudio(outputAudioFormat === "audio/pcma" ? 0xd5 : 0xff);
        return;
      }

      if (message.type === "response.output_audio_transcript.delta" || message.type === "response.audio_transcript.delta") {
        if (responseInterrupted) return;
        assistantTranscript += message.delta || "";
        assistantTranscriptDeltaSeen = true;
        return;
      }

      if (message.type === "response.output_text.delta" || message.type === "response.text.delta") {
        if (responseInterrupted) return;
        assistantTranscript += message.delta || "";
        assistantTranscriptDeltaSeen = true;
        return;
      }

      if (
        message.type === "response.output_audio_transcript.done"
        || message.type === "response.audio_transcript.done"
        || message.type === "response.output_text.done"
        || message.type === "response.text.done"
      ) {
        if (responseInterrupted) return;
        if (!assistantTranscriptDeltaSeen) {
          assistantTranscript += message.transcript || message.text || "";
        }
        return;
      }

      if (message.type === "response.function_call_arguments.done" && message.name && message.call_id) {
        if (responseInterrupted) return;
        void handleToolCall({
          name: message.name,
          callId: message.call_id,
          argumentsJson: message.arguments || "{}",
        });
        return;
      }

      if (message.type === "response.done") {
        if (responseInterrupted || message.response?.status === "cancelled" || message.response?.status === "canceled") {
          responses.markCancelled();
          responseInterrupted = false;
          activeAssistantItemId = "";
          assistantAudioBytes = 0;
          assistantTranscript = "";
          assistantTranscriptDeltaSeen = false;
          return;
        }
        const wasDecisionMakerIntroPending = decisionMakerIntroPending;
        if (decisionMakerIntroPending) decisionMakerIntroPending = false;
        decisionMakerIntroWasLastResponse = wasDecisionMakerIntroPending;
        const transcript = wasDecisionMakerIntroPending
          ? DECISION_MAKER_INTRO
          : assistantTranscript.replace(/\s+/g, " ").trim();
        if (ctx && transcript) {
          const latencyMs = ctx.lastUserFinalAt ? Date.now() - ctx.lastUserFinalAt : undefined;
          ctx.transcript.push({ role: "assistant", text: transcript, at: Date.now(), latencyMs });
          rotateTranscriptIfNeeded(ctx);
          
          // Track asked questions (any question-like assistant turn)
          if (/\?/.test(transcript)) {
            ctx.dialogState.askedQuestions.add(`turn-${ctx.transcript.length}`);
          }
          updateDialogPhase(ctx);
          
          currentAssistantTurnIndex = ctx.transcript.length - 1;
          log.info("realtime.gloria_said", { callSid: ctx.callSid, text: transcript, latencyMs });
        }
        if (!transcript) playback.interrupt();
        responses.markFinished();
        if (isLikelyIncompleteAssistantTurn(transcript) && !assistantContinuationRequested) {
          playback.interrupt();
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
        if (transcript) void speakWithElevenLabs(transcript);
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
        // Only the latest queued utterance carries the user's current intent.
        const pending = pendingUserTranscripts.splice(0);
        const nextUserTranscript = pending.at(-1)?.trim() ?? "";
        if (nextUserTranscript) processUserTranscript(nextUserTranscript);
        responses.flush();
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.cancelled" || message.type === "response.canceled") {
        responses.markCancelled();
        responseInterrupted = false;
        activeAssistantItemId = "";
        assistantAudioBytes = 0;
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
      }
    };

    openaiSession.connect();
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
      contactRouting = createContactRoutingState(state.contactName);
      log.info("realtime.call_started", {
        callSid: ctx.callSid,
        streamSid: streamId,
        inputAudioFormat,
        outputAudioFormat,
        topic: ctx.topic,
      });
      connectOpenAi();

      const policyTask = loadTopicPolicy({ userId: ctx.userId, topic: ctx.topic }).then((policy) => {
        if (!ctx || !policy) return;
        ctx.topicPolicyPrompt = topicPolicyToSystemPrompt(policy);
        if (preparationState.stage === "inactive" && !ctx.confirmedSlotPhrase) {
          preparationState = createPreparationState(policy);
        }
        log.info("realtime.topic_policy_applied", { callSid: ctx.callSid, topic: policy.topic });
      });

      const calendarTask = loadBusySlots({ userId: ctx.userId }).then((slots) => {
        if (!ctx) return;
        const busySlots = slots || [];
        const free = computeFreeSlots(busySlots, {
          daysAhead: 60,
          maxCount: 40,
          bufferMinutes: 90,
          minLeadDays: 7,
        });
        ctx.freeSlotsPrompt = freeSlotsToPrompt(free);
        log.info("realtime.calendar_applied", { callSid: ctx.callSid, busy: busySlots.length, free: free.length });
      }).catch(() => undefined);

      // Single session.update after both background tasks complete.
      void Promise.allSettled([policyTask, calendarTask]).then(() => { if (ctx) updateSession(); });

      const silenceMs = Math.max(2500, Number.parseInt(process.env.TELNYX_SILENCE_OPENER_MS || "4200", 10));
      silenceOpenerTimer = setTimeout(() => {
        if (!ctx || responses.isActive() || userIsSpeaking) return;
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
      openaiSession?.appendInputAudio(frame.media.payload);
      return;
    }

    if (frame.event === "stop") {
      try {
        openaiSession?.close(1000, "call_finished");
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
    responses.stop();
    playback.stop();
    if (silenceOpenerTimer) clearTimeout(silenceOpenerTimer);
    transferWaitingStartedAt = null;
    try {
      openaiSession?.close(1000, "telnyx_closed");
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



function convertNumbersForSpeech(text: string): string {
  // Convert times like "13:00" to "dreizehn Uhr", "15:30" to "fünfzehn Uhr dreißig"
  const hourWords = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig"];
  const minuteWords = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig", "vierundzwanzig", "fünfundzwanzig", "sechsundzwanzig", "siebenundzwanzig", "achtundzwanzig", "neunundzwanzig", "dreißig", "einunddreißig", "zweiunddreißig", "dreiunddreißig", "vierunddreißig", "fünfunddreißig", "sechsunddreißig", "siebenunddreißig", "achtunddreißig", "neununddreißig", "vierzig", "einundvierzig", "zweiundvierzig", "dreiundvierzig", "vierundvierzig", "fünfundvierzig", "sechsundvierzig", "siebenundvierzig", "achtundvierzig", "neunundvierzig", "fünfzig", "einundfünfzig", "zweiundfünfzig", "dreiundfünfzig", "vierundfünfzig", "fünfundfünfzig", "sechsundfünfzig", "siebenundfünfzig", "achtundfünfzig", "neunundfünfzig"];
  
  // Convert time: "um 13:00" or "13:00 Uhr" → "um dreizehn Uhr"
  let result = text.replace(/\b(\d{1,2}):(\d{2})\s*(?:Uhr)?/g, (match, hourStr, minuteStr) => {
    const hour = Number.parseInt(hourStr, 10);
    const minute = Number.parseInt(minuteStr, 10);
    const hourWord = hourWords[hour % 24] || String(hour);
    if (minute === 0) return `${hourWord} Uhr`;
    const minuteWord = minuteWords[minute] || String(minute);
    return `${hourWord} Uhr ${minuteWord}`;
  });

  result = result.replace(/\b(\d+(?:\.\d{3})*(?:,\d{1,2})?)\s*(Euro|EUR|€)\b/gi, (match, amount, unit) => {
    const numericAmount = amount.replace(/\./g, "").split(",")[0];
    return `${formatAmountForSpeech(numericAmount)} ${unit === "€" ? "Euro" : unit}`;
  });
  
  return result;
}
