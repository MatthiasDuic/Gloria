export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

export type PkvConversationStage =
  | "need_relevance"       // Step 3: 2-3 Sätze Beitragsentwicklung + Relevanzfrage
  | "need_contribution"    // Step 4: Nach aktuellem Beitrag fragen, Hochrechnung anbieten
  | "need_projection"      // Step 5: Hochrechnung vorstellen + Ruhestandsgedanke
  | "need_concept"         // Step 7: Konzept erklären + "Klingt das interessant?"
  | "need_interest"        // Warte auf klares Ja zur Terminvereinbarung
  | "ready_to_schedule";

export type PkvConversationAssessment = {
  stage: PkvConversationStage;
  contributionPhrase?: string;
  projectionDelivered: boolean;
  conceptDelivered: boolean;
  interestConfirmed: boolean;
};

const CONTRIBUTION_PATTERN = /\b(?:ca\.?|circa|rund|etwa)?\s*(?:\d{1,3}(?:\.\d{3})+|\d{2,5})(?:,\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|eintausend|zweitausend|dreizehnhundert|vierzehnhundert|fünfzehnhundert|sechzehnhundert|siebzehnhundert|achtzehnhundert|neunzehnhundert)[a-zäöüß-]*\s+euro\b/i;

function extractEuroAmount(phrase: string): number | undefined {
  const normalized = phrase
    .replace(/\./g, "")
    .replace(/,\d+/g, "")
    .replace(/€/g, "euro");
  const digitMatch = normalized.match(/\d+/);
  if (digitMatch) {
    const value = parseInt(digitMatch[0], 10);
    if (value > 0 && value < 100_000) return value;
  }
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

function roundToFive(n: number): number {
  return Math.round(n / 5) * 5;
}

function findInterestAnswer(turns: ConversationTurn[]): string {
  const interestQuestionPatterns = [
    /klingt\s+das\s+(?:interessant|spannend|sinnvoll)/i,
    /(?:wäre|ist)\s+das\s+(?:interessant|hilfreich|sinnvoll)/i,
    /möchten\s+sie\s+(?:das|mehr|einen\s+termin)/i,
    /(?:hilfreich|sinnvoll)\s+für\s+sie/i,
  ];
  let questionIndex = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === "assistant" && interestQuestionPatterns.some(p => p.test(turn.text))) {
      questionIndex = i;
      break;
    }
  }
  if (questionIndex < 0) return "";
  return turns.slice(questionIndex + 1).find(t => t.role === "user")?.text.trim() || "";
}

export function assessPkvConversation(turns: ConversationTurn[]): PkvConversationAssessment {
  const userText = turns.filter(t => t.role === "user").map(t => t.text).join(" ");
  const assistantText = turns.filter(t => t.role === "assistant").map(t => t.text).join(" ");

  const contributionPhrase = userText.match(CONTRIBUTION_PATTERN)?.[0];

  // Broad detection: did Gloria mention anything about rising PKV costs?
  const relevanceAsked = /(?:merken\s+sie|sp[uü]ren\s+sie|wie\s+wirkt|wie\s+nehmen\s+sie|wie\s+erleben|pkv-verband|drei\s+bis\s+f[uü]nf|beitrag.*steig|steig.*beitrag|beitragsanpass|krankenversicherung.*steig|steig.*krankenversicherung|jedes\s+jahr.*beitrag|beitrag.*jedes\s+jahr)/i.test(assistantText);

  // Stage advances if user has responded to the relevance topic (any meaningful user text after Gloria's relevance question)
  const userTurns = turns.filter(t => t.role === "user");
  const assistantTurns = turns.filter(t => t.role === "assistant");
  const relevanceAddressed = relevanceAsked && userTurns.length >= 1 && assistantTurns.length >= 1;

  // Gloria hat konkrete Hochrechnung geliefert
  const projectionDelivered =
    (/(?:in\s*(?:zehn|10)\s*jahren|10[-\s]jahres|zehn[-\s]jahres)/i.test(assistantText) && /(?:euro|€|\d{3,})/i.test(assistantText))
    || /(?:k[aä]men\s+Sie|kommen\s+Sie|w[aä]ren\s+das|w[äa]re\s+das)[^.!?]*(?:\d{3,}|eintausend|zweitausend)[^.!?]*euro/i.test(assistantText)
    || /(?:hochrechn|prognos|beitrag.*steig.*rente|mehrbetrag|mehrbelastung)/i.test(assistantText);

  // Gloria hat Konzept erklärt (Herr Duic / Analyse / Altersrückstellungen)
  const conceptDelivered =
    /(?:herr\s+duic[^.!?]*(?:schaut|zeigt|analysiert|rechnet|erklär)|altersrückstell|beitragsentlastung|tarifoptimierung|stellschrauben.*beitrag|beitrag.*senken|steuervorteile.*krankenversicherung)/i.test(assistantText);

  // Klares Ja des Kunden nach Konzept/Interesse-Frage
  const interestAnswer = findInterestAnswer(turns);
  const interestConfirmed = interestAnswer.length > 0
    && /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut|das\s+macht\s+sinn|m[oö]chte|will\s+ich|sehr\s+gerne|sicher|natürlich)\b/i.test(interestAnswer)
    && !/\b(?:nein|nicht|kein|lieber\s+nicht|eigentlich\s+nicht|eher\s+nicht)\b/i.test(interestAnswer);

  // Sequentielle Stages — vorwärts, kein Reset
  let stage: PkvConversationStage;
  if (interestConfirmed) {
    stage = "ready_to_schedule";
  } else if (conceptDelivered) {
    stage = "need_interest";
  } else if (projectionDelivered) {
    stage = "need_concept";
  } else if (contributionPhrase) {
    stage = "need_projection";
  } else if (relevanceAddressed) {
    // User has responded to the relevance topic — move to asking for current Beitrag
    stage = "need_contribution";
  } else {
    stage = "need_relevance";
  }

  return { stage, contributionPhrase, projectionDelivered, conceptDelivered, interestConfirmed };
}

