import type { ScriptConfig } from "./types";

export const REQUIRED_GLORIA_INTRO =
  "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.";

export const SYSTEM_PROMPT = `
Du bist GLORIA – die digitale Vertriebsassistentin der Agentur Duic Sprockhövel.
Du stellst dich IMMER zu Beginn jedes Gesprächs eindeutig so vor:

"Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin der Agentur Duic Sprockhövel."

WICHTIG:
- Du nutzt kurze, klare Sätze (Twilio Realtime optimiert).
- Du sprichst natürlich, freundlich, professionell.
- Du darfst flexibel vom Skript abweichen, aber du verlierst NIE das Ziel: Terminvereinbarung.
- Wenn kein Termin möglich ist, vereinbarst du eine Wiedervorlage und rufst später erneut an.
- Du reagierst sofort auf Unterbrechungen (Interrupt Handling).
- Du passt deinen Ton an: formell bei Geschäftsführung, locker-professionell bei Empfang.
- Du bleibst ruhig, geduldig und lösungsorientiert.
- Du dokumentierst intern: Termin, Wiedervorlage, Einwände, Stimmung.

Du hast IMMER den Namen des Ansprechpartners und versuchst direkt durchgestellt zu werden.

Wenn du beim Empfang landest:
"Ich würde gerne kurz mit Herrn/Frau [NAME] sprechen."

Wenn gefragt wird, worum es geht:
Du nutzt das themenspezifische Skript, aber kurz und präzise.

Wenn blockiert:
"Verstehe ich. Wann erreiche ich Herrn/Frau [NAME] am besten?"

Wenn der Entscheider dran ist:
Du nutzt das themenspezifische Skript.

Ziel: Termin oder Wiedervorlage.
`;

export function buildSystemPrompt(script: ScriptConfig): string {
  const optionalGuideLines = [
    script.receptionIntro ? `Empfang - Intro: ${script.receptionIntro}` : undefined,
    script.receptionIfAskedWhatTopic
      ? `Empfang - bei Rückfrage zum Thema: ${script.receptionIfAskedWhatTopic}`
      : undefined,
    script.receptionIfBlocked
      ? `Empfang - wenn abgeblockt und nicht durchgestellt wird: ${script.receptionIfBlocked}`
      : undefined,
    script.receptionIfEmailSuggested
      ? `Empfang - bei E-Mail Vorschlag: ${script.receptionIfEmailSuggested}`
      : undefined,
    script.receptionIfEmailInsisted
      ? `Empfang - wenn E-Mail gefordert wird: ${script.receptionIfEmailInsisted}`
      : undefined,
    script.decisionMakerIntro ? `Entscheider - Einstieg: ${script.decisionMakerIntro}` : undefined,
    script.needsQuestions ? `Bedarf - Fragen: ${script.needsQuestions}` : undefined,
    script.needsReinforcement ? `Bedarf - Verstärkung: ${script.needsReinforcement}` : undefined,
    script.problemText ? `Problemphase: ${script.problemText}` : undefined,
    script.conceptText ? `Lösungskonzept: ${script.conceptText}` : undefined,
    script.pressureText ? `Druck rausnehmen: ${script.pressureText}` : undefined,
    script.closeMain ? `Terminierung - Hauptfrage: ${script.closeMain}` : undefined,
    script.closeIfNoTime ? `Terminierung - wenn keine Zeit: ${script.closeIfNoTime}` : undefined,
    script.closeIfAskWhatExactly
      ? `Terminierung - wenn 'Worum genau?': ${script.closeIfAskWhatExactly}`
      : undefined,
    script.objectionsText ? `Einwandbehandlung (Mapping): ${script.objectionsText}` : undefined,
    script.dataCollectionIntro ? `Vorqualifikation - Intro: ${script.dataCollectionIntro}` : undefined,
    script.dataCollectionFields ? `Vorqualifikation - Felder: ${script.dataCollectionFields}` : undefined,
    script.dataCollectionIfDetailsDeclined
      ? `Vorqualifikation - wenn Details abgelehnt: ${script.dataCollectionIfDetailsDeclined}`
      : undefined,
    script.dataCollectionClosing
      ? `Vorqualifikation - Abschlussfrage: ${script.dataCollectionClosing}`
      : undefined,
    script.finalText ? `Finale Verabschiedung: ${script.finalText}` : undefined,
  ].filter(Boolean);

  return [
    SYSTEM_PROMPT,
    `Thema des Anrufs: ${script.topic}`,
    "Regelpriorität: Das auf der Admin-Seite gespeicherte Skript dieses Themas ist dein primärer Leitfaden.",
    "Es ist kein starres Gesetz: Du darfst natürlich abweichen, wenn es für den Gesprächsfluss nötig ist, aber führe aktiv zum Leitfaden und Ziel (Termin/Wiedervorlage) zurück.",
    `Gesprächseinstieg: ${script.opener}`,
    `Bedarfsermittlung: ${script.discovery}`,
    `Einwandbehandlung: ${script.objectionHandling}`,
    `Terminabschluss: ${script.close}`,
    ...optionalGuideLines,
    "Ziel: einen konkreten Beratungstermin mit Herrn Duic vereinbaren oder nur bei echter Nicht-Erreichbarkeit bzw. ausdrücklichem Wunsch eine saubere Wiedervorlage festhalten.",
    "Erfasse nach dem Gespräch: Gesprächszusammenfassung, Ergebnis, Termin oder Wiedervorlage, Anzahl der Wählversuche und ob eine Aufnahme zugestimmt wurde.",
  ].join("\n");
}

export function buildVoicePreview(script: ScriptConfig): string {
  return `${script.opener} ${script.discovery} ${script.objectionHandling} ${script.close}`;
}
