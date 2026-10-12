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

function buildTenYearProjectionSentence(contributionPhrase?: string): string {
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
    if (turns[index].role === "assistant" && /welchen beitrag zahlen sie heute/i.test(turns[index].text)) {
      currentContributionQuestion = index;
      break;
    }
  }

  const userTurns = turns.filter((turn, index) => turn.role === "user" && (currentContributionQuestion < 0 || index > currentContributionQuestion));
  const explicitContribution = extractContributionPhrase(userTurns.map((turn) => turn.text).join(" "));
  if (explicitContribution) return explicitContribution;
  if (currentContributionQuestion < 0) return undefined;

  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const standaloneAmount = userTurns[index].text.trim().match(/^(?:ca\.?\s*|circa\s*|rund\s*|etwa\s*)?(\d{2,5}|\d{1,3}(?:\.\d{3})+)[.,]?\s*$/i)?.[1];
    if (standaloneAmount) return `${standaloneAmount} Euro`;
  }
  return undefined;
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

    case 1: {
      if (/\b(?:nein|keine\s+zeit|gerade\s+schlecht|später|keinen\s+moment)\b/i.test(text)) {
        return { nextStep: 1, shouldEnd: true };
      }
      const answered = /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:ein|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf|hundert|tausend)[a-zäöüß-]*\s+euro)\b/i.test(text)
        || /\b(?:ja|gerne|klar|natürlich|moment|zeit|beitrag\w*|steig\w*|gestieg\w*|erh[öo]h\w*|teuer\w*|hoch|belast\w*|sorge\w*|sp[üu]r\w*|merk\w*|ruhestand|rente|planung|problem\w*|betrifft|noch\s+nicht|bisher\s+nicht|wei[ßs]\s+ich\s+nicht|keine\s+ahnung|kann\s+mich\s+nicht\s+erinnern)\b/i.test(text);
      return { nextStep: answered ? 2 : 1, shouldEnd: false };
    }

    case 2: {
      const hasAmount = /\b(?:\d{2,5}|hundert|tausend|euro|€)\b/i.test(text);
      const declined = /\b(?:wei[ßs]\s+ich\s+nicht|keine\s+ahnung|möchte\s+ich\s+nicht\s+(?:sagen|nennen)|will\s+ich\s+nicht\s+sagen|möchte\s+ich\s+nicht\s+angeben)\b/i.test(text);
      return { nextStep: hasAmount || declined ? 3 : 2, shouldEnd: false };
    }

    case 3: {
      const answered = /\b(?:ja|nein|durchgerechnet|gerechnet|gewusst|bewusst|viel|hoch|heftig|überrasch|erschreck|interessant|belast|sorge|noch\s+nie|noch\s+nicht|bisher\s+nicht)\b/i.test(text);
      return { nextStep: answered ? 4 : 3, shouldEnd: false };
    }

    case 4: {
      const interested = /\b(?:ja\b|gerne\b|interessant\b|klingt\s+gut|sicher\b|natürlich\b|m[oö]chte|sehr\s+gerne|würde\s+gerne|relevant\b|schon\b)\b/i.test(text);
      const notInterested = /\b(?:nein\b|nicht\s+interessiert|kein\s+interesse|lieber\s+nicht|danke\s+nein|eher\s+nicht)\b/i.test(text);
      if (interested) return { nextStep: 6, shouldEnd: false };
      if (notInterested) return { nextStep: 4, shouldEnd: true };
      return { nextStep: 4, shouldEnd: false };
    }

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
// STEP-BASED STATE MACHINE
// Step 0: explain the reason and ask for a moment
// Step 1: explain relevance and ask about the initial contribution
// Step 2: ask about the current contribution
// Step 3: present a 10-year projection
// Step 4: discuss the projection and introduce Herr Duic
// Step 5: confirm interest
// Step 6: schedule the appointment
export function isClearPkvInterest(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return /^(?:ja|gerne|sehr gerne|interessant|klingt gut|das klingt gut|das möchte ich|würde ich gerne|machen wir|passt|einverstanden|gute idee|guter gedanke)\b/i.test(normalized)
    || /\b(?:das|es)\s+(?:möchte|würde)\s+ich\s+(?:gern|gerne)\b/i.test(normalized)
    || /\b(?:macht sinn|sinnvoll|interessant|hört sich gut an|hoert sich gut an|genau das brauche ich|bringt mich weiter|zeigen sie mir das)\b/i.test(normalized);
}

