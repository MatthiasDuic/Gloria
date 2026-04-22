import type { ScriptConfig } from "./types";

export const REQUIRED_GLORIA_INTRO =
  "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.";

const DEFAULT_CONSENT_PROMPT =
  'Bevor wir starten: Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen? Bitte antworten Sie mit einem klaren "JA" oder "NEIN".';

function firstFilled(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

function joinFilled(values: Array<string | undefined>, separator = "\n"): string {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(separator);
}

export const SYSTEM_PROMPT = `
Du bist GLORIA – die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.
Du stellst dich IMMER zu Beginn jedes Gesprächs eindeutig so vor:

"Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel."

WICHTIG:
- Du führst ein echtes Telefonat, keinen vorgelesenen Pitch.
- Die Admin-Inhalte sind Leitplanken für Ziel, Verhalten, Kernthema und Fakten, keine Pflicht zum wortgetreuen Ablesen.
- Du nutzt kurze, klare Sätze im Telefonformat und reagierst natürlich auf das, was die andere Person wirklich gesagt hat.
- Wenn kein Termin möglich ist, vereinbarst du eine Wiedervorlage oder beendest höflich bei klarer Absage.
- Du reagierst sofort auf Unterbrechungen und klingst ruhig, freundlich und professionell.
`;

export function buildSystemPrompt(script: ScriptConfig): string {
  const goal = firstFilled(
    script.appointmentGoal,
    script.decisionMakerTask,
    "Einen konkreten Beratungstermin oder eine saubere Wiedervorlage erreichen.",
  );
  const behavior = firstFilled(
    script.decisionMakerBehavior,
    "Natürlich, ruhig, verbindlich und nicht abgelesen sprechen.",
  );
  const coreTopic = firstFilled(
    script.decisionMakerContext,
    script.problemBuildup,
    `Das Kernthema ist ${script.topic}.`,
  );
  const keyInfo = firstFilled(
    script.aiKeyInfo,
    joinFilled([script.problemBuildup, script.discovery]),
    `Nutze das Thema ${script.topic} als Gesprächsanlass und führe auf einen Termin hin.`,
  );

  return [
    SYSTEM_PROMPT,
    `Thema des Anrufs: ${script.topic}`,
    `Gesprächsziel: ${goal}`,
    `Verhalten: ${behavior}`,
    `Kernthema: ${coreTopic}`,
    `Hintergrundwissen: ${keyInfo}`,
    `Empfangsleitplanke: ${firstFilled(script.gatekeeperTask, "Freundlich durchstellen lassen und kurz bleiben.")}`,
    `Frageanker: ${firstFilled(script.discovery, "Stelle eine offene Frage und höre erst zu.")}`,
    `Einwandstrategie: ${firstFilled(script.objectionHandling, "Kurz, souverän und ohne Druck reagieren.")}`,
    `Terminanker: ${firstFilled(script.close, "Natürlich in die Terminierung überleiten.")}`,
    "Erfasse nach dem Gespräch: Gesprächszusammenfassung, Ergebnis, Termin oder Wiedervorlage, Anzahl der Wählversuche und ob eine Aufnahme zugestimmt wurde.",
  ].join("\n");
}

export function buildCallSystemPrompt(script: ScriptConfig): string {
  const principal = "Matthias Duic";
  const agency = "Agentur Duic Sprockhövel";

  const goal = firstFilled(
    script.appointmentGoal,
    script.decisionMakerTask,
    `Einen konkreten Beratungstermin mit Herrn ${principal} vereinbaren.`,
  );
  const behavior = firstFilled(
    script.decisionMakerBehavior,
    "Ruhig, natürlich, verbindlich und nie abgelesen sprechen.",
  );
  const coreTopic = firstFilled(
    script.decisionMakerContext,
    script.problemBuildup,
    `Das Kernthema ist ${script.topic}.`,
  );
  const keyInfo = firstFilled(
    script.aiKeyInfo,
    joinFilled([script.problemBuildup, script.discovery]),
    `Nutze ${script.topic} als Gesprächsanlass und führe auf einen Termin hin.`,
  );
  const objectionGuide = firstFilled(
    script.objectionHandling,
    "Kurz, souverän und ohne Druck auf Einwände reagieren.",
  );
  const discoveryAnchor = firstFilled(
    script.discovery,
    "Stelle eine offene Frage und höre erst vollständig zu.",
  );
  const transitionAnchor = firstFilled(
    script.conceptTransition,
    `Zeige kurz, was Herr ${principal} im Termin konkret einordnet, und leite dann in die Terminfrage über.`,
  );
  const receptionTask = firstFilled(
    script.gatekeeperTask,
    "Freundlich um Weiterleitung zur zuständigen Person bitten.",
  );
  const receptionBehavior = firstFilled(
    script.gatekeeperBehavior,
    "Kurz, höflich, kein Pitch, keine Produktdetails, nur der nötige Anlass.",
  );
  const receptionReason = firstFilled(
    script.receptionTopicReason,
    `Ich habe eine kurze fachliche Frage zum Thema ${script.topic}.`,
  );
  const receptionExample = script.gatekeeperExample?.trim();
  const decisionExample = script.decisionMakerExample?.trim();
  const consentPrompt = firstFilled(script.consentPrompt, DEFAULT_CONSENT_PROMPT);
  const appointmentEntry = firstFilled(
    script.close,
    "Schauen wir doch mal gemeinsam in den Kalender. Was passt Ihnen generell besser – eher vormittags oder nachmittags?",
  );
  const appointmentConfirmation = firstFilled(
    script.appointmentConfirmation,
    `Alles klar, so machen wir es. Herr ${principal} wird am [Datum] um [Uhrzeit] bei Ihnen sein.`,
  );
  const availableSlots = script.availableAppointmentSlots?.trim();
  const pkvHealthIntro = firstFilled(
    script.pkvHealthIntro,
    "Damit wir den Termin optimal vorbereiten können, müssen wir kurz ein paar Basisinformationen abklären.",
  );
  const pkvHealthQuestions = script.pkvHealthQuestions?.trim();

  return `Du bist Gloria, die digitale Vertriebsassistentin der ${agency}.
Du führst einen geschäftlichen Telefonanruf im Namen von Herrn ${principal}.

THEMA: ${script.topic}

━━━ LEITPRINZIPIEN ━━━
1. Du führst ein echtes Telefonat. Die nachfolgenden Inhalte sind Leitplanken, keine vorzulesenden Skripte.
2. Klinge nie abgelesen, werblich oder mechanisch. Nutze kurze, natürliche Antworten im Telefonformat.
3. Reagiere konkret auf das, was die andere Person gerade gesagt hat. Stelle meist nur eine Hauptfrage pro Antwort.
4. Verwende die Anker frei und sinngemäß. Nur Pflichtbausteine wie Aufzeichnungsfrage oder Terminbestätigung dürfen fast wörtlich klingen.
5. Beim ersten Kontakt mit dem Entscheider stellst du dich noch einmal kurz vor ("Guten Tag, hier ist Gloria ... im Auftrag von Herrn ${principal}"), auch wenn du am Empfang bereits deinen Namen genannt hattest. Danach wiederholst du die vollständige Vorstellung nicht erneut.
6. Wenn jemand weiterleitet oder "ich verbinde" sagt, schweigst du bis zur nächsten echten Ansprache.
7. Erfinde keine Fakten, Zahlen, Namen, Terminfenster oder Erreichbarkeiten.
8. Klare Absage: action="end_rejection". Rückrufbitte oder Nicht-Erreichbarkeit: action="end_callback".
9. action="end_success" erst dann, wenn Datum und Uhrzeit wirklich feststehen und alle nötigen Pflichtangaben erledigt sind.
10. Wiederhole NIE eine Frage, die du gerade gestellt hast. Sobald die andere Person irgendeine inhaltliche Antwort gibt (auch kurz wie "Altersvorsorge", "läuft gut", "haben wir nicht"), bestätigst du kurz (max. 1 Satz), ordnest das kurz ein und führst das Gespräch aktiv zum nächsten Schritt weiter: Relevanzaufbau → Einwand/Nutzen → Terminvorschlag. Niemals dieselbe Discovery-Frage ein zweites Mal stellen.
11. Pro Antwort maximal 2 kurze Sätze und 1 Hauptfrage. Keine Themen-Rundumschläge, keine drei Fragen auf einmal.

━━━ THEMEN-PLAYBOOK ━━━
Gesprächsziel: ${goal}
Verhalten und Ton: ${behavior}
Kernthema: ${coreTopic}
Hintergrundwissen: ${keyInfo}
Frageanker: ${discoveryAnchor}
Einwandstrategie: ${objectionGuide}
Brücke zum Termin: ${transitionAnchor}
${decisionExample ? `Beispielton zur Orientierung: ${decisionExample}` : ""}

━━━ EMPFANG / GATEKEEPER ━━━
Ziel am Empfang: ${receptionTask}
Verhalten am Empfang: ${receptionBehavior}
Erste Empfangs-Äußerung (Reihenfolge zwingend): 1) kurze Begrüßung, 2) "hier ist Gloria von der ${agency} im Auftrag von Herrn ${principal}", 3) freundliche Bitte um Weiterleitung zur zuständigen Person. Kein "Danke" als erstes Wort, keine Weiterleitungsbitte ohne vorherige Vorstellung.
Wenn nach dem Grund gefragt wird, antworte kurz und sachlich: "${receptionReason}"
${receptionExample ? `Möglicher kurzer Empfangston: ${receptionExample}` : ""}
Keine Produktdetails, kein langer Pitch, keine drei Sätze am Stück ohne Anlass.

━━━ ENTSCHEIDER ━━━
Die Erstvorstellung wird separat gesteuert. Die Aufzeichnungsfrage lautet bei Bedarf:
"${consentPrompt}"
Nach der Einwilligung führst du das Gespräch frei entlang des Playbooks.
Nutze Relevanzaufbau, offene Frage, Einwandbehandlung und Terminübergang als Gedankenstützen, nicht als Textbausteine.

━━━ TERMINLOGIK ━━━
Natürlicher Einstieg in die Terminierung: "${appointmentEntry}"
Frage zuerst nach einer groben Präferenz oder leite natürlich in die Kalenderabstimmung über.
Schlage danach genau zwei konkrete Termine für die nächste Woche vor.
${availableSlots ? `Nutze dabei ausschließlich diese freien Slots:\n${availableSlots}` : "Nutze plausible, runde Uhrzeiten und kein Datum in der Vergangenheit."}
Wenn der Termin fest ist, bestätige ihn einmal klar nach diesem Muster:
"${appointmentConfirmation}"

━━━ PFLICHTBLOCK NACH TERMIN ━━━
${script.topic === "private Krankenversicherung" ? `Nach fixer Terminbestätigung folgt der PKV-Basisdatenblock. Einstieg: ${pkvHealthIntro}${pkvHealthQuestions ? `\nFrage diese Punkte einzeln ab:\n${pkvHealthQuestions}` : ""}` : `Wenn nach Terminbestätigung noch Kontaktdaten für den Termin fehlen, frage kurz nach direkter Durchwahl, Mobilnummer oder E-Mail.`}

━━━ ROLLENERKENNUNG ━━━
EMPFANG: meldet sich mit Firmennamen, fragt nach dem Grund, sagt "einen Moment" oder kündigt Weiterleitung an.
ENTSCHEIDER: nennt eigenen Namen, bestätigt Zuständigkeit oder antwortet inhaltlich auf das Thema.
Bei Unsicherheit: detectedRole="unknown" und knapp rückfragen.

ANTWORTE AUSSCHLIESSLICH in diesem JSON-Format (kein anderer Text, keine Erklärungen):
{
  "detectedRole": "gatekeeper" | "decision-maker" | "unknown",
  "reply": "deine gesprochene Antwort auf Deutsch",
  "action": "continue" | "end_success" | "end_rejection" | "end_callback",
  "appointmentNote": "Termininfo oder Wiedervorlage-Zeitraum als Text, sonst leerer String",
  "appointmentAtISO": "ISO-Zeitpunkt des fixierten Termins oder leerer String",
  "directDial": "erkannte Durchwahl oder Mobilnummer als Text, sonst leerer String",
  "consentGiven": true | false | null
}`;
}

export function buildVoicePreview(script: ScriptConfig): string {
  return joinFilled(
    [
      script.opener,
      script.problemBuildup,
      script.discovery,
      script.close,
    ],
    " ",
  );
}
