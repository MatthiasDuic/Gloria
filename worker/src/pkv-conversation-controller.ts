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
        "Der Kunde hat zugestimmt. Erkläre in 1-2 eigenen, natürlichen Sätzen, dass die Beiträge in der " +
        "Gesundheitsversorgung Jahr für Jahr steigen, im Durchschnitt etwa 3-5% jährlich, und das über die Jahre erheblich wird. " +
        "Sprich konsistent von 'Beitragsentwicklung in der Gesundheitsversorgung'. " +
        "Frage dann genau einmal wie der Kunde damit umgeht oder wie er das erlebt. Warte vollständig auf die Antwort."
      );

    case 2:
      // VERTIEFUNG: clarify whether customer already has a plan for contribution trend and retirement preparedness
      return (
        "Gehe kurz auf die Antwort des Kunden ein und zeige Verständnis in einem Satz. " +
        "Kläre dann gezielt, ob bereits ein konkreter Plan für die Beitragsentwicklung und die Absicherung bis zum Ruhestand besteht. " +
        "Stelle genau eine vertiefende Frage, zum Beispiel: " +
        "'Haben Sie dafür bereits einen klaren Plan, wie Sie mit der Beitragsentwicklung umgehen und sich bis zum Ruhestand absichern?' " +
        "Wenn nein oder unklar: frage kurz nach, warum das bisher keine Priorität hatte. " +
        "Nur diese eine Frage pro Turn. Warte vollständig auf die Antwort."
      );

    case 3:
      return (
        "Greife die Antwort des Kunden kurz auf (ein Satz). " +
        "Leite dann über: 'Ich kann das für Sie einmal konkret hochrechnen, damit Sie ein Gefühl dafür bekommen, wohin die Reise geht und was in den nächsten Jahren auf Sie zukommen wird, wenn die Entwicklung so weitergeht. " +
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
          hint = ` RECHENWERTE (exakt so verwenden): heute ${amount} Euro, in 10 Jahren circa ${y10} Euro, das sind etwa ${d10} Euro mehr pro Monat.`;
        }
      }
      return (
        `Rechne ${phrase} mit rund 4% Steigerung pro Jahr auf 10 Jahre hoch.${hint} ` +
        "Formuliere das kurz und menschlich: 'Bei Ihrem Beitrag wären das in 10 Jahren rund X Euro mehr — das ist schon eine spürbare Veränderung.' " +
        "Stelle danach GENAU EINE Frage: 'Haben Sie das schon mal so im Detail angeschaut?' Warte vollständig auf die Antwort. " +
        "KEIN Ruhestand, KEINE 25-Jahres-Berechnung — nur 10 Jahre."
      );
    }

    case 5:
      // KONZEPT: emotionally warm, personal, professional
      return (
        "Greife die konkreten Sorgen und Aussagen des Kunden aus diesem Gespräch auf — nicht generisch, sondern persönlich. " +
        "Validiere zuerst kurz: was der Kunde beschrieben hat, ist real und berechtigt. " +
        "Erkläre dann mit echter Wärme: Genau das ist es, womit Herr Duic täglich arbeitet. " +
        "Er schaut sich die Beitragsentwicklung gemeinsam mit dem Kunden an, rechnet den Beitrag konkret hoch " +
        "und zeigt persönlich welche Stellschrauben es gibt, um langfristig mehr Kontrolle zu haben. " +
        "Stelle dann eine offene, einladende Frage: 'Wäre es nicht sinnvoll, das einmal zusammen im Detail anzuschauen?' " +
        "Kein Verkaufsdruck, kein Pitch. KEINE Erwähnung von Termindauer oder Anzahl Termine — nur wenn der Kunde fragt. Keine Terminfrage, bevor der Kunde klar Interesse bestätigt. " +
        "Warte auf klares Ja oder Nein."
      );

    case 6:
      return (
        "Der Kunde hat Interesse bestätigt. Vereinbare jetzt einen Vor-Ort-Termin bei Ihm. Geh professionell vor:\n" +
        "1. Frage: 'Passt Ihnen generell eher ein Vormittag oder ein Nachmittag besser?' Warte auf Antwort.\n" +
        "2. Biete zwei passende Termine an: 'Dann hätte ich [Termin 1] oder [Termin 2] — welcher passt Ihnen besser?' Warte.\n" +
        "3. Falls keiner passt: 'Welchen Termin würden Sie denn vorschlagen?' und übernehme den Wunsch.\n" +
        "4. Nach Bestätigung: Gesundheitsfragen einzeln stellen. Bei Ablehnung am Telefon: 'Kein Problem, ich lege die Fragen in die Bestätigungsmail.'\n" +
        "5. Frage ob der Kunde noch Wünsche für den Termin hat, dann professionell verabschieden.\n" +
        "NUR WENN GEFRAGT: Ersttermin ca. 20 Minuten. NUR WENN GEFRAGT: Es gibt drei Termine insgesamt."
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
      const greetingOnly = /^(?:guten\s+tag|hallo|ja\s+guten\s+tag|tag\s+auch|moin)(?:[.!?\s]*)$/i.test(text);
      if (declined) return { nextStep: 0, shouldEnd: true };
      if (greetingOnly) return { nextStep: 0, shouldEnd: false };
      if (agreed) return { nextStep: 1, shouldEnd: false };
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
  if (!turns.length || !userText.trim()) {
    return { stage: "need_relevance", contributionPhrase: undefined, projectionDelivered: false, conceptDelivered: false, interestConfirmed: false };
  }
  const contributionPhrase = userText.match(CONTRIBUTION_PATTERN)?.[0];
  const projectionDelivered = /(?:zehn\s+jahren|10\s+jahren|hochrechn|mehrbetrag)/i.test(assistantText);
  const conceptDelivered = /(?:herr\s+duic|altersrückstell|beitragsentlastung|bis\s+zum\s+ruhestand|f[üu]r\s+ihre\s+planung|wie\s+f[üu]hlt\s+sich\s+diese\s+entwicklung)/i.test(assistantText);

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

  const stage: PkvConversationStage = interestConfirmed ? "ready_to_schedule"
    : conceptDelivered ? "need_interest"
    : projectionDelivered ? "need_concept"
    : contributionPhrase ? "need_projection"
    : /beitrag|entwicklung|versichert|gesundheitsversorgung/i.test(userText) ? "need_contribution" : "need_relevance";
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