// ============================================================================
export function instructionForPkvStep(step: number, contributionPhrase?: string): string {
  switch (step) {
    case 0:
      return "Sage kurz: 'Es geht um die Beitragsentwicklung in der Gesundheitsversorgung. Haben Sie gerade einen kurzen Moment?' Keine weitere Erklärung und keine zusätzliche Frage. Bei Nein oder Zeitmangel respektvoll verabschieden; bei unklarer Reaktion kurz nachfragen.";
    case 1:
      return "Der Anlass wurde bereits genannt; wiederhole ihn nicht. Sage exakt und ohne Vor- oder Nachsatz: 'Laut PKV Verband steigen die Beiträge in der Gesundheitsversorgung jedes Jahr um 3-5%, was auf den ersten Blick noch relativ harmlos wirkt, aber über die Jahre deutlich spürbar ist. Erinnern Sie sich noch, mit welchem Beitrag Sie einmal angefangen haben?' Warte danach auf die Antwort.";
    case 2:
      return "Reagiere freundlich und knapp auf die Antwort. Frage dann genau: 'Und welchen Beitrag zahlen Sie heute?' Stelle keine weitere Frage und warte vollständig auf die Antwort. Wenn der Kunde den früheren Beitrag nicht mehr weiß, akzeptiere das ohne Nachhaken und frage nach dem heutigen Beitrag.";
    case 3:
      return (
        `Rechne ${contributionPhrase || "den genannten Beitrag"} mit rund vier Prozent pro Jahr auf zehn Jahre hoch. ` +
        `${buildTenYearProjectionSentence(contributionPhrase)} ` +
        "Frage danach genau: 'Haben Sie das schon einmal für sich hochgerechnet?' Warte vollständig auf die Antwort. Wenn kein heutiger Betrag genannt wurde, kennzeichne die Rechnung ausdrücklich als Beispiel."
      );
    case 4:
      return "Greife die Reaktion des Kunden auf die Hochrechnung kurz und empathisch auf. Sage knapp: 'Genau damit beschäftigt sich Herr Duic jeden Tag. Er zeigt Ihnen anhand Ihrer Situation, wie sich Ihr Beitrag bis zum Ruhestand entwickeln kann und welche Möglichkeiten es gibt, ihn im Alter besser planbar und tragbar zu halten.' Erkläre den Ablauf nicht weiter und verspreche kein Ergebnis. Frage genau einmal: 'Wäre es für Sie interessant, sich das mit Herrn Duic persönlich anzuschauen?' Warte auf klares Interesse.";
    case 5:
      return "Der Kunde hat noch nicht eindeutig auf die Einladung reagiert. Frage einmal kurz: 'Wäre es für Sie interessant, sich das mit Herrn Duic persönlich anzuschauen?' Warte auf ein klares Ja oder Nein.";
    case 6:
      return "Der Kunde hat Interesse bestätigt. Vereinbare jetzt einen Termin und erkläre den Ablauf nicht weiter. Frage zuerst, ob eher Vormittag oder Nachmittag passt, biete danach zwei echte freie Termine an und frage nach Auswahl ausschließlich: 'Soll der Termin digital per Microsoft Teams oder bei Ihnen vor Ort stattfinden?' Biete keinen Termin in der Agentur an. Bei Ablauf-Fragen sage freundlich, dass Herr Duic sie im Termin klärt. Nach Bestätigung führe die kurze freiwillige Vorbereitung und Abschlussfragen durch, frage nach der E-Mail-Adresse und lasse die Bestätigung über den vorgesehenen Prozess versenden.";
    default:
      return "Führe das Gespräch natürlich weiter und warte auf den Kunden.";
  }
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
    : /beitrag|entwicklung|versichert|gesundheitsversorgung/i.test(userText) ? "need_contribution" : "need_relevance";
  return { stage, contributionPhrase, projectionDelivered, conceptDelivered, interestConfirmed: schedulingReady };
}

export function instructionForPkvStage(assessment: PkvConversationAssessment): string {
  return instructionForPkvStep(
    assessment.stage === "ready_to_schedule" ? 6
      : assessment.stage === "need_interest" || assessment.stage === "need_concept" ? 4
      : assessment.stage === "need_projection" ? 3
      : assessment.stage === "need_contribution" ? 2
      : 1,
    assessment.contributionPhrase,
  );
}
