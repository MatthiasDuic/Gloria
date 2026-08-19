export type ConversationTurn = {
  role: "user" | "assistant";
  text: string;
};

// Legacy types kept for canConfirmRealtimeAppointment compatibility
export type PkvConversationStage = "need_relevance" | "need_contribution" | "need_projection" | "need_concept" | "need_interest" | "ready_to_schedule";
export type PkvConversationAssessment = { stage: PkvConversationStage; contributionPhrase?: string; projectionDelivered: boolean; conceptDelivered: boolean; interestConfirmed: boolean };

const CONTRIBUTION_PATTERN = /\b(?:ca\.?|circa|rund|etwa)?\s*(?:\d{1,3}(?:\.\d{3})+|\d{2,5})(?:,\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro\b/i;

function parseGermanEuroAmount(phrase: string): number | undefined {
  const normalized = phrase.replace(/\./g, "").replace(/,\d+/g, "").replace(/€/g, "euro");
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
  for (const [word, value] of Object.entries(wordMap)) {
    if (normalized.toLowerCase().includes(word)) return value;
  }
  return undefined;
}

function roundToFive(n: number): number {
  return Math.round(n / 5) * 5;
}

export function extractContributionPhrase(userText: string): string | undefined {
  return userText.match(CONTRIBUTION_PATTERN)?.[0];
}

// ============================================================================
// STEP-BASED STATE MACHINE
// Step 0: awaiting permission after greeting
// Step 1: RELEVANZ - explain rising costs, open question
// Step 2: BEITRAG - ask for current monthly contribution
// Step 3: HOCHRECHNUNG - present 10-year + retirement projection
// Step 4: KONZEPT - explain Herr Duic approach, ask for interest
// Step 5: TERMIN - schedule appointment
// ============================================================================

export function instructionForPkvStep(step: number, contributionPhrase?: string): string {
  switch (step) {
    case 0:
      return (
        "Der Kunde hat auf deine Begrüßung und die Frage 'Darf ich kurz sagen worum es geht?' reagiert. " +
        "Bei Zustimmung (ja, klar, gerne, bitte): erkläre kurz das Thema und stelle eine offene Frage zu steigenden Beiträgen. " +
        "Bei Ablehnung (nein, kein Interesse): verabschiede dich höflich. " +
        "Bei unklarer Reaktion: frage kurz nach."
      );

    case 1:
      return (
        "Der Kunde hat zugestimmt. Erkläre jetzt in 2 kurzen Sätzen in eigenen Worten, dass PKV-Beiträge " +
        "jährlich steigen und das langfristig spürbar wird. Stelle dann genau eine offene Frage wie " +
        "'Merken Sie das bei sich?' oder 'Wie erleben Sie das?'. Warte vollständig auf die Antwort."
      );

    case 2:
      return (
        "Reagiere kurz wertschätzend auf das was der Kunde gesagt hat (ein Satz). " +
        "Biete dann an, das konkret durchzurechnen: 'Wie hoch ist Ihr aktueller monatlicher Beitrag?' " +
        "Nur diese eine Frage. Warte auf die Antwort."
      );

    case 3: {
      const phrase = contributionPhrase || "den genannten Beitrag";
      let hint = "";
      if (contributionPhrase) {
        const amount = parseGermanEuroAmount(contributionPhrase);
        if (amount) {
          const y10 = roundToFive(Math.round(amount * (1.04 ** 10)));
          const d10 = roundToFive(y10 - amount);
          const y25 = roundToFive(Math.round(amount * (1.04 ** 25)));
          const d25 = roundToFive(y25 - amount);
          hint = ` RECHENWERTE: ${amount}€ heute → ${y10}€ in 10 Jahren (+${d10}€/Mo) → ${y25}€ in 25 Jahren (+${d25}€/Mo). Exakt so verwenden.`;
        }
      }
      return (
        `Rechne ${phrase} mit rund 4% Steigerung pro Jahr auf 10 Jahre und bis zum Ruhestand (ca. 25 Jahre) hoch.${hint} ` +
        "Formuliere das kurz und menschlich: 'Bei Ihrem Beitrag wären das in 10 Jahren rund X Euro mehr — " +
        "und bis zum Ruhestand kommen erhebliche Mehrbeträge zusammen.' " +
        "Stelle danach genau eine Frage: 'Haben Sie das schon so betrachtet?' Warte vollständig auf die Antwort."
      );
    }

    case 4:
      return (
        "Greife die Reaktion des Kunden kurz auf. Erkläre dann das Konzept von Herrn Duic: " +
        "Er analysiert die Beitragsentwicklung individuell, rechnet bis zum Ruhestand hoch und zeigt " +
        "Möglichkeiten den Beitrag zu senken — Altersrückstellungen, Beitragsentlastungstarife, Steuervorteile. " +
        "Schließe mit einer direkten Frage: 'Klingt das interessant für Sie?' Warte auf Ja oder Nein."
      );

    case 5:
      return (
        "Der Kunde hat Interesse bestätigt. Terminvereinbarung: Frage zuerst ob Vormittag oder Nachmittag " +
        "besser passt. Dann zwei konkrete Terminoptionen anbieten. Nach Bestätigung: Gesundheitsfragen aus " +
        "Topic Policy einzeln stellen. Falls der Kunde nicht am Telefon antworten möchte: " +
        "'Kein Problem, ich lege die Fragen in die Bestätigungsmail.' " +
        "Frage am Ende nach Wünschen für den Termin und verabschiede dich."
      );

    default:
      return "Führe das Gespräch natürlich weiter und warte auf den Kunden.";
  }
}

export function advancePkvStep(
  currentStep: number,
  userText: string,
): { nextStep: number; shouldEnd: boolean } {
  const text = userText.toLowerCase().trim();

  switch (currentStep) {
    case 0: {
      const agreed = /\b(?:ja\b|klar\b|gerne\b|bitte\b|natürlich\b|okay\b|ok\b|sicher\b|machen\s+sie|sagen\s+sie|erzählen\s+sie)\b/i.test(text);
      const declined = /\b(?:nein\b|nicht\s+interessiert|kein\s+interesse|keine\s+zeit|rufen\s+sie\s+bitte\s+nicht)\b/i.test(text);
      if (declined) return { nextStep: 0, shouldEnd: true };
      if (agreed || text.length > 5) return { nextStep: 1, shouldEnd: false };
      return { nextStep: 0, shouldEnd: false };
    }

    case 1:
      // Any user response to relevance question → advance to asking for Beitrag
      return { nextStep: 2, shouldEnd: false };

    case 2: {
      const hasAmount = /\b(?:\d{2,5}|hundert|tausend|euro|€)\b/i.test(text);
      if (hasAmount) return { nextStep: 3, shouldEnd: false };
      // No amount given — stay (Gloria will try again)
      return { nextStep: 2, shouldEnd: false };
    }

    case 3:
      // Any response to projection → advance to concept
      return { nextStep: 4, shouldEnd: false };

    case 4: {
      const interested = /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut|sicher\b|natürlich\b|m[oö]chte|sehr\s+gerne|würde\s+gerne)\b/i.test(text);
      const notInterested = /\b(?:nein\b|nicht\s+interessiert|kein\s+interesse|lieber\s+nicht|danke\s+nein|eher\s+nicht)\b/i.test(text);
      if (interested) return { nextStep: 5, shouldEnd: false };
      if (notInterested) return { nextStep: 4, shouldEnd: true };
      return { nextStep: 4, shouldEnd: false };
    }

    default:
      return { nextStep: currentStep, shouldEnd: false };
  }
}

