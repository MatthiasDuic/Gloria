import type { IncomingMessage } from "node:http";
import { fetch } from "undici";
import type { WebSocket as ServerWebSocket } from "ws";
import { appointmentOfferInstruction, convertSlotPhraseForSpeech, decideAppointment, detectAppointmentMode, detectAppointmentPreference, getAppointmentOfferSlots, isSuppliedAppointmentSlot, matchOfferedAppointmentSelection } from "./appointment-controller.js";
import { planBargeIn } from "./barge-in-controller.js";
import { computeFreeSlots, freeSlotsToPrompt, loadBusySlots } from "./busy.js";
import { advanceContactRouting, createContactRoutingState, type ContactRoutingState } from "./contact-routing-controller.js";
import { classifyConversationEvent, instructionForConversationEvent, isConversationEndingText, isUnclearConversationText } from "./conversation-event-controller.js";
import { postReport } from "./finalize.js";
import { log } from "./log.js";
import { OpenAiRealtimeSession, type RealtimeServerEvent } from "./openai-realtime-session.js";
import { isElevenLabsConfigured, shouldRetryElevenLabsStream, streamElevenLabsAudio } from "./elevenlabs-tts.js";
import { assessPkvConversation, instructionForPkvStage, instructionForPkvStep, advancePkvStep, extractCurrentContributionPhrase, isClearPkvInterest, responseTextForPkvStep } from "./pkv-conversation-controller.js";
import { advancePreparation, APPOINTMENT_FAREWELL_TEXT, beginPreparation, createPreparationStateForCall, formatAmountForSpeech, FINAL_FAREWELL_TEXT, type PreparationState } from "./preparation-controller.js";
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
  isTestCall?: boolean;
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
    description: "Speichert einen vom Kunden eindeutig ausgewählten Termin. Eine eindeutige Auswahl wie 'der Montag' genügt ohne zweite Ja-Bestätigung. Erst aufrufen, nachdem der Kunde zusätzlich gewählt hat, ob der Termin digital per Microsoft Teams oder bei ihm vor Ort stattfindet. Biete keinen Termin in der Agentur an. Niemals bei Hallo, Bitte, Mhm oder unklarem Audio.",
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
  return /deutsches telefonat zur (?:privaten krankenversicherung|beitragsentwicklung in der gesundheitsversorgung)|achte besonders auf eigennamen.*euro[- ]?betr[aä]ge/i.test(text.trim());
}

export function shouldRecoverInterruptedBargeIn(awaitingTranscript: boolean, transcript: string): boolean {
  return awaitingTranscript && isSyntheticTranscriptionPrompt(transcript);
}

function hasClearFarewellOrRejection(ctx: CallContext): boolean {
  const latestUserText = [...ctx.transcript].reverse().find((turn) => turn.role === "user")?.text || "";
  return isConversationEndingText(latestUserText);
}

