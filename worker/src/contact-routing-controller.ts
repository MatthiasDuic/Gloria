import { classifyInboundSpeech } from "./call-classification.js";

export type ContactRoutingStage =
  | "awaiting_contact"
  | "gatekeeper"
  | "waiting_for_transfer"
  | "decision_maker"
  | "voicemail";

export type ContactRoutingState = {
  stage: ContactRoutingStage;
  targetName?: string;
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
      `\\b(?:ich\\s+bin\\s+)?(?:herr|frau)?\\s*${escapedName}\\b|` +
      `\\bmit\\s+(?:herr|frau)?\\s*${escapedName}\\b` +
      `)`,
    "i",
  );

  return nameRegex.test(normalized);
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
  if (identifiesDecisionMaker(userText, state.targetName)) {
    return { ...state, stage: "decision_maker" };
  }
  if (classification === "human") return { ...state, stage: "gatekeeper" };
  return state;
}

export function instructionForContactRouting(state: ContactRoutingState): string {
  switch (state.stage) {
    case "awaiting_contact":
      return state.targetName
        ? `Stelle dich kurz transparent vor und frage ausschließlich nach ${state.targetName}. Noch kein Fachgespräch.`
        : "Stelle dich kurz transparent vor und frage ausschließlich nach der zuständigen Person. Noch kein Fachgespräch.";
    case "gatekeeper":
      return state.targetName
        ? `Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich freundlich um die Verbindung mit ${state.targetName}. Wenn nach dem Grund gefragt wird, nenne nur die kurze thematische Einordnung. Noch kein PKV-Fachgespräch.`
        : "Die sprechende Person ist noch nicht als Entscheider bestätigt. Bitte ausschließlich um die Verbindung mit der zuständigen Person. Noch kein Fachgespräch.";
    case "waiting_for_transfer":
      return "Es läuft eine Weiterleitung oder Warteschleife. Sprich nicht und starte kein Fachgespräch. Warte auf die nächste menschliche Äußerung.";
    case "decision_maker":
      return "Der Entscheider ist bestätigt. Fahre mit dem fachlichen Gespräch fort.";
    case "voicemail":
      return "Eine Mailbox wurde erkannt. Starte kein Fachgespräch und vereinbare keinen Termin.";
  }
}