// ============================================================================
// LEGACY COMPATIBILITY
// ============================================================================

export function assessPkvConversation(turns: ConversationTurn[]): PkvConversationAssessment {
  const userText = turns.filter(t => t.role === "user").map(t => t.text).join(" ");
  const assistantText = turns.filter(t => t.role === "assistant").map(t => t.text).join(" ");
  const contributionPhrase = userText.match(CONTRIBUTION_PATTERN)?.[0];
  const projectionDelivered = /(?:zehn\s+jahren|10\s+jahren|hochrechn|mehrbetrag)/i.test(assistantText);
  const conceptDelivered = /(?:herr\s+duic|altersrückstell|beitragsentlastung)/i.test(assistantText);
  const lastUserText = turns.slice().reverse().find(t => t.role === "user")?.text || "";
  const lastAssistantText = turns.slice().reverse().find(t => t.role === "assistant")?.text || "";
  const interestConfirmed = /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut)\b/i.test(lastUserText)
    && /(?:interessant|termin|klingt|konzept)/i.test(lastAssistantText);
  const stage: PkvConversationStage = interestConfirmed ? "ready_to_schedule"
    : conceptDelivered ? "need_interest"
    : projectionDelivered ? "need_concept"
    : contributionPhrase ? "need_projection"
    : "need_contribution";
  return { stage, contributionPhrase, projectionDelivered, conceptDelivered, interestConfirmed };
}

export function instructionForPkvStage(assessment: PkvConversationAssessment): string {
  return instructionForPkvStep(
    assessment.stage === "ready_to_schedule" ? 5
      : assessment.stage === "need_interest" || assessment.stage === "need_concept" ? 4
      : assessment.stage === "need_projection" ? 3
      : assessment.stage === "need_contribution" ? 2
      : 1,
    assessment.contributionPhrase,
  );
}
