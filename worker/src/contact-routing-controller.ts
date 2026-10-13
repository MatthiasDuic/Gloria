import { classifyInboundSpeech } from "./call-classification.js";

export type ContactRoutingStage =
  | "awaiting_contact"
  | "confirming_decision_maker"
  | "gatekeeper"
  | "waiting_for_transfer"
  | "decision_maker"
  | "voicemail";

export type ContactRoutingState = {
  stage: ContactRoutingStage;
  targetName?: string;
  gatekeeperRequestMade?: boolean;
};

function targetNameTokens(targetName?: string): string[] {
  return (targetName || "")
    .toLowerCase()
    .replace(/[^a-zäöüß\s-]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(?:herr|frau|dr|prof)$/.test(token));
}

function identifiesDecisionMaker(text: string, targetName?: string): boolean {
  const normalized = text.toLowerCase();
  if (/\b(?:stelle\s+sie\s+zu|stellen\s+sie\s+zu|verbinde\s+sie|verbinde|durchstellen|weiterleiten|weiterleite|schalte\s+weiter|durchstellen\s+zu)\b/i.test(normalized)) {
    return false;
  }
  if (/\b(?:das bin ich|ich bin es|ich bin selbst|selbst am apparat|sprechen sie mit mir|ich bin zuständig|ich bin der verantwortliche|ich bin der entscheidungsträger)\b/i.test(normalized)) {
    return true;
  }

  const targetTokens = targetNameTokens(targetName);
  if (targetTokens.length === 0) return false;
  const escapedName = targetTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const nameRegex = new RegExp(
    `(?:` +
      `\\bmein(?:e)?\\s+name\\s+ist\\s+${escapedName}\\b|` +
      `\\bhier\\s+ist\\s+(?:herr|frau)?\\s*${escapedName}\\b|` +
      `\\b(?:herr|frau)?\\s*${escapedName}\\s+am\\s+apparat\\b|` +
      `\\bich\\s+bin\\s+(?:herr|frau)?\\s*${escapedName}\\b` +
      `)`,
    "i",
  );

  return nameRegex.test(normalized);
}

function isClearlyGatekeeper(text: string, targetName?: string): boolean {
  const normalized = text.toLowerCase();
  const targetTokens = targetNameTokens(targetName);
  const mentionsUnavailableTarget = targetTokens.length > 0
    && new RegExp(
      `\\b${targetTokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")}\\b[\\s\\S]{0,40}\\b(?:nicht\\s+da|nicht\\s+erreichbar|abwesend|außer\\s+haus|im\\s+termin|gerade\\s+nicht)\\b`,
      "i",
    ).test(normalized);

  return mentionsUnavailableTarget
    || /\b(?:stelle\s+sie\s+zu|stellen\s+sie\s+zu|verbinde\s+sie|ich\s+verbinde|durchstellen|weiterleiten|weiterleite|schalte\s+weiter)\b/i.test(normalized)
    || /\b(?:zentrale|empfang|assistenz|sekretariat|rezeption|telefonzentrale)\b/i.test(normalized)
    || /\b(?:gmbh|ag|kg|ug|ohg)\b.{0,60}\b(?:mein(?:e)?\s+name|hier\s+ist)\b/i.test(text);
}

function confirmsDecisionMaker(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (/\b(?:nein|falsch|nicht\s+(?:der|die|das)|ich\s+verbinde|ich\s+stelle|weiterleiten|durchstellen)\b/i.test(normalized)) {
    return false;
  }
  return /^(?:ja|genau|richtig|am\s+apparat|hier|das\s+bin\s+ich|ich\s+bin\s+(?:es|das)|spreche[n]?\s+sie\s+mit\s+mir|korrekt)[.!?,\s]*$/i.test(normalized)
    || /\b(?:ja|genau|richtig|das\s+bin\s+ich|ich\s+bin\s+(?:es|das)|am\s+apparat)\b/i.test(normalized);
}

export function createContactRoutingState(targetName?: string): ContactRoutingState {
  return { stage: "awaiting_contact", targetName: targetName?.trim() || undefined };
}

export function advanceContactRouting(
  state: ContactRoutingState,
  userText: string,
): ContactRoutingState {
  if (state.stage === "decision_maker" || state.stage === "voicemail") return state;

  const classification = classifyInboundSpeech(userText);
  if (classification === "voicemail") return { ...state, stage: "voicemail" };
  if (classification === "queue") return { ...state, stage: "waiting_for_transfer" };
  if (state.stage === "confirming_decision_maker") {
    return confirmsDecisionMaker(userText)
      ? { ...state, stage: "decision_maker" }
      : { ...state, stage: "gatekeeper" };
  }
  if (identifiesDecisionMaker(userText, state.targetName)) {
    return { ...state, stage: "decision_maker" };
  }
  if (classification === "human") {
    return {
      ...state,
      stage: isClearlyGatekeeper(userText, state.targetName) ? "gatekeeper" : "confirming_decision_maker",
    };
  }
  return state;
}

export function instructionForContactRouting(state: ContactRoutingState): string {
  switch (state.stage) {
    case "awaiting_contact":
      return state.targetName
        ? `Stelle dich kurz transparent vor und frage ausschließlich nach ${state.targetName}. Noch kein Fachgespräch.`
        : "Stelle dich kurz transparent vor und frage ausschließlich nach der zuständigen Person. Noch kein Fachgespräch.";
    case "confirming_decision_maker":
      return state.targetName
        ? `Die Person könnte ${state.targetName} sein, aber die Namenszuordnung ist nicht sicher. Frage genau einmal höflich, ob du ${state.targetName} am Apparat hast. Bei Zustimmung beginne mit der regulären Eröffnung. Bei Nein oder unklarer Antwort bitte höflich um Weiterleitung. Noch kein Fachgespräch.`
        : "Die Zuständigkeit ist nicht sicher. Frage genau einmal höflich, ob du die zuständige Ansprechperson am Apparat hast. Bei Zustimmung beginne mit der regulären Eröffnung, sonst bitte höflich um Weiterleitung. Noch kein Fachgespräch.";
    case "gatekeeper":
      return state.targetName
        ? state.gatekeeperRequestMade
          ? `Du hast bereits um die Verbindung mit ${state.targetName} gebeten. Wiederhole die Bitte nicht wortgleich und starte kein Fachgespräch. Reagiere kurz auf die konkrete Antwort. Wenn die Person nicht verbinden kann, verabschiede dich höflich und beende das Gespräch.`
          : `Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich freundlich um die Verbindung mit ${state.targetName}. Wenn nach dem Grund gefragt wird, nenne nur die kurze thematische Einordnung. Noch kein PKV-Fachgespräch.`
        : "Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich um die Verbindung mit der zuständigen Person. Noch kein Fachgespräch.";
    case "waiting_for_transfer":
      return "Es läuft eine Weiterleitung oder Warteschleife. Sprich nicht und starte kein Fachgespräch. Warte auf die nächste menschliche Äußerung.";
    case "decision_maker":
      return "Der Entscheider ist bestätigt. Fahre mit dem fachlichen Gespräch fort.";
    case "voicemail":
      return "Eine Mailbox wurde erkannt. Starte kein Fachgespräch und vereinbare keinen Termin.";
  }
}