export function instructionForPkvStage(assessment: PkvConversationAssessment, contactName?: string): string {
  const anrede = contactName?.trim() ? `${contactName.trim()}, ` : "";

  switch (assessment.stage) {
    case "need_relevance":
      return (
        "SCHRITT 3 – RELEVANZ: Erwähne in ein bis zwei Sätzen, dass PKV-Beiträge jährlich steigen und langfristig eine Herausforderung werden können. " +
        "Stelle dann GENAU EINE kurze Frage wie: 'Merken Sie das auch bei Ihrem Beitrag?' oder 'Wie erleben Sie das?' " +
        "Warte auf die Antwort. Sprich NICHT wörtlich das Skript nach — formuliere natürlich in eigenen Worten. " +
        "Nenne keine konkreten Prozentzahlen wenn du das schon getan hast."
      );

    case "need_contribution":
      return (
        "SCHRITT 4 – BEITRAG: Der Kunde hat auf die Beitragsentwicklung reagiert. " +
        "Gehe in einem Satz auf seine Antwort ein (z.B. 'Das kenne ich.'). " +
        "Sage dann: 'Ich kann das für Sie konkret hochrechnen, wenn Sie mögen. Wie hoch ist Ihr aktueller monatlicher Beitrag?' " +
        "Warte. Keine weiteren Fragen."
      );

    case "need_projection": {
      const amount = extractEuroAmount(assessment.contributionPhrase || "");
      let projectionHint = "";
      if (amount) {
        const projected10 = roundToFive(Math.round(amount * (1.04 ** 10)));
        const delta10 = roundToFive(projected10 - amount);
        // Schätze Ruhestand bei ca. 25 Jahren
        const projected25 = roundToFive(Math.round(amount * (1.04 ** 25)));
        const delta25 = roundToFive(projected25 - amount);
        projectionHint = ` VERBINDLICHE RECHENWERTE (exakt verwenden): Heute: ${amount} Euro. In 10 Jahren: ca. ${projected10} Euro (+${delta10} Euro/Monat). In 25 Jahren: ca. ${projected25} Euro (+${delta25} Euro/Monat).`;
      }
      return (
        `SCHRITT 5 – HOCHRECHNUNG: Rechne den Beitrag (${assessment.contributionPhrase || "den genannten Betrag"}) menschlich hoch.${projectionHint} ` +
        `Beispiel: "${anrede}bei ${assessment.contributionPhrase || "Ihrem Beitrag"} und etwa vier Prozent Steigerung im Jahr wären das in zehn Jahren rund [${amount ? roundToFive(Math.round(amount * (1.04 ** 10))) : "X"}] Euro im Monat – das sind [DELTA] Euro mehr. ` +
        `Und wenn Sie das bis zum Ruhestand durchrechnen, kommen da erhebliche Mehrbeiträge zusammen." ` +
        `Stelle danach NUR diese eine Frage: "Haben Sie Ihre Beitragsentwicklung schon einmal so betrachtet?" Keine Terminangebote.`
      );
    }

    case "need_concept":
      return (
        "SCHRITT 7 – KONZEPT ERKLÄREN: Gehe kurz auf die Antwort des Kunden ein, dann erkläre das Konzept von Herrn Duic: " +
        "'Genau da setzt Herr Duic an. Er schaut sich gemeinsam mit Ihnen die Beitragsentwicklung zur Gesundheitsversorgung an, " +
        "rechnet Ihren Beitrag vorsichtig bis zum Ruhestand hoch und zeigt Ihnen Möglichkeiten, diesen Beitrag zu reduzieren. " +
        "Dabei werden Altersrückstellungen, Beitragsentlastungstarife und die Möglichkeit zur Nutzung von Steuervorteilen besprochen, " +
        "um den Beitrag im Alter zu senken.' " +
        "Frage danach: 'Klingt das interessant für Sie?' Warte auf klares Ja. Kein Terminangebot jetzt."
      );

    case "need_interest":
      return (
        "SCHRITT 7b – INTERESSE BESTÄTIGEN: Das Konzept wurde erklärt. " +
        "Falls noch keine klare Zustimmung kam, frage einmal direkt: 'Klingt das interessant für Sie?' " +
        "Bei klarem Ja direkt zur Terminvereinbarung übergehen."
      );

    case "ready_to_schedule":
      return (
        "SCHRITT 8 – TERMINVEREINBARUNG: Die fachlichen Voraussetzungen sind erfüllt, der Kunde hat Interesse bestätigt. " +
        "Frage zuerst nur: 'Passt Ihnen eher vormittags oder nachmittags besser?' " +
        "Biete dann genau zwei echte freie Terminslots an verschiedenen Tagen an."
      );
  }
}