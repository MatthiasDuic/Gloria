export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type PkvConversationStage =
  | "need_insurance"
  | "need_contribution"
  | "need_projection"
  | "need_retirement_reflection"
  | "need_interest"
  | "ready_to_schedule";

export type PkvConversationAssessment = {
  stage: PkvConversationStage;
  insuranceStatus?: "pkv" | "gkv";
  contributionPhrase?: string;
  projectionDelivered: boolean;
  retirementReflectionAsked: boolean;
  interestConfirmed: boolean;
};

const CONTRIBUTION_PATTERN = /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro)\b/i;

function findInterestAnswer(turns: ConversationTurn[]): string {
  let questionIndex = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (
      turn.role === "assistant"
      && /(?:wäre|ist)\s+(?:diese\s+)?klarheit[^.?!]*(?:hilfreich|sinnvoll)|(?:hilfreich|sinnvoll)[^.?!]*für\s+sie/i.test(turn.text)
    ) {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex < 0) return "";
  return turns.slice(questionIndex + 1).find((turn) => turn.role === "user")?.text.trim() || "";
}

export function assessPkvConversation(turns: ConversationTurn[]): PkvConversationAssessment {
  const userText = turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  const assistantText = turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text).join(" ");
  const insuranceStatus = /\b(?:privat|pkv)\b/i.test(userText)
    ? "pkv"
    : /\b(?:gesetzlich|gkv)\b/i.test(userText)
      ? "gkv"
      : undefined;
  const contributionPhrase = userText.match(CONTRIBUTION_PATTERN)?.[0];
  const projectionDelivered = /(?:in\s+zehn\s+jahren|in\s+10\s+jahren|zehn[- ]jahres|10[- ]jahres)/i.test(assistantText)
    && /(?:vier\s+prozent|4\s*%|hochrechn|ungefähr|etwa)/i.test(assistantText);
  const retirementReflectionAsked = /(?:ruhestand|rente)[^.?!]*(?:fühlt|fühlen|bedeutet|planung)|(?:fühlt|fühlen|bedeutet|planung)[^.?!]*(?:ruhestand|rente)/i.test(assistantText);
  const interestAnswer = findInterestAnswer(turns);
  const interestConfirmed = /^(?:ja\b|gerne\b|interessant\b|hilfreich\b|das\s+macht\s+sinn|klingt\s+gut|möchte\s+ich|will\s+ich)/i.test(interestAnswer);

  let stage: PkvConversationStage = "ready_to_schedule";
  if (!contributionPhrase) stage = insuranceStatus ? "need_contribution" : "need_insurance";
  else if (!projectionDelivered) stage = "need_projection";
  else if (!retirementReflectionAsked) stage = "need_retirement_reflection";
  else if (!interestConfirmed) stage = "need_interest";
  else if (!insuranceStatus) stage = "need_insurance";

  return {
    stage,
    insuranceStatus,
    contributionPhrase,
    projectionDelivered,
    retirementReflectionAsked,
    interestConfirmed,
  };
}

export function instructionForPkvStage(assessment: PkvConversationAssessment): string {
  switch (assessment.stage) {
    case "need_insurance":
      return "Frage ausschließlich, ob der Kunde aktuell gesetzlich oder privat krankenversichert ist. Keine Terminfrage.";
    case "need_contribution":
      return "Frage ausschließlich nach dem aktuellen monatlichen Krankenversicherungsbeitrag. Keine Terminfrage.";
    case "need_projection":
      return `Rechne jetzt ausschließlich den genannten Monatsbeitrag ${assessment.contributionPhrase || ""} mit rund vier Prozent pro Jahr hoch. Nenne heutigen Betrag, Betrag in zehn Jahren und monatlichen Unterschied. Keine Terminfrage.`;
    case "need_retirement_reflection":
      return "Frage jetzt ausschließlich: 'Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?' Warte danach auf die Antwort. Keine Terminfrage.";
    case "need_interest":
      return "Erkläre knapp den persönlichen Nutzen und mögliche prüfbare Optionen. Hole danach mit der Frage 'Wäre diese Klarheit für Sie hilfreich?' eine eindeutige Zustimmung ein. Keine Terminfrage und noch keine Terminvorschläge.";
    case "ready_to_schedule":
      return "Die fachlichen Voraussetzungen sind erfüllt. Frage zuerst nur nach Vormittag oder Nachmittag und biete anschließend genau zwei echte freie Slots an verschiedenen Tagen an.";
  }
}