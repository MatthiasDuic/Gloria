export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type PkvConversationStage =
  | "need_relevance"
  | "need_insurance"
  | "need_contribution"
  | "need_projection"
  | "need_retirement_reflection"
  | "need_interest"
  | "ready_to_schedule";

export type PkvConversationAssessment = {
  stage: PkvConversationStage;
  conceptDelivered: boolean;
  insuranceStatus?: "pkv" | "gkv";
  contributionPhrase?: string;
  projectionDelivered: boolean;
  retirementReflectionAsked: boolean;
  interestConfirmed: boolean;
};

const CONTRIBUTION_PATTERN = /\b(?:\d{1,3}(?:\.\d{3})+|\d{2,5})(?:,\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro\b/i;

/** Extrahiert den numerischen Eurobetrag aus einer Contributionphrase wie "1.234 Euro" oder "achthundert Euro". */
function extractEuroAmount(phrase: string): number | undefined {
  const normalized = phrase
    .replace(/\./g, "")      // Tausenderpunkt entfernen
    .replace(/,\d+/g, "")    // Dezimalstellen entfernen
    .replace(/€/g, "euro");
  const digitMatch = normalized.match(/\d+/);
  if (digitMatch) {
    const value = parseInt(digitMatch[0], 10);
    if (value > 0 && value < 100_000) return value;
  }
  // Wortzahlen abbilden
  const wordMap: Record<string, number> = {
    hundert: 100, zweihundert: 200, dreihundert: 300, vierhundert: 400, fünfhundert: 500,
    sechshundert: 600, siebenhundert: 700, achthundert: 800, neunhundert: 900,
    tausend: 1000, eintausend: 1000, zweitausend: 2000,
  };
  const lower = normalized.toLowerCase();
  for (const [word, value] of Object.entries(wordMap)) {
    if (lower.includes(word)) return value;
  }
  return undefined;
}

/** Rundet auf nächste 5 für natürlichere Sprachausgabe. */
function roundToFive(n: number): number {
  return Math.round(n / 5) * 5;
}

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
  const relevanceAsked = /(?:wie nehmen sie diese entwicklung wahr|wie stark sp[üu]ren sie die entwicklung|gr[öo][ßs]te sorge.*beitr[aä]ge)/i.test(assistantText);
  const conceptDelivered = /(?:beitragsstabilität|bezahlbarkeit im alter|persönliche[sr]? konzept|beitragsentlastung|tarifoptimierung|altersrückstellungen|analysekonzept|analyse-konzept)/i.test(assistantText);
  const projectionDelivered =
    // Gloria hat explizit eine Hochrechnung auf 10 Jahre mit Prozentzahl oder konkretem Endbetrag geliefert.
    (/(?:in\s+zehn\s+jahren|in\s+10\s+jahren|zehn[- ]jahres|10[- ]jahres)/i.test(assistantText)
      && /(?:vier\s+prozent|4\s*%|hochrechn|ungef[aä]hr|etwa|ca\.)/i.test(assistantText))
    // Oder: Gloria hat einen konkreten gerundeten Eurobetrag als Projektion genannt.
    || /(?:k[aä]men\s+Sie|kommen\s+Sie|w[aä]ren\s+das)[^.!?]*(?:\d{3,}|eintausend|zweitausend|dreizehnhundert|vierzehnhundert|f[üu]nfzehnhundert|sechzehnhundert)[^.!?]*euro/i.test(assistantText);
  const retirementReflectionAsked = /(?:ruhestand|rente)[^.?!]*(?:fühlt|fühlen|bedeutet|planung)|(?:fühlt|fühlen|bedeutet|planung)[^.?!]*(?:ruhestand|rente)/i.test(assistantText);
  const interestAnswer = findInterestAnswer(turns);
  // Match anywhere in the answer, not only at start — users rarely begin with bare "ja".
  const interestConfirmed = /\b(?:ja\b|gerne\b|interessant\b|hilfreich\b|das\s+macht\s+sinn|klingt\s+gut|m[oö]chte\s+ich|will\s+ich|w[aä]re\s+gut|gern\s+wissen|sehr\s+gerne)\b/i.test(interestAnswer)
    && !/\b(?:nein|nicht|kein|lieber\s+nicht|eigentlich\s+nicht)\b/i.test(interestAnswer);
  let stage: PkvConversationStage = "ready_to_schedule";
  if (!conceptDelivered) {
    // Concept hasn't been delivered yet — always start from the beginning.
    stage = "need_relevance";
  } else if (!interestConfirmed && retirementReflectionAsked) {
    stage = "need_interest";
  } else if (projectionDelivered && !retirementReflectionAsked) {
    stage = "need_retirement_reflection";
  } else if (contributionPhrase && !projectionDelivered) {
    stage = "need_projection";
  } else if (!relevanceAsked) {
    stage = "need_relevance";
  } else if (!contributionPhrase) {
    stage = "need_contribution";
  } else if (!projectionDelivered) {
    stage = "need_projection";
  } else if (!retirementReflectionAsked) {
    stage = "need_retirement_reflection";
  } else if (!interestConfirmed) {
    stage = "need_interest";
  }

  return {
    stage,
    conceptDelivered,
    insuranceStatus,
    contributionPhrase,
    projectionDelivered,
    retirementReflectionAsked,
    interestConfirmed,
  };
}

