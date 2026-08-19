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
// Step 2: VERTIEFUNG - emotional follow-up to understand customer's pain
// Step 3: BEITRAG - ask for current monthly contribution
// Step 4: HOCHRECHNUNG - present 10-year + retirement projection
// Step 5: KONZEPT - explain Herr Duic approach (emotionally), ask for interest
// Step 6: TERMIN - schedule appointment
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
        "Der Kunde hat zugestimmt. Erkläre in 2 kurzen Sätzen in eigenen Worten, dass PKV-Beiträge " +
        "jährlich steigen und das langfristig spürbar wird. Stelle dann genau eine offene Frage wie " +
        "'Merken Sie das bei sich?' oder 'Wie erleben Sie das?'. Warte vollständig auf die Antwort."
      );

    case 2:
      // VERTIEFUNG: emotional follow-up before asking for contribution
      return (
        "Gehe jetzt emotional auf die Antwort des Kunden ein: Benenne in einem Satz konkret, was er gesagt hat und zeige echtes Verständnis " +
        "(z.B. 'Das kenne ich — wenn man jedes Jahr einfach mehr zahlt und nicht weiß wo das endet, ist das ein echtes Unbehagen.'). " +
        "Stelle dann genau eine vertiefende emotionale Frage, z.B.: " +
        "'Was belastet Sie dabei mehr — die Unplanbarkeit, oder ist es der tatsachliche Mehrbetrag der sich aufaddiert?' " +
        "Oder: 'Haben Sie das Gefühl dass Sie das einfach hinnehmen müssen, oder suchen Sie aktiv nach Möglichkeiten da etwas zu tun?' " +
        "Wähle die Frage die am besten zur Aussage des Kunden passt. Nur diese eine Frage. Warte auf Antwort."
      );

    case 3:
      return (
        "Greife die Antwort des Kunden kurz auf (ein Satz). " +
        "Leite dann über: 'Ich kann das für Sie einmal konkret durchrechnen, wenn Sie mögen — so sehen Sie schwarz auf weiß, was das langfristig bedeutet. " +
        "Wie hoch ist Ihr aktueller monatlicher Beitrag?' Nur diese eine Frage. Warte auf die Antwort."
      );

    case 4: {
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

    case 5:
      // KONZEPT: emotionally warm, connect to customer's specific pain
      return (
        "Greife jetzt die konkreten Sorgen und Aussagen des Kunden aus diesem Gespräch auf — nicht generisch, sondern persönlich. " +
        "Starte mit einer kurzen Validierung seiner Situation (z.B. 'Genau das, was Sie beschrieben haben — diese Mischung aus " +
        "Unplanbarkeit und dem Gefühl keinen Einfluss zu haben — das ist es, womit Herr Duic täglich arbeitet.'). " +
        "Erkläre dann warm und konkret: Herr Duic schaut sich die Beitragsentwicklung individuell an, rechnet vorsichtig bis zum Ruhestand " +
        "und zeigt ganz konkret welche Stellschrauben es gibt — Altersrückstellungen, Beitragsentlastungstarife, Steuervorteile. " +
        "Keine Verkaufsphrasen, kein Druck. Stelle dann eine offene Frage: 'Klingt das nach etwas, das für Sie relevant sein könnte?' " +
        "Warte auf klares Ja oder Nein."
      );

    case 6:
      return (
        "Der Kunde hat Interesse bestätigt. Führe jetzt die Terminvereinbarung durch:\n" +
        "1. Frage zuerst: 'Passt Ihnen generell eher ein Vormittag oder ein Nachmittag besser?' Warte auf Antwort.\n" +
        "2. Biete je nach Antwort genau zwei passende Termine aus den freien Slots an. Beispiel: 'Dann hätte ich [Termin 1] oder [Termin 2] — welcher passt Ihnen besser?' Warte.\n" +
        "3. Wenn keiner der Termine passt, frage: 'Welchen Termin würden Sie denn vorschlagen?' und übernehme den Kundenwunsch.\n" +
        "4. Nach Terminbestätigung: Stelle die Gesundheitsfragen aus der Topic Policy einzeln. Falls der Kunde sie nicht am Telefon beantworten möchte: 'Kein Problem, ich lege die Fragen in die Bestätigungsmail.' \n" +
        "5. Frage am Ende ob der Kunde noch Wünsche oder Anregungen für den Termin hat, dann freundlich verabschieden."
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
      // Any response to relevance question → emotional follow-up
      return { nextStep: 2, shouldEnd: false };

    case 2:
      // Any response to emotional follow-up → ask for contribution
      return { nextStep: 3, shouldEnd: false };

    case 3: {
      const hasAmount = /\b(?:\d{2,5}|hundert|tausend|euro|€)\b/i.test(text);
      if (hasAmount) return { nextStep: 4, shouldEnd: false };
      return { nextStep: 3, shouldEnd: false };
    }

    case 4:
      // Any response to projection → concept
      return { nextStep: 5, shouldEnd: false };

    case 5: {
      const interested = /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut|sicher\b|natürlich\b|m[oö]chte|sehr\s+gerne|würde\s+gerne|relevant\b|schon\b)\b/i.test(text);
      const notInterested = /\b(?:nein\b|nicht\s+interessiert|kein\s+interesse|lieber\s+nicht|danke\s+nein|eher\s+nicht)\b/i.test(text);
      if (interested) return { nextStep: 6, shouldEnd: false };
      if (notInterested) return { nextStep: 5, shouldEnd: true };
      return { nextStep: 5, shouldEnd: false };
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
    assessment.stage === "ready_to_schedule" ? 6
      : assessment.stage === "need_interest" || assessment.stage === "need_concept" ? 5
      : assessment.stage === "need_projection" ? 4
      : assessment.stage === "need_contribution" ? 3
      : 1,
    assessment.contributionPhrase,
  );
}
