export type ConversationEvent =
  | { type: "clear_rejection"; text: string }
  | { type: "customer_question"; text: string }
  | { type: "objection"; text: string; kind: "no_time" | "existing_advisor" | "send_information" | "skepticism" | "other" }
  | { type: "unclear"; text: string }
  | { type: "answer"; text: string };

export function isUnclearConversationText(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .replace(/[^a-zäöüßı0-9:?!.,\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return true;
  if (/^(?:good to|does that|thank you much|i know|anlıyorum|어\?|aso|gute tag|tag|gutes|ich bin ab|hera|fariha|mhm|hmm|hm+|äh+|uh+|oh+|das)[.!?]*$/i.test(normalized)) return true;
  return normalized.length <= 2 && !/^(?:ja|ne|nein|ok|jo|nö)$/i.test(normalized);
}

export function isConversationEndingText(text: string): boolean {
  return /\b(?:kein[e]?\s+interesse|nicht\s+interessiert|rufen\s+sie|nicht\s+an|anrufen|m[oe]chte\s+(?:kein|keinen)\s+termin|beende\s+(?:das\s+)?gespr[ae]ch|legen\s+sie\s+auf|auf\s+wiedersehen|auf\s+wiederh[öo]ren|tsch[ue]ss|streichen\s+mich|interessiert\s+mich\s+nicht|kommt\s+nicht\s+infrage)\b/i.test(text);
}

function isCustomerQuestion(text: string): boolean {
  if (/\?\s*$/.test(text.trim())) return true;
  return /^\s*(?:wer|wie|was|warum|wieso|weshalb|woher|wann|welche[rmn]?|können\s+sie|könnten\s+sie|ist\s+das|geht\s+es|worum)\b/i.test(text);
}

export function classifyConversationEvent(text: string): ConversationEvent {
  const normalized = text.trim();
  if (isUnclearConversationText(normalized)) return { type: "unclear", text: normalized };
  if (isConversationEndingText(normalized)) return { type: "clear_rejection", text: normalized };
  if (isCustomerQuestion(normalized)) return { type: "customer_question", text: normalized };
  if (/\b(?:keine\s+zeit|gerade\s+schlecht|unpassend|bin\s+in\s+einem\s+termin|muss\s+gleich\s+weg)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "no_time" };
  }
  if (/\b(?:habe\s+(?:schon\s+)?(?:einen|meinen)\s+(?:berater|makler)|mein\s+(?:berater|makler)\s+kümmert|bereits\s+beraten)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "existing_advisor" };
  }
  if (/\b(?:per\s+mail|e-?mail|schicken\s+sie|senden\s+sie|unterlagen\s+zusenden|informationen\s+zusenden)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "send_information" };
  }
  if (/\b(?:glaube\s+ich\s+nicht|klingt(?:\s+für\s+mich)?\s+unrealistisch|bezweifle|sehe\s+den\s+sinn\s+nicht|bringt\s+doch\s+nichts|zu\s+teuer)\b/i.test(normalized)) {
    return { type: "objection", text: normalized, kind: "skepticism" };
  }
  return { type: "answer", text: normalized };
}

export function instructionForConversationEvent(
  event: ConversationEvent,
  resumeInstruction?: string,
): string {
  const resume = resumeInstruction?.trim();
  switch (event.type) {
    case "clear_rejection":
      return "Akzeptiere die klare Ablehnung sofort und ohne Überredungsversuch. Verabschiede dich kurz und hörbar auf Deutsch und rufe danach end_call auf. Stelle keine weitere Frage.";
    case "customer_question":
      return [
        `Beantworte zuerst ausschließlich die konkrete Kundenfrage: "${event.text}". Antworte ehrlich, knapp und ohne erfundene Fakten.`,
        resume ? `Kehre danach nur dann natürlich zurück und beachte als nächsten fachlichen Schritt: ${resume}` : "Stelle danach höchstens eine passende kurze Frage.",
      ].join(" ");
    case "objection":
      return [
        `Reagiere zuerst auf den Einwand "${event.text}". Bestätige die Perspektive knapp, antworte konkret und übe keinen Druck aus.`,
        event.kind === "no_time" ? "Biete keinen langen Pitch an; frage höchstens nach einem passenderen Zeitpunkt." : "Widerlege den Kunden nicht pauschal.",
        resume ? `Wenn der Kunde offen bleibt, beachte anschließend als nächsten fachlichen Schritt: ${resume}` : "Stelle danach höchstens eine passende kurze Frage.",
      ].join(" ");
    case "unclear":
      return "Die letzte Äußerung war akustisch oder inhaltlich unklar. Leite daraus keine Zustimmung, Ablehnung, Terminwahl oder neue Tatsache ab. Frage genau einmal kurz auf Deutsch nach, wie der Kunde es gemeint hat.";
    case "answer":
      return resume || "Antworte direkt und situativ auf die letzte Kundenaussage. Stelle höchstens eine passende kurze Frage.";
  }
}