export function instructionForPkvStage(assessment: PkvConversationAssessment, contactName?: string): string {
  const anrede = contactName?.trim() ? `${contactName.trim()}, ` : "";
  switch (assessment.stage) {
    case "need_relevance":
      return "Sensibilisiere jetzt kurz und menschlich: Es geht um die Beitragsentwicklung zur Gesundheitsversorgung. Beiträge steigen Jahr für Jahr; nenne vorsichtig den Zahlenanker von etwa drei bis fünf Prozent laut PKV-Verband und erwähne mögliche weitere Anpassungen nur ohne Dramatisierung. Frage danach: 'Wie nehmen Sie diese Entwicklung wahr?' Warte auf die Antwort. Erkläre das Beratungskonzept erst, wenn der Kunde danach fragt.";
    case "need_insurance":
      return "Frage ausschließlich, ob der Kunde aktuell gesetzlich oder privat krankenversichert ist. Keine Terminfrage.";
    case "need_contribution":
      return "Frage ausschließlich nach dem aktuellen monatlichen Krankenversicherungsbeitrag. Keine Terminfrage.";
    case "need_projection": {
      const amount = extractEuroAmount(assessment.contributionPhrase || "");
      let projectionHint = "";
      if (amount) {
        const projected = roundToFive(Math.round(amount * (1.04 ** 10)));
        const delta = roundToFive(projected - amount);
        projectionHint = ` VERBINDLICHE RECHENWERTE (exakt so verwenden, nicht neu berechnen): Heutiger Beitrag: ${amount} Euro. In 10 Jahren bei 4 % p.a.: ca. ${projected} Euro. Mehrbelastung: ca. ${delta} Euro pro Monat.`;
      }
      return `Rechne den genannten Beitrag ${assessment.contributionPhrase || ""} mit rund vier Prozent pro Jahr auf zehn Jahre hoch.${projectionHint} Formuliere das menschlich als Einordnung, nicht als Tabelle: "${anrede}wenn wir von Ihrem heutigen Beitrag ausgehen, kommen Sie in zehn Jahren ungefähr auf [PROJECTED] Euro im Monat. Das wären rund [DELTA] Euro mehr." Setze [PROJECTED] und [DELTA] mit den VERBINDLICHEN RECHENWERTEN aus dieser Anweisung ein. Frage danach: "Haben Sie Ihre Beitragsentwicklung schon einmal auf diese Weise betrachtet?" Keine Terminfrage und keine reine Zahlenaufzählung.`;
    }
    case "need_retirement_reflection":
      return "Frage jetzt ausschließlich: 'Wenn Sie diese Entwicklung bis zum Ruhestand weiterdenken: Wie fühlt sich das für Sie an und was bedeutet das für Ihre Planung?' Warte danach auf die Antwort. Keine Terminfrage.";
    case "need_interest":
      return "Erkläre knapp das persönliche Analysekonzept: Ersttermin zum Kennenlernen, Einordnung der Beitragsentwicklung und mögliche prüfbare Optionen wie Tarifoptimierung, Altersrückstellungen, Beitragsentlastungstarife und mögliche Steuervorteile. Hole danach mit der Frage 'Wäre diese Klarheit für Sie hilfreich?' eine eindeutige Zustimmung ein. Keine Terminfrage und noch keine Terminvorschläge.";
    case "ready_to_schedule":
      return "Die fachlichen Voraussetzungen sind erfüllt. Frage zuerst nur nach Vormittag oder Nachmittag und biete anschließend genau zwei echte freie Slots an verschiedenen Tagen an.";
  }
}