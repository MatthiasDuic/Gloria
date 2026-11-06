import { parseGermanEuroAmount } from "./german-number.js";

export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type PkvConversationStage = "need_relevance" | "need_contribution" | "need_projection" | "need_concept" | "need_interest" | "ready_to_schedule";
export type PkvConversationAssessment = { stage: PkvConversationStage; contributionPhrase?: string; projectionDelivered: boolean; conceptDelivered: boolean; interestConfirmed: boolean };

const CONTRIBUTION_PATTERN = /\b(?:(?:ca\.?|circa|rund|etwa|knapp)\s*)?(?:(?:\d{1,3}(?:\.\d{3})+|\d{2,5})(?:,\d{1,2})?|(?:[a-zäöüß-]*tausend[a-zäöüß-]*(?:\s+[a-zäöüß-]*hundert[a-zäöüß-]*)?|[a-zäöüß-]*hundert[a-zäöüß-]*)(?:\s+[a-zäöüß-]+){0,2})\s*(?:euro|€)\b/i;

function roundToFive(n: number): number {
  return Math.round(n / 5) * 5;
}

export function buildTenYearProjectionSentence(contributionPhrase?: string): string {
  if (!contributionPhrase) return "Bei einer beispielhaften Steigerung von rund vier Prozent pro Jahr wäre ein Beitrag in zehn Jahren etwa eineinhalbmal so hoch wie heute.";

  const amount = parseGermanEuroAmount(contributionPhrase);
  if (!amount) return "Bei einer beispielhaften Steigerung von rund vier Prozent pro Jahr wäre ein Beitrag in zehn Jahren etwa eineinhalbmal so hoch wie heute.";

  const futureAmount = roundToFive(Math.round(amount * (1.04 ** 10)));
  const increase = roundToFive(futureAmount - amount);
  return `Wenn wir beispielhaft mit rund vier Prozent Steigerung pro Jahr rechnen, wären das in zehn Jahren rund ${increase} Euro mehr pro Monat. Ihr Beitrag läge dann bei etwa ${futureAmount} Euro monatlich.`;
}

export function extractContributionPhrase(userText: string): string | undefined {
  const matches = Array.from(userText.matchAll(new RegExp(CONTRIBUTION_PATTERN.source, "gi")));
  return matches.at(-1)?.[0]?.trim();
}

export function extractCurrentContributionPhrase(turns: ConversationTurn[]): string | undefined {
  let currentContributionQuestion = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (
      turns[index].role === "assistant"
      && /welchen beitrag zahlen sie heute|aktuellen?\s+(?:monatlichen\s+)?(?:monats)?beitrag|heutigen?\s+beitrag|welchen\s+monatlichen\s+beitrag|wie\s+(?:viel|hoch).*(?:derzeit|aktuell|heute|im\s+monat).*(?:gesundheitsversorgung|beitrag)|wie\s+hoch.*monatsbeitrag/i.test(turns[index].text)
    ) {
      currentContributionQuestion = index;
      break;
    }
  }

  if (currentContributionQuestion < 0) {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      if (turn.role !== "user" || !/\b(?:aktuell|heute|derzeit)\b/i.test(turn.text)) continue;
      const explicitlyCurrentContribution = extractContributionPhrase(turn.text);
      if (explicitlyCurrentContribution) return explicitlyCurrentContribution;
    }
    return undefined;
  }
  const userTurns = turns.filter((turn, index) => turn.role === "user" && (currentContributionQuestion < 0 || index > currentContributionQuestion));
  const explicitContribution = extractContributionPhrase(userTurns.map((turn) => turn.text).join(" "));
  if (explicitContribution) return explicitContribution;

  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const standaloneAmount = userTurns[index].text.trim().match(/^(?:ca\.?\s*|circa\s*|rund\s*|etwa\s*)?(\d{2,5}|\d{1,3}(?:\.\d{3})+)[.,]?\s*$/i)?.[1];
    if (standaloneAmount) return `${standaloneAmount} Euro`;
  }
  return undefined;
}

export function assessPkvConversation(turns: ConversationTurn[]): PkvConversationAssessment {
  const userText = turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const assistantText = turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text).join(" ");
  if (!turns.length || !userText.trim()) {
    return { stage: "need_relevance", contributionPhrase: undefined, projectionDelivered: false, conceptDelivered: false, interestConfirmed: false };
  }
  const contributionPhrase = extractCurrentContributionPhrase(turns);
  const projectionDelivered = /(?:zehn\s+jahren|10\s+jahren|hochrechn|mehrbetrag)/i.test(assistantText);
  const conceptDelivered = /(?:herr\s+duic|altersrückstell|beitragsentlast|bis\s+zum\s+ruhestand|f[üu]r\s+ihre\s+planung)/i.test(assistantText);

  let interestConfirmed = false;
  for (let index = 1; index < turns.length; index += 1) {
    const current = turns[index];
    const previous = turns[index - 1];
    if (current.role !== "user" || previous.role !== "assistant") continue;
    const affirmative = /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut|hilfreich|sinnvoll|passt)\b/i.test(current.text);
    const conceptPrompt = /(?:interessant|termin|klingt|konzept|hilfreich|klarheit|sinnvoll|zusammen\s+im\s+detail)/i.test(previous.text);
    if (affirmative && conceptPrompt) {
      interestConfirmed = true;
      break;
    }
  }

  const schedulingReady = interestConfirmed && projectionDelivered && conceptDelivered;
  const stage: PkvConversationStage = schedulingReady ? "ready_to_schedule"
    : projectionDelivered && conceptDelivered ? "need_interest"
    : projectionDelivered ? "need_concept"
    : contributionPhrase ? "need_projection"
    : extractContributionPhrase(userText) || /beitrag|entwicklung|versichert|gesundheitsversorgung/i.test(userText) ? "need_contribution" : "need_relevance";
  return { stage, contributionPhrase, projectionDelivered, conceptDelivered, interestConfirmed: schedulingReady };
}