export function hasAffirmedAssistantEndQuestion(ctx: CallContext): boolean {
  let latestUserIndex = -1;
  for (let index = ctx.transcript.length - 1; index >= 0; index -= 1) {
    if (ctx.transcript[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 1) return false;
  const latestUserText = ctx.transcript[latestUserIndex]?.text.trim() || "";
  const previousAssistantText = [...ctx.transcript.slice(0, latestUserIndex)].reverse().find((turn) => turn.role === "assistant")?.text || "";
  return /^(?:ja|genau|bitte|ja[, ]+bitte|das\s+war'?s|das\s+wars)[.!?]*$/i.test(latestUserText)
    && /\b(?:gespr[äa]ch|telefonat)\b[^.!?]{0,40}\b(?:beenden|abschlie[ßs]en)\b/i.test(previousAssistantText);
}

function buildKnownConversationFacts(ctx: CallContext): string {
  const userText = ctx.transcript.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const facts: string[] = [];
  if (/\b(?:gesetzlich|gkv)\b/i.test(userText)) facts.push("Status: gesetzlich versichert (bereits geklärt; nicht erneut fragen).");
  else if (/\b(?:privat|pkv)\b/i.test(userText)) facts.push("Status: privat versichert (bereits geklärt; nicht erneut fragen).");
  const askedCurrentContribution = ctx.transcript.some((turn) => turn.role === "assistant" && /welchen beitrag zahlen sie heute|aktuellen?\s+(?:monatlichen\s+)?beitrag/i.test(turn.text));
  const contribution = askedCurrentContribution ? extractCurrentContributionPhrase(ctx.transcript) : undefined;
  if (contribution) facts.push(`Aktueller Monatsbeitrag: ${contribution} (bereits genannt; nicht erneut fragen).`);
  return facts.length ? `BEREITS GEKLÄRTE FAKTEN:\n- ${facts.join("\n- ")}\nDiese Angaben sind verbindlich und haben Vorrang vor allgemeinen Policy-Fragen.` : "";
}

export function normalizePkvTerminology(text: string): string {
  return text
    .replace(/\bprivate[nr]?\s+krankenversicherung\b/gi, "Gesundheitsversorgung")
    .replace(/\bkrankenversicherung\b/gi, "Gesundheitsversorgung");
}

export function buildRequiredPkvSequenceInstruction(ctx: CallContext): string {
  if (ctx.topicKind !== "pkv") return "";
  const transcriptAssessment = assessPkvConversation(ctx.transcript);
  if (transcriptAssessment.stage === "ready_to_schedule" || ctx.dialogState.pkvStep >= 6) return "";

  const derivedStepByAssessment = transcriptAssessment.stage === "need_interest" || transcriptAssessment.stage === "need_concept"
    ? 4
    : transcriptAssessment.stage === "need_projection"
      ? 3
      : transcriptAssessment.stage === "need_contribution"
        ? 2
        : 1;

  const stepFromContext = ctx.dialogState.pkvStep;
  const step = stepFromContext > 0 ? stepFromContext : derivedStepByAssessment;
  const contributionPhrase = extractCurrentContributionPhrase(ctx.transcript);
  return `ZWINGENDER NÄCHSTER SCHRITT: ${instructionForPkvStep(step, contributionPhrase)}`;
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
  const merged = [facts, instructions, sequence].filter(Boolean).join("\n\n");
  return convertNumbersForSpeech(normalizePkvTerminology(merged));
}

export function isLikelyIncompleteAssistantTurn(text: string): boolean {
  const normalized = text.replace(/["“”'»«]+$/g, "").replace(/\s+/g, " ").trim();
  if (normalized.length < 45) return false;
  return !/[.!?؟:]$/.test(normalized);
}

function getSocietyName(ctx: Pick<CallContext, "ownerGesellschaft">): string {
  return ctx.ownerGesellschaft?.trim() || "Agentur Duic Sprockhövel";
}

function buildDecisionMakerIntro(ctx: Pick<CallContext, "ownerRealName">): string {
  const ownerName = ctx.ownerRealName?.trim() || "Matthias Duic";
  const addressedOwner = /^herr\s/i.test(ownerName) ? ownerName : `Herrn ${ownerName}`;
  // "Gothar" gives ElevenLabs the intended pronunciation of Barmenia Gothaer.
  return `Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin von ${addressedOwner} aus dem Hause der Barmenia Gothar. Auch wenn Sie das vielleicht öfter hören: Ich verspreche Ihnen, ich bin anders als die anderen. Es geht um die Beitragsentwicklung in der Gesundheitsversorgung. Haben Sie gerade einen kurzen Moment?`;
}

function buildGatekeeperIntro(ctx: Pick<CallContext, "ownerRealName" | "contactName">): string {
  const ownerName = ctx.ownerRealName?.trim() || "Matthias Duic";
  const addressedOwner = /^herr\s/i.test(ownerName) ? ownerName : `Herrn ${ownerName}`;
  const targetName = ctx.contactName?.trim() || "der zuständigen Person";
  return `Guten Tag, ich bin Gloria, die digitale Vertriebsassistentin von ${addressedOwner} aus dem Hause der Barmenia Gothar. Könnten Sie mich bitte mit ${targetName} verbinden?`;
}

export function canConfirmRealtimeAppointment(ctx: CallContext): { ok: true } | { ok: false; reason: string } {
  if (ctx.topicKind !== "pkv") return { ok: true };
  if (ctx.dialogState.pkvStep >= 6) return { ok: true };
  const assessment = assessPkvConversation(ctx.transcript);
  if (assessment.stage === "ready_to_schedule") return { ok: true };
  const stagedReason = instructionForPkvStage(assessment);
  if (stagedReason) return { ok: false, reason: stagedReason };
  const contributionPhrase = extractCurrentContributionPhrase(ctx.transcript);
  return { ok: false, reason: instructionForPkvStep(ctx.dialogState.pkvStep, contributionPhrase) };
}

export function isOfferedSlotPhrase(ctx: CallContext, phrase: string): boolean {
  return isSuppliedAppointmentSlot(ctx.freeSlotsPrompt, phrase);
}

export function buildRealtimeInstructions(ctx: CallContext): string {
  const company = ctx.ownerCompanyName?.trim() || "Agentur Duic Sprockhövel";
  const owner = ctx.ownerRealName?.trim() || "Matthias Duic";
  const society = getSocietyName(ctx);
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
    "AUSSPRACHE: Der Nachname Duic wird immer 'Duitsch' ausgesprochen.",
    `Heute ist ${today}. Du führst ein echtes deutsches Telefongespräch, keinen Fragebogen und kein Skript.`,
    "ANTWORTSTIL: Antworte auf den konkreten Sinn der letzten Aussage, nicht auf einzelne Wörter. Bei Sorge oder Einwand: ein kurzer, konkreter Spiegelungssatz, dann eine passende Frage. Bei einer klaren Information: direkt mit dem nächsten Schritt fortfahren. Bei Interesse: direkt den nächsten Schritt anbieten. Vermeide Einleitungen wie 'Alles klar', 'Verstehe', 'Super', 'Perfekt' oder 'Danke'.",
    "Sprich ruhig, freundlich und konkret. Höchstens ein kurzer Satz und eine Frage. Kein Callcenter-Monolog, keine künstliche Vertrautheit, keine Wiederholung der Kundenaussage und keine leeren Bestätigungen. Sprich Standarddeutsch und keine englischen Füllwörter.",
    "Lass den Kunden ausreden. Ein Fragment, 'äh', 'mhm', 'aha' oder unklarer Ton ist keine Zustimmung, keine Terminwahl und keine Verabschiedung. Frage dann einmal kurz nach, statt etwas anzunehmen.",
    "Die Topic Policy steuert Anlass, Nutzen, Einwände und fachliche Grenzen. Die universellen Regeln zu Transparenz, Freiwilligkeit, Datenschutz und Terminlogik haben Vorrang.",
    "Bei Unsicherheit korrigierst du dich diskret mit einer klaren, konkreten Formulierung. Erfinde keine Fakten und übe keinen Druck aus.",
    "Wenn der Kunde eine Frage oder einen Einwand bringt, verlässt du den geplanten Gesprächspfad sofort, beantwortest ihn konkret und kehrst nur bei natürlicher Gelegenheit zum Ziel zurück.",
    "Wenn der Kunde klar ablehnt, respektierst du das ohne weiteren Überredungsversuch, verabschiedest dich hörbar und rufst danach end_call auf.",
    ctx.confirmedSlotPhrase
      ? `VERABSCHIEDUNG NACH TERMIN UND E-MAIL: Die letzte Aussage muss exakt lauten: '${APPOINTMENT_FAREWELL_TEXT}' Beende danach das Gespräch ohne weitere Frage.`
      : `VERABSCHIEDUNG OHNE TERMIN: Die letzte Aussage muss exakt lauten: '${FINAL_FAREWELL_TEXT}' Rufe danach end_call auf.`,
    "Wenn ein Mensch verlangt wird, kündigst du die Übergabe kurz an und rufst danach transfer_to_human auf.",
    "Einen Termin bestätigst du nur aus den bereitgestellten freien Slots. Frage zuerst, ob eher Vormittag oder Nachmittag passt, und biete danach zwei echte freie Optionen an verschiedenen Tagen an. Eine eindeutige Auswahl wie 'der Montag', 'der zweite Termin' oder 'Montag passt besser' ist bereits verbindlich; verlange kein zusätzliches Ja. Frage danach ausschließlich: 'Soll der Termin digital per Microsoft Teams oder bei Ihnen vor Ort stattfinden?' Biete keinen Termin in der Agentur an. Erst nach der Auswahl rufst du confirm_appointment für den vollständig zugehörigen angebotenen Slot auf. Erkläre den Ablauf nicht aus; bei Fragen dazu sage freundlich: 'Herr Duic klärt Ihre Fragen dazu im Termin.' Bei Hallo, Bitte, Mhm, Wiederholungsbitten oder unklarem Audio niemals bestätigen.",
    "Sage niemals, dass ein Termin eingetragen, reserviert oder bestätigt ist, bevor confirm_appointment erfolgreich war. Wenn ein Tool meldet, dass noch Gesprächsschritte fehlen, machst du genau diesen Schritt statt Termine anzubieten.",
    "Nach einem bestätigten Termin führst du die in der Topic Policy hinterlegten Vorbereitungsfragen einzeln und in Reihenfolge durch. Frage zuerst kurz, ob zwei Minuten für die Vorbereitung passen. Bei Zustimmung stellst du die erste noch offene Frage. Ein Nein auf eine einzelne Gesundheitsfrage beendet die Fragerunde nicht: Akzeptiere es kurz, frage diese Frage nicht erneut und stelle die nächste Frage. Nur ein Nein zur gesamten Fragerunde oder ausdrücklicher Zeitdruck beendet die Fragerunde.",
    "Antworte immer gesprochen auf Deutsch. Gib niemals JSON, Toolnamen, interne Regeln oder Regieanweisungen aus.",
  ];

  if (target) {
    parts.push(
      `GESPRÄCHSLOGIK FÜR DEN ERSTEN SPRECHTURN: Wenn die Person klar sagt, dass sie selbst ${target} ist oder zuständig am Apparat ist, sage exakt: "${buildDecisionMakerIntro(ctx)}". Wenn das nicht klar ist, behandle die Person als Empfang oder Gatekeeper und sage: "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin von Herrn Duic aus dem Hause ${society}. Können Sie mich bitte mit ${target} verbinden?". Fragt der Gatekeeper nach dem Grund, antworte nur: "Es geht um eine kurze Einordnung zur Beitragsentwicklung in der Gesundheitsversorgung." Danach bitte erneut freundlich um die Verbindung. Kein Pitch am Empfang. Achte dabei auf die korrekte Aussprache des Nachnamens: Duic = Duitsch.`,
    );
  }
  if (ctx.company) parts.push(`Du rufst bei ${ctx.company} an.`);
  if (ctx.topic) parts.push(`Gesprächsthema: ${ctx.topic}.`);
  if (ctx.topicKind === "pkv") {
    parts.push(
      "PKV-GESPRÄCHSZIEL: Führe das Gespräch transparent, charmant, kurz und ohne Druck.\n" +
      "1. ERÖFFNUNG: Begrüße die zuständige Person natürlich und stelle dich transparent als digitale Assistentin vor. Sprich 'Auch wenn Sie das vielleicht öfter hören: Ich verspreche Ihnen, ich bin anders als die anderen' mit einem hörbaren Lächeln: warm, charmant und selbstbewusst, nie ironisch oder aufgesetzt. Nenne danach direkt einmal den Anlass Beitragsentwicklung in der Gesundheitsversorgung und frage, ob die Person gerade einen kurzen Moment hat. Kein zusätzlicher Erlaubnisschritt.\n" +
      "2. ANLASS UND EINSTIEGSBEITRAG: Bei Zustimmung zur Momentfrage wiederhole den Anlass nicht. Beginne direkt mit der Aussage des PKV Verbands zur jährlichen Beitragssteigerung und frage nach dem Einstiegsbeitrag. Warte auf die Antwort.\n" +
      "3. HEUTIGER BEITRAG: Frage separat und genau einmal: 'Und welchen Beitrag zahlen Sie heute?' Warte auf die Antwort. Wenn der Kunde keinen Betrag weiß oder nennen möchte, akzeptiere das ohne Nachhaken.\n" +
      "4. HOCHRECHNUNG: Nutze für die persönliche Zehn-Jahres-Beispielrechnung den zuletzt genannten heutigen Beitrag, nie den Einstiegsbeitrag. Nenne die Annahme von rund vier Prozent kurz und frage: 'Haben Sie das schon einmal für sich hochgerechnet?' Erfinde keinen persönlichen Betrag.\n" +
      "5. ÜBERLEITUNG: Greife die Reaktion auf, sage in höchstens zwei kurzen Sätzen, dass Herr Duic die individuelle Entwicklung bis zum Ruhestand und Möglichkeiten für einen besser planbaren, tragbaren Beitrag im Alter zeigt. Wecke Interesse, ohne den Ablauf zu erklären oder ein Ergebnis zu versprechen, und frage, ob der Kunde das mit Herrn Duic anschauen möchte.\n" +
      "6. TERMIN: Erst bei klarem Interesse Zeitpräferenz und genau zwei echte freie Termine innerhalb des gewählten Fensters erfragen: vormittags 08:30–11:00 Uhr oder nachmittags 13:00–18:00 Uhr. Biete keinen ungefilterten Slot an. Danach ausschließlich digital per Microsoft Teams oder bei der Kundin/dem Kunden vor Ort anbieten; niemals die Agentur nennen. Eine klare Auswahl ist verbindlich und darf nicht erneut bestätigt werden.\n" +
      "7. ABSCHLUSS: Nach erfolgreicher Terminbestätigung die bestehende freiwillige Vorbereitung mit allen PKV-Fragen einzeln durchführen, E-Mail-Adresse erfragen und die Bestätigung über den bestehenden Prozess versenden.\n" +
      "SPRACHE: Sprich 'Beitragsentwicklung in der Gesundheitsversorgung'; Duic wird 'Duitsch' ausgesprochen. Eine Frage pro Turn, keine Gesundheitsfragen vor dem Termin, keine langen Erklärungen. Transparenz, Freiwilligkeit und Kundenfragen haben Vorrang.",
    );
  }
  if (ctx.leadNote?.trim()) parts.push(`Hilfreicher Lead-Kontext: ${ctx.leadNote.trim()}`);
  if (ctx.isCallback && ctx.previousSummary?.trim()) {
    parts.push(`Dies ist ein vereinbarter Rückruf. Letzter Stand: ${ctx.previousSummary.trim()}`);
  }
  if (ctx.topicPolicyPrompt) parts.push(ctx.topicPolicyPrompt);
  if (ctx.confirmedSlotPhrase) {
    parts.push(`Bereits bestätigter Termin: ${ctx.confirmedSlotPhrase}. Diesen Termin nicht verändern.`);
  }
  
  // Phase-specific instructions to keep conversation on track
  if (ctx.topicKind !== "pkv") {
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
        "Verstehe die aktuelle Situation des Kunden (Alter, Beitrag, Status, Bedenken). " +
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
  }
  
  parts.push("VERBINDLICHE ERSTKONTAKT-REGEL: Dies ist grundsätzlich eine Neukundenakquise und der erste Kontakt. Behaupte niemals, der Kunde habe eine Anfrage gestellt, Unterlagen gesendet oder um einen Rückruf geboten, außer der Rückruf ist ausdrücklich als Rückruf gekennzeichnet. Verwende am Gesprächsbeginn den vorgegebenen Erstkontakt-Wortlaut und beginne nicht mit der Versicherungsfrage.");

  const instructions = parts.join("\n\n");
  return convertNumbersForSpeech(normalizePkvTerminology(instructions));
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
    const summaryText = 
      `[Transcript Rotation: ${discardedTurns.length} älteren Turns gerotiert (${userTurnsCount} Kunde, ${assistantTurnsCount} Gloria). ` +
      `Gesprächsverlauf bis hierher: Termin-Qualifizierung fortlaufend. ` +
      `Aktuelles Dialog-Fortschritt: Phase=${ctx.dialogState.phase}.]`;
    
    ctx.transcript = [
      { role: "assistant", text: summaryText, at: discardedTurns[0]?.at || Date.now() },
      ...retainedTurns,
    ];
    
    log.info("realtime.transcript_rotated", {
      callSid: ctx.callSid,
      discarded: discardedTurns.length,
      retained: retainedTurns.length,
      dialogPhase: ctx.dialogState.phase,
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
  let bargeInAwaitingTranscript = false;
  let bargeInRecoveryTimer: NodeJS.Timeout | null = null;
  let assistantTranscript = "";
  let assistantTranscriptDeltaSeen = false;
  let assistantContinuationRequested = false;
  let ttsAbortController: AbortController | null = null;
  let ttsTurn = 0;
  let responseInterrupted = false;
  let currentAssistantTurnIndex: number | undefined;
  let decisionMakerIntroWasLastResponse = false;
  let responseCreatedAt: number | null = null;
  let firstModelTokenAt: number | null = null;
  let firstTtsChunkAt: number | null = null;
  let preparationState: PreparationState = createPreparationStateForCall("other");
  let contactRouting: ContactRoutingState | null = null;
  let unclearClarificationPending = false;
  let userIsSpeaking = false;
  let transferWaitingStartedAt: number | null = null;
  let ttsPlaybackStartedAt: number | null = null; // timestamp when current TTS started playing
  let terminationInProgress = false;
  let hangupAfterPlayback = false;
  let interruptedAssistantContext = "";
  const pendingUserTranscripts: string[] = [];
  const handledToolCalls = new Set<string>();
  let pendingDeterministicSpeech: { text: string; hangupAfterPlayback?: boolean } | null = null;
  let flushDeterministicSpeech = () => undefined;

  const sendOpenAi = (event: Record<string, unknown>): boolean => {
    return openaiSession?.send(event) ?? false;
  };

  const sendTelnyx = (event: Record<string, unknown>): boolean => {
    if (telnyx.readyState !== telnyx.OPEN) return false;
    telnyx.send(JSON.stringify(event));
    return true;
  };

  const recordAssistantContext = (text: string) => {
    sendOpenAi({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    });
  };

  const playback = new TelnyxPlayback({
    prebufferFrames: 2,
    sendFrame: (frame) => sendTelnyx({
      event: "media",
      stream_id: streamId,
      media: { payload: frame.toString("base64") },
    }),
    onIdle: () => {
      flushDeterministicSpeech();
      responses.flush();
      if (hangupAfterPlayback && ctx && !responses.isActive()) {
        hangupAfterPlayback = false;
        setTimeout(() => {
          if (!ctx || terminationInProgress) return;
          terminationInProgress = true;
          log.info("realtime.hangup_after_farewell", { callSid: ctx.callSid });
          void notifyCallAction(ctx, "hangup");
        }, 350);
      }
    },
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
    cooldownMs: Number.parseInt(process.env.OPENAI_RESPONSE_COOLDOWN_MS?.trim() || "40", 10),
  });

  const updateSession = () => {
    if (!ctx || !openaiSession?.isReady()) return;
    const vadThreshold = Number.parseFloat(process.env.OPENAI_REALTIME_VAD_THRESHOLD?.trim() || "0.7");
    const silenceDurationMs = Number.parseInt(
      process.env.OPENAI_REALTIME_SILENCE_MS?.trim()
        || process.env.OPENAI_ASR_SILENCE_MS?.trim()
        || "500",
      10,
    );
    const prefixPaddingMs = Number.parseInt(process.env.OPENAI_REALTIME_PREFIX_PADDING_MS?.trim() || "300", 10);
    const maxOutputTokens = Number.parseInt(process.env.OPENAI_REALTIME_MAX_OUTPUT_TOKENS?.trim() || "220", 10);
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
                || "Deutsches Geschaeftstelefonat. Zahlen und Eigennamen exakt transkribieren.",
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
    let retryCount = 0;

    try {
      while (true) {
        try {
          await streamElevenLabsAudio(text, outputFormat, controller.signal, (chunk) => {
            if (controller.signal.aborted || turn !== ttsTurn || responseInterrupted) return;
            if (audioBytes === 0) {
              const now = Date.now();
              ttsPlaybackStartedAt = now;
              firstTtsChunkAt = now;
              const userFinalAt = ctx?.lastUserFinalAt;
              if (ctx && userFinalAt) {
                log.info("realtime.turn_latency", {
                  callSid: ctx.callSid,
                  asrFinalToResponseCreatedMs: responseCreatedAt ? responseCreatedAt - userFinalAt : undefined,
                  asrFinalToFirstModelTokenMs: firstModelTokenAt ? firstModelTokenAt - userFinalAt : undefined,
                  asrFinalToFirstTtsChunkMs: now - userFinalAt,
                  responseCreatedToFirstTtsChunkMs: responseCreatedAt ? now - responseCreatedAt : undefined,
                });
              }
            }
            audioBytes += chunk.length;
            playback.appendBase64Audio(chunk.toString("base64"));
          }, ctx?.voiceProfile);
          break;
        } catch (error) {
          if (!controller.signal.aborted && shouldRetryElevenLabsStream(error, audioBytes, retryCount)) {
            retryCount += 1;
            log.warn("realtime.elevenlabs_retry", { callSid: ctx?.callSid, retryCount, error: error instanceof Error ? error.message : String(error) });
            continue;
          }
          throw error;
        }
      }
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
          audioBytes,
          retryCount,
        });
        playback.interrupt();
      }
    } finally {
      if (ttsAbortController === controller) ttsAbortController = null;
    }
  };

  const requestResponse = (instructions?: string) => {
    const interruption = interruptedAssistantContext;
    interruptedAssistantContext = "";
    const withInterruption = interruption
      ? `Du wurdest während dieses begonnenen Satzes unterbrochen: "${interruption}". Reagiere jetzt auf die neue Kundenaussage. Wiederhole den Satz nicht vollständig und stelle keine bereits beantwortete Frage erneut.\n${instructions || ""}`
      : instructions;
    const responseInstructions = ctx ? buildRealtimeResponseInstructions(ctx, withInterruption) : withInterruption || "";
    return responses.request(responseInstructions);
  };

  const requestEventResponse = (instructions: string) => {
    const interruption = interruptedAssistantContext;
    interruptedAssistantContext = "";
    const withInterruption = interruption
      ? `Du wurdest während dieses begonnenen Satzes unterbrochen: "${interruption}". Reagiere jetzt auf die neue Kundenaussage. Wiederhole den Satz nicht vollständig und stelle keine bereits beantwortete Frage erneut.\n${instructions}`
      : instructions;
    const responseInstructions = ctx ? buildRealtimeResponseInstructions(ctx, withInterruption, false) : withInterruption;
    return responses.request(responseInstructions);
  };

  const requestDeterministicSpeech = (text: string, options: { hangupAfterPlayback?: boolean } = {}) => {
    interruptedAssistantContext = "";
    const speechText = convertNumbersForSpeech(normalizePkvTerminology(text.replace(/\s+/g, " ").trim()));
    if (!speechText || pendingDeterministicSpeech) return false;
    pendingDeterministicSpeech = { text: speechText, ...options };
    flushDeterministicSpeech();
    return true;
  };

  flushDeterministicSpeech = () => {
    if (!ctx || !pendingDeterministicSpeech || responses.isActive() || playback.isPending() || terminationInProgress) return;
    const pending = pendingDeterministicSpeech;
    pendingDeterministicSpeech = null;
    playback.startResponse();
    const latencyMs = ctx.lastUserFinalAt ? Date.now() - ctx.lastUserFinalAt : undefined;
    ctx.transcript.push({
      role: "assistant",
      text: pending.text,
      at: Date.now(),
      latencyMs,
      phase: ctx.dialogState.phase,
    });
    rotateTranscriptIfNeeded(ctx);
    updateDialogPhase(ctx);
    currentAssistantTurnIndex = ctx.transcript.length - 1;
    log.info("realtime.gloria_said", {
      callSid: ctx.callSid,
      text: pending.text,
      latencyMs,
      deterministic: true,
    });
    recordAssistantContext(pending.text);
    if (pending.hangupAfterPlayback) hangupAfterPlayback = true;
    responseInterrupted = false;
    void speakWithElevenLabs(pending.text);
  };

  const clearBargeInRecovery = () => {
    if (bargeInRecoveryTimer) clearTimeout(bargeInRecoveryTimer);
    bargeInRecoveryTimer = null;
  };

  const recoverInterruptedBargeIn = (reason: "synthetic_transcript" | "transcript_timeout") => {
    if (!bargeInAwaitingTranscript || !ctx || terminationInProgress) return;
    bargeInAwaitingTranscript = false;
    clearBargeInRecovery();
    log.warn("realtime.barge_in_recovered", { callSid: ctx.callSid, reason });
    const text = contactRouting?.stage === "decision_maker" && ctx.dialogState.pkvStep === 0
      ? "Entschuldigung, die Leitung war gerade etwas undeutlich. Es geht um die Beitragsentwicklung in der Gesundheitsversorgung. Haben Sie gerade einen kurzen Moment?"
      : "Entschuldigung, das habe ich akustisch nicht verstanden. Können Sie das bitte kurz wiederholen?";
    requestDeterministicSpeech(text);
  };

  const speakDeterministicIntro = (text: string, route: "decision_maker" | "gatekeeper") => {
    if (!ctx) return;
    playback.startResponse();
    ctx.transcript.push({ role: "assistant", text, at: Date.now(), phase: ctx.dialogState.phase });
    currentAssistantTurnIndex = ctx.transcript.length - 1;
    decisionMakerIntroWasLastResponse = route === "decision_maker";
    log.info("realtime.gloria_said", { callSid: ctx.callSid, text, route, immediate: true });
    recordAssistantContext(text);
    void speakWithElevenLabs(text);
  };

  const requestHangupAfterPlayback = () => {
    hangupAfterPlayback = true;
    if (!playback.isPending() && !responses.isActive() && ctx) {
      hangupAfterPlayback = false;
      terminationInProgress = true;
      log.info("realtime.hangup_after_farewell", { callSid: ctx.callSid });
      void notifyCallAction(ctx, "hangup");
    }
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
    if (terminationInProgress) return;
    if (isSyntheticTranscriptionPrompt(transcript)) {
      log.warn("realtime.synthetic_transcript_ignored", { callSid: ctx.callSid, text: transcript });
      return;
    }
    if (playback.isPending()) {
      ttsTurn += 1;
      ttsAbortController?.abort();
      playback.interrupt();
      sendTelnyx({ event: "clear" });
      log.info("realtime.playback_interrupted_by_user", { callSid: ctx.callSid });
    }
    pendingDeterministicSpeech = null;
    const currentContext = ctx;
    assistantContinuationRequested = false;
    currentContext.lastUserFinalAt = Date.now();
    currentContext.transcript.push({ role: "user", text: transcript, at: Date.now(), phase: currentContext.dialogState.phase });
    rotateTranscriptIfNeeded(currentContext);

    updateDialogPhase(currentContext);
    // Reset deduplication so same instruction can fire again after user speaks
    responses.clearLastHash();

    log.info("realtime.user_said", { callSid: currentContext.callSid, text: transcript });

    const event = classifyConversationEvent(transcript);
    if (event.type === "unclear") {
      if (!unclearClarificationPending) {
        unclearClarificationPending = true;
        requestDeterministicSpeech("Entschuldigung, wie haben Sie das gemeint?");
      }
      return;
    }
    unclearClarificationPending = false;

    if (event.type === "clear_rejection") {
      requestDeterministicSpeech(FINAL_FAREWELL_TEXT, { hangupAfterPlayback: true });
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
        speakDeterministicIntro(buildGatekeeperIntro(currentContext), "gatekeeper");
        return;
      }
      speakDeterministicIntro(buildDecisionMakerIntro(currentContext), "decision_maker");
      return;
    }

    if (preparationState.stage === "inactive") {
      // ── PKV: step-based state machine ──────────────────────────────────────
      if (currentContext.topicKind === "pkv") {
        const currentStep = currentContext.dialogState.pkvStep;

        if (currentStep === 4 && event.type !== "customer_question" && event.type !== "objection" && !isClearPkvInterest(transcript)) {
          requestDeterministicSpeech("Habe ich Sie richtig verstanden: Soll Herr Duic Ihnen das einmal persönlich zeigen?");
          return;
        }

        // Customer asks a question or raises an objection → answer then return to current step
        if (event.type === "customer_question" || event.type === "objection") {
          let returnInstruction: string;
          if (currentStep === 6 && currentContext.appointmentSlotsOffered) {
            returnInstruction = "Beantworte die Frage kurz. Bei Fragen zum Ablauf sage: 'Herr Duic klärt Ihre Fragen dazu im Termin.' Wiederhole die angebotenen Termine nicht und verlange keine erneute Bestätigung. Kehre danach zur offenen Terminauswahl oder zur Frage nach digitalem Termin beziehungsweise Termin bei der Kundin/dem Kunden vor Ort zurück.";
          } else if (currentStep === 6) {
            const preference = detectAppointmentPreference(currentContext.transcript);
            const slots = getAppointmentOfferSlots(currentContext.freeSlotsPrompt, preference);
            if (preference === "unknown") {
              currentContext.appointmentPreferenceAsked = true;
              returnInstruction = "Beantworte die Frage kurz und frage danach ausschließlich: 'Passt Ihnen grundsätzlich eher ein Vormittag oder ein Nachmittag?' Nenne noch keinen Termin.";
            } else if (slots.length === 2) {
              currentContext.appointmentOfferedSlots = slots;
              currentContext.appointmentSlotsOffered = true;
              returnInstruction = `Beantworte die Frage kurz und biete danach ausschließlich diese beiden freien Termine an: ${slots[0]} oder ${slots[1]}. Frage, welcher Termin besser passt. Erfinde keine weiteren Termine.`;
            } else {
              returnInstruction = "Beantworte die Frage kurz. Sage danach, dass im gewünschten Zeitfenster aktuell nicht zwei passende freie Termine bereitstehen, und frage, ob das andere Zeitfenster möglich wäre. Erfinde keine Uhrzeit.";
            }
          } else {
            returnInstruction = `Antworte kurz und konkret auf den Einwand oder die Frage. Kehre dann unmittelbar zum aktuellen Gesprächsschritt zurück und stelle genau eine passende Folgefrage: ${instructionForPkvStep(currentStep, extractCurrentContributionPhrase(currentContext.transcript))}`;
          }
          requestEventResponse(instructionForConversationEvent(event, returnInstruction));
          return;
        }

        // Normal answer: advance step
        const advance = advancePkvStep(currentStep, transcript);

        if (advance.shouldEnd) {
          requestDeterministicSpeech(FINAL_FAREWELL_TEXT, { hangupAfterPlayback: true });
          return;
        }

        const nextStep = advance.nextStep as 0 | 1 | 2 | 3 | 4 | 6;
        if (currentStep === 1 && nextStep === 1) {
          requestDeterministicSpeech("Mit welchem Beitrag haben Sie einmal angefangen?");
          return;
        }
        if (nextStep !== currentStep) {
          currentContext.dialogState.pkvStep = nextStep;
          log.info("realtime.pkv_step_advanced", { callSid: currentContext.callSid, from: currentStep, to: nextStep });
        }

        // Step 6: appointment scheduling — use existing appointment logic
        if (currentContext.dialogState.pkvStep === 6) {
          if (!currentContext.appointmentPreferenceAsked) {
            currentContext.appointmentPreferenceAsked = true;
            requestDeterministicSpeech("Passt Ihnen grundsätzlich eher ein Vormittag oder ein Nachmittag?");
            return;
          }
          if (detectAppointmentPreference(currentContext.transcript) === "unknown") {
            requestDeterministicSpeech("Passt Ihnen eher ein Vormittag oder ein Nachmittag?");
            return;
          }
          const preference = detectAppointmentPreference(currentContext.transcript);
          if (!currentContext.appointmentSlotsOffered) {
            const slots = getAppointmentOfferSlots(currentContext.freeSlotsPrompt, preference);
            const offer = appointmentOfferInstruction(currentContext.freeSlotsPrompt, preference);
            if (offer && slots.length === 2) {
              currentContext.appointmentOfferedSlots = slots;
              currentContext.appointmentSlotsOffered = true;
              requestDeterministicSpeech(`Ich kann Ihnen ${slots[0]} oder ${slots[1]} anbieten. Welcher Termin passt Ihnen besser?`);
              return;
            }
            requestEventResponse("Im gewünschten Zeitfenster stehen aktuell nicht zwei passende freie Termine bereit. Erfinde und biete keine Uhrzeiten an. Sage das kurz und frage, ob das jeweils andere Zeitfenster grundsätzlich auch möglich wäre.");
            return;
          }

          if (currentContext.selectedAppointmentSlot) {
            const mode = detectAppointmentMode(currentContext.transcript);
            if (mode) {
              requestEventResponse(`Der Kunde hat verbindlich ${currentContext.selectedAppointmentSlot} gewählt und ${mode} als Durchführungsart genannt. Rufe jetzt confirm_appointment exakt einmal mit slot_phrase "${currentContext.selectedAppointmentSlot}" auf. Stelle keine Rückfrage zur Bestätigung und wiederhole den Termin nicht.`);
              return;
            }
            requestDeterministicSpeech("Soll der Termin digital per Microsoft Teams oder bei Ihnen vor Ort stattfinden?");
            return;
          }

          const selectedSlot = matchOfferedAppointmentSelection(transcript, currentContext.appointmentOfferedSlots || []);
          if (selectedSlot) {
            currentContext.selectedAppointmentSlot = selectedSlot;
            const selectedMode = detectAppointmentMode([{ role: "user", text: transcript }]);
            if (selectedMode) {
              requestEventResponse(`Der Kunde hat verbindlich ${selectedSlot} ausgewählt und ${selectedMode} als Durchführungsart genannt. Rufe jetzt confirm_appointment exakt einmal mit slot_phrase "${selectedSlot}" auf. Stelle keine Rückfrage, bestätige die Auswahl nicht zusätzlich und wiederhole den Termin nicht.`);
              return;
            }
            requestDeterministicSpeech("Soll der Termin digital per Microsoft Teams oder bei Ihnen vor Ort stattfinden?");
            return;
          }

          if (/\b(?:beide|keiner|keinen\s+von\s+beiden|weder\s+noch|passen\s+beide\s+nicht|beide\s+nicht)\b/i.test(transcript)) {
            requestEventResponse("Die beiden angebotenen Termine passen nicht. Frage einmal nach einem passenden Wochentag im selben Zeitfenster. Biete keine Uhrzeit an, die nicht in der freien Kalenderliste steht.");
            return;
          }

          requestDeterministicSpeech("Welcher der beiden Termine passt Ihnen besser?");
          return;
        }

        const instruction = instructionForPkvStep(currentContext.dialogState.pkvStep, extractCurrentContributionPhrase(currentContext.transcript));
        const deterministicText = responseTextForPkvStep(
          currentContext.dialogState.pkvStep,
          extractCurrentContributionPhrase(currentContext.transcript),
        );
        if (deterministicText) requestDeterministicSpeech(deterministicText);
        else requestEventResponse(instruction);
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

    const previousPreparationStage = preparationState.stage;
    const transition = advancePreparation(preparationState, transcript, currentContext.transcript);
    preparationState = transition.state;

    if (previousPreparationStage === "awaiting_email" && transition.state.stage === "completed") {
      requestDeterministicSpeech(transition.speechText || APPOINTMENT_FAREWELL_TEXT, { hangupAfterPlayback: true });
      return;
    }

    if (transition.speechText) requestDeterministicSpeech(transition.speechText);
    else requestEventResponse(transition.instruction);
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
      const requestedPhrase = typeof args.slot_phrase === "string" ? args.slot_phrase.trim() : "";
      const phrase = ctx.selectedAppointmentSlot || requestedPhrase;
      const appointmentMode = detectAppointmentMode(ctx.transcript);
      if (!appointmentMode) {
        handledToolCalls.delete(tool.callId);
        const instruction = "Der Termin wurde ausgewählt, aber die Durchführungsart fehlt noch. Frage exakt: 'Soll der Termin digital per Microsoft Teams oder bei Ihnen vor Ort stattfinden?' Biete keinen Termin in der Agentur an. Rufe confirm_appointment erst nach der Kundenantwort erneut für denselben Termin auf.";
        sendToolResult(tool.callId, { ok: false, error: "missing_appointment_mode", instruction });
        requestResponse(instruction);
        return;
      }
      const decision = decideAppointment({
        turns: ctx.transcript,
        topicKind: ctx.topicKind === "pkv" ? "pkv" : "other",
        freeSlotsPrompt: ctx.freeSlotsPrompt,
        slotPhrase: phrase,
      });
      if (!decision.ok && decision.error === "slot_not_offered") {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: decision.error, instruction: decision.instruction });
        requestResponse(decision.instruction);
      } else if (!decision.ok) {
        handledToolCalls.delete(tool.callId);
        sendToolResult(tool.callId, { ok: false, error: decision.error, instruction: decision.instruction });
      } else {
        const speechSlotPhrase = convertSlotPhraseForSpeech(decision.slotPhrase);
        ctx.confirmedSlotPhrase = speechSlotPhrase;
        ctx.appointmentMode = appointmentMode;
        log.info("realtime.slot_locked", { callSid: ctx.callSid, slot: decision.slotPhrase, speechSlot: speechSlotPhrase, preference: decision.preference, appointmentMode });
        sendToolResult(tool.callId, { ok: true, confirmed_slot: speechSlotPhrase, appointment_mode: appointmentMode });
        updateSession();
        const transition = beginPreparation(preparationState, speechSlotPhrase, ctx.transcript);
        preparationState = transition.state;
        if (transition.speechText) requestDeterministicSpeech(transition.speechText);
        else requestResponse(transition.instruction);
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
      const canTerminateFromPreparation = preparationState.stage === "completed";
      if (!canTerminateFromPreparation && !hasClearFarewellOrRejection(ctx) && !hasAffirmedAssistantEndQuestion(ctx)) {
        handledToolCalls.delete(tool.callId);
        const instruction = "Beende das Gespräch nicht und verlange keine Bestätigung zum Auflegen. Fahre mit dem noch offenen Gesprächsschritt fort.";
        sendToolResult(tool.callId, { ok: false, error: "unclear_hangup_request", instruction });
        requestResponse(instruction);
        return;
      }
      pendingUserTranscripts.splice(0);
      sendToolResult(tool.callId, { ok: true });
      requestHangupAfterPlayback();
    }
  };

  const connectOpenAi = () => {
    if (!ctx || openaiSession) return;
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1";

    let handleRealtimeEvent = async (_message: RealtimeServerEvent): Promise<void> => undefined;
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

    handleRealtimeEvent = async (message) => {

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

        // Greeting gets longer protection (2500ms) — it's ~4s long and must not be cut off
        const MIN_TTS_PLAY_MS = decisionMakerIntroWasLastResponse ? 2500 : 900;
        const ttsAge = ttsPlaybackStartedAt ? Date.now() - ttsPlaybackStartedAt : Infinity;
        const playbackPending = playback.isPending();

        const plan = planBargeIn({
          responseActive: responses.isActive(),
          playbackPending,
        });

        // Only actually interrupt if: plan says to AND TTS has played long enough
        if (plan.interrupted && ttsAge >= MIN_TTS_PLAY_MS) {
          bargeInAwaitingTranscript = true;
          clearBargeInRecovery();
          ttsTurn += 1;
          ttsAbortController?.abort();
          const interruption = playback.interrupt();
          responseInterrupted = true;
          responses.markInterruptRequested();
          if (plan.clearTelnyxPlayback) sendTelnyx({ event: "clear" });
          for (const event of plan.openAiEvents) sendOpenAi(event);
          if (ctx && currentAssistantTurnIndex !== undefined) {
            interruptedAssistantContext = ctx.transcript[currentAssistantTurnIndex]?.text || "";
            currentAssistantTurnIndex = undefined;
          }
          ttsPlaybackStartedAt = null;
          log.info("realtime.barge_in", {
            callSid: ctx?.callSid,
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
        if (bargeInAwaitingTranscript && !bargeInRecoveryTimer) {
          bargeInRecoveryTimer = setTimeout(() => recoverInterruptedBargeIn("transcript_timeout"), 2200);
        }
        return;
      }

      if (message.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = message.transcript?.trim();
        if (ctx && transcript) {
          if (terminationInProgress) return;
          if (shouldRecoverInterruptedBargeIn(bargeInAwaitingTranscript, transcript)) {
            log.warn("realtime.synthetic_transcript_ignored", { callSid: ctx.callSid, text: transcript });
            recoverInterruptedBargeIn("synthetic_transcript");
            return;
          }
          if (bargeInAwaitingTranscript) {
            bargeInAwaitingTranscript = false;
            clearBargeInRecovery();
          }
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
        responseCreatedAt = Date.now();
        firstModelTokenAt = null;
        firstTtsChunkAt = null;
        responses.markCreated();
        responseInterrupted = false;
        decisionMakerIntroWasLastResponse = false;
        currentAssistantTurnIndex = undefined;
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.output_text.delta" || message.type === "response.text.delta") {
        if (responseInterrupted) return;
        if (!firstModelTokenAt) firstModelTokenAt = Date.now();
        assistantTranscript += message.delta || "";
        assistantTranscriptDeltaSeen = true;
        return;
      }

      if (
        message.type === "response.output_text.done"
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
          responseCreatedAt = null;
          firstModelTokenAt = null;
          firstTtsChunkAt = null;
          assistantTranscript = "";
          assistantTranscriptDeltaSeen = false;
          return;
        }
        const rawTranscript = assistantTranscript.replace(/\s+/g, " ").trim();
        const transcript = ctx?.topicKind === "pkv" ? normalizePkvTerminology(rawTranscript) : rawTranscript;
        if (ctx && transcript) {
          const latencyMs = ctx.lastUserFinalAt ? Date.now() - ctx.lastUserFinalAt : undefined;
          if (ctx.lastUserFinalAt) {
            log.info("realtime.turn_latency_completed", {
              callSid: ctx.callSid,
              asrFinalToResponseDoneMs: Date.now() - ctx.lastUserFinalAt,
              asrFinalToResponseCreatedMs: responseCreatedAt ? responseCreatedAt - ctx.lastUserFinalAt : undefined,
              asrFinalToFirstModelTokenMs: firstModelTokenAt ? firstModelTokenAt - ctx.lastUserFinalAt : undefined,
              asrFinalToFirstTtsChunkMs: firstTtsChunkAt ? firstTtsChunkAt - ctx.lastUserFinalAt : undefined,
            });
          }
          ctx.transcript.push({
            role: "assistant",
            text: transcript,
            at: Date.now(),
            latencyMs,
            phase: ctx.dialogState.phase,
          });
          rotateTranscriptIfNeeded(ctx);

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
          requestResponse("Deine letzte Antwort wurde technisch vor der Audioausgabe abgeschnitten. Formuliere die vollständige, fachlich korrekte Antwort jetzt neu in höchstens zwei kurzen Sätzen. Beginne mit einem vollständigen Satz, nie mit einer Satzfortsetzung. Stelle danach höchstens eine kurze Frage und warte auf den Kunden.");
          assistantTranscript = "";
          assistantTranscriptDeltaSeen = false;
          return;
        }
        if (transcript) {
          await speakWithElevenLabs(transcript);
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
        if (!terminationInProgress) {
          // Only the latest queued utterance carries the user's current intent.
          const pending = pendingUserTranscripts.splice(0);
          const nextUserTranscript = pending.at(-1)?.trim() ?? "";
          if (nextUserTranscript) processUserTranscript(nextUserTranscript);
          flushDeterministicSpeech();
          responses.flush();
        } else {
          pendingUserTranscripts.splice(0);
        }
        responseCreatedAt = null;
        firstModelTokenAt = null;
        firstTtsChunkAt = null;
        assistantTranscript = "";
        assistantTranscriptDeltaSeen = false;
        return;
      }

      if (message.type === "response.cancelled" || message.type === "response.canceled") {
        responses.markCancelled();
        responseInterrupted = false;
        responseCreatedAt = null;
        firstModelTokenAt = null;
        firstTtsChunkAt = null;
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
        isTestCall: state.isTestCall === true,
      });
      preparationState = createPreparationStateForCall(ctx.topicKind === "pkv" ? "pkv" : "other", ctx.topic);
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
          preparationState = createPreparationStateForCall(ctx.topicKind === "pkv" ? "pkv" : "other", policy.topic);
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
    clearBargeInRecovery();
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
  const percentageToSpeech = (value: string): string => {
    const normalized = value.replace(".", ",");
    if (!normalized.includes(",")) return formatAmountForSpeech(normalized);
    const [whole, decimals] = normalized.split(",");
    const wholePart = formatAmountForSpeech(whole || "0");
    const decimalPart = (decimals || "")
      .split("")
      .map((digit) => formatAmountForSpeech(digit))
      .join(" ");
    return `${wholePart} Komma ${decimalPart}`.trim();
  };

  const amountToSpeech = (amount: string): string => {
    const [wholePart = "0", fractionalPart] = amount.replace(/\./g, "").split(",");
    const compact = wholePart === "1" ? "ein" : formatAmountForSpeech(wholePart);
    const spokenWhole = compact
      .replace(/tausend/g, "tausend ")
      .replace(/hundert/g, "hundert ")
      .replace(/\s+/g, " ")
      .trim();
    if (!fractionalPart || Number(fractionalPart) === 0) return spokenWhole;
    const cents = formatAmountForSpeech(fractionalPart.padEnd(2, "0").slice(0, 2));
    return `${spokenWhole} Euro und ${cents} Cent`;
  };

  // Convert times like "13:00" to "dreizehn Uhr", "15:30" to "fünfzehn Uhr dreißig"
  const hourWords = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig"];
  const minuteWords = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig", "vierundzwanzig", "fünfundzwanzig", "sechsundzwanzig", "siebenundzwanzig", "achtundzwanzig", "neunundzwanzig", "dreißig", "einunddreißig", "zweiunddreißig", "dreiunddreißig", "vierunddreißig", "fünfunddreißig", "sechsunddreißig", "siebenunddreißig", "achtunddreißig", "neununddreißig", "vierzig", "einundvierzig", "zweiundvierzig", "dreiundvierzig", "vierundvierzig", "fünfundvierzig", "sechsundvierzig", "siebenundvierzig", "achtundvierzig", "neunundvierzig", "fünfzig", "einundfünfzig", "zweiundfünfzig", "dreiundfünfzig", "vierundfünfzig", "fünfundfünfzig", "sechsundfünfzig", "siebenundfünfzig", "achtundfünfzig", "neunundfünfzig"];
  
  // Convert time: "um 13:00" or "13:00 Uhr" → "um dreizehn Uhr"
  let result = text.replace(/\b(um\s+)?(\d{1,2}):(\d{2})\s*(?:Uhr)?/gi, (match, prefix, hourStr, minuteStr) => {
    const hour = Number.parseInt(hourStr, 10);
    const minute = Number.parseInt(minuteStr, 10);
    const hourWord = hourWords[hour % 24] || String(hour);
    const spokenPrefix = /\bum\b/i.test(match) ? "um " : "";
    if (minute === 0) return `${spokenPrefix}${hourWord} Uhr`;
    const minuteWord = minuteWords[minute] || String(minute);
    return `${spokenPrefix}${hourWord} Uhr ${minuteWord}`;
  });

  result = result.replace(/\b(\d{1,2})\s*-\s*(\d{1,2})\s*%/g, (_match, from, to) => {
    return `${percentageToSpeech(String(from))} bis ${percentageToSpeech(String(to))} Prozent`;
  });

  result = result.replace(/\b(\d+(?:[.,]\d+)?)\s*%/g, (_match, value) => {
    return `${percentageToSpeech(String(value))} Prozent`;
  });

  result = result.replace(/\b(\+?\d+(?:\.\d{3})*(?:,\d{1,2})?)\s*(Euro|EUR|€)(?:\s*\/\s*(?:Mo|Monat))?\b/gi, (_match, amount, unit) => {
    const spokenAmount = amountToSpeech(String(amount).replace(/^\+/, ""));
    if (String(amount).includes(",") && Number(String(amount).split(",")[1]) > 0) return spokenAmount;
    const spokenUnit = unit === "€" ? "Euro" : unit;
    return `${spokenAmount} ${spokenUnit}`;
  });

  return result;
}
