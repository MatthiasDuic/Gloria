import type { ConversationTurn } from "./pkv-conversation-controller.js";


export function formatTimeForSpeech(timeStr: string): string {
  // Re-export for use in other modules (delegates to formatTimeGerman)
  const [hourStr, minuteStr] = timeStr.split(":") || [];
  if (!hourStr) return timeStr;
  const hour = Number.parseInt(hourStr, 10);
  const minute = minuteStr ? Number.parseInt(minuteStr, 10) : 0;
  const hourWords = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig"];
  const minuteWords = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn", "zwanzig", "einundzwanzig", "zweiundzwanzig", "dreiundzwanzig", "vierundzwanzig", "fünfundzwanzig", "sechsundzwanzig", "siebenundzwanzig", "achtundzwanzig", "neunundzwanzig", "dreißig", "einunddreißig", "zweiunddreißig", "dreiunddreißig", "vierunddreißig", "fünfunddreißig", "sechsunddreißig", "siebenunddreißig", "achtunddreißig", "neununddreißig"];
  const hourWord = hourWords[hour % 24] || String(hour);
  if (minute === 0) return `${hourWord} Uhr`;
  const minuteWord = minuteWords[minute] || String(minute);
  return `${hourWord} Uhr ${minuteWord}`;
}

export function formatAmountForSpeech(amount: string | number): string {
  // Re-export for use in other modules (delegates to formatAmountGerman)
  const num = typeof amount === "string" ? Number.parseInt(amount.replace(/\D/g, ""), 10) : amount;
  if (Number.isNaN(num) || num < 0) return String(amount);
  if (num < 20) {
    const words = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
    return words[num] || String(num);
  }
  if (num === 20) return "zwanzig";
  if (num < 100) {
    const tens = Math.floor(num / 10);
    const ones = num % 10;
    const tensWords = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];
    const onesWords = ["", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
    if (ones === 0) return tensWords[tens];
    return `${onesWords[ones]}und${tensWords[tens]}`;
  }
  if (num < 1000) {
    const hundreds = Math.floor(num / 100);
    const remainder = num % 100;
    const hundredsWords = ["", "einhundert", "zweihundert", "dreihundert", "vierhundert", "fünfhundert", "sechshundert", "siebenhundert", "achthundert", "neunhundert"];
    const hundredWord = hundredsWords[hundreds];
    if (remainder === 0) return hundredWord;
    const remainderWord = formatAmountForSpeech(remainder);
    return `${hundredWord}${remainderWord}`;
  }
  if (num < 1000000) {
    const thousands = Math.floor(num / 1000);
    const remainder = num % 1000;
    const thousandWord = thousands === 1 ? "eintausend" : `${formatAmountForSpeech(thousands)}tausend`;
    if (remainder === 0) return thousandWord;
    const remainderWord = formatAmountForSpeech(remainder);
    return `${thousandWord}${remainderWord}`;
  }
  return String(num);
}
export type PreparationPolicy = {
  topic?: string;
  requiredQuestions?: string;
  requiredData?: string;
  pkvHealthQuestions?: string;
};

export type PreparationStage = "inactive" | "awaiting_consent" | "asking" | "awaiting_email" | "completed" | "declined";

export type PreparationState = {
  stage: PreparationStage;
  questions: string[];
  currentQuestionIndex?: number;
};

export type PreparationTransition = {
  state: PreparationState;
  instruction: string;
};

const PKV_FALLBACK_QUESTIONS = [
  "Darf ich bitte zuerst Ihr Geburtsdatum aufnehmen?",
  "Könnten Sie mir Ihre Körpergröße nennen?",
  "Wie ist Ihr aktuelles Gewicht?",
  "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
  "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
  "Gibt es aktuell laufende Behandlungen oder bekannte Diagnosen, die wir berücksichtigen sollten?",
  "Nehmen Sie regelmäßig Medikamente ein, und wenn ja, welche?",
  "Gab es in den letzten fünf Jahren stationäre Aufenthalte im Krankenhaus?",
  "Gab es in den letzten zehn Jahren psychische Behandlungen?",
  "Fehlen aktuell Zähne oder ist Zahnersatz geplant?",
  "Bestehen bei Ihnen bekannte Allergien?",
].join("\n");

export function buildPreparationQuestions(policy: PreparationPolicy | null): string[] {
  const isPkv = /private\s+krankenversicherung|pkv/i.test(policy?.topic || "");
  const source = isPkv
    ? policy?.pkvHealthQuestions || policy?.requiredQuestions || policy?.requiredData || PKV_FALLBACK_QUESTIONS
    : policy?.requiredQuestions || policy?.requiredData || "";
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3);
}

export function createPreparationState(policy: PreparationPolicy | null = null): PreparationState {
  return { stage: "inactive", questions: buildPreparationQuestions(policy) };
}

function preparationConsent(text: string): "granted" | "declined" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (/^(?:ja\b|gerne\b|klar\b|okay\b|ok\b|passt\b|in ordnung\b|machen wir\b)/i.test(normalized)) return "granted";
  if (/^(?:nein\b|nö\b|lieber nicht|keine zeit|nicht jetzt|später|möchte ich nicht|das möchte ich nicht|will ich nicht)/i.test(normalized)) return "declined";
  return "unknown";
}

function isQuestionAlreadyAnswered(question: string, turns: ConversationTurn[]): boolean {
  const userText = turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  if (/versicher|privat|gesetzlich|pkv|gkv/i.test(question)) return /\b(?:privat|gesetzlich|pkv|gkv)\b/i.test(userText);
  if (/monatsbeitrag|beitrag.*krankenversicherung/i.test(question)) {
    return /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro)\b/i.test(userText);
  }
  return false;
}

function nextUnansweredQuestion(
  state: PreparationState,
  turns: ConversationTurn[],
  startIndex: number,
): { question: string; index: number } | undefined {
  for (let index = startIndex; index < state.questions.length; index += 1) {
    const question = state.questions[index];
    if (!isQuestionAlreadyAnswered(question, turns)) return { question, index };
  }
  return undefined;
}

function isAnswerPlausible(question: string, text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized || /^(?:hallo|okay|ok|mhm|äh+|hm+|keine ahnung)[.!?]*$/i.test(normalized)) return false;
  if (/geburtsdatum/i.test(question)) return /\b(?:\d{1,2}\.\s*)?(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|\d{1,2}[./-]\d{1,2})\b|\b(?:19|20)\d{2}\b/i.test(normalized);
  if (/körpergröße|groesse/i.test(question)) return /\b(?:\d[,.]?\d?\s*(?:m|meter|cm|zentimeter)|ein[e]?\s+meter)\b/i.test(normalized);
  if (/gewicht/i.test(question)) return /\b\d{2,3}\s*(?:kg|kilo|kilogramm)\b/i.test(normalized) || /\b(?:\w+\s+){0,2}(?:kilo|kilogramm)\b/i.test(normalized);
  if (/medikament|behandlung|diagnos|allerg|stationär|krankenhaus|psychisch|zähne|zahnersatz/i.test(question)) return /\b(?:ja|nein|nö|keine?|nicht)\b/i.test(normalized);
  return normalized.length >= 3;
}

function followUpQuestions(question: string, answer: string): string[] {
  if (!/^ja\b/i.test(answer.trim())) return [];
  if (/medikament/i.test(question)) return ["Welche Medikamente nehmen Sie regelmäßig ein?"];
  if (/laufende behandlungen|diagnos/i.test(question)) return ["Um welche Behandlung oder Diagnose geht es genau?"];
  if (/stationär|krankenhaus/i.test(question)) return ["Was war der Grund für den stationären Aufenthalt?", "Wie lange waren Sie im Krankenhaus?", "Sind Sie deswegen heute behandlungs- und beschwerdefrei?"];
  if (/psychisch/i.test(question)) return ["Um welche Behandlung ging es, und sind Sie heute beschwerdefrei?"];
  if (/zähne|zahnersatz/i.test(question)) return ["Was ist aktuell geplant oder offen?"];
  if (/allerg/i.test(question)) return ["Welche Allergie liegt bei Ihnen vor?"];
  return [];
}
export function beginPreparation(
  state: PreparationState,
  confirmedSlotPhrase: string,
  turns: ConversationTurn[],
): PreparationTransition {
  if (state.questions.length === 0) {
    return {
      state: { ...state, stage: "awaiting_email" },
      instruction: `Bestätige nur den Termin ${confirmedSlotPhrase}. Frage danach nur nach der E-Mail-Adresse für die Terminbestätigung.`,
    };
  }
  const firstQuestion = nextUnansweredQuestion(state, turns, 0);
  if (!firstQuestion) {
    return {
      state: { ...state, stage: "awaiting_email" },
      instruction: `Bestätige nur den Termin ${confirmedSlotPhrase}. Die bereits geklärten Angaben reichen für die Vorbereitung. Frage danach nur nach der E-Mail-Adresse für die Terminbestätigung.`,
    };
  }
  return {
    state: { ...state, stage: "awaiting_consent", currentQuestionIndex: undefined },
    instruction: `Bestätige nur den Termin ${confirmedSlotPhrase}. Frage danach exakt: "Für die Vorbereitung würde ich Ihnen noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?"`,
  };
}

export function advancePreparation(
  state: PreparationState,
  userText: string,
  turns: ConversationTurn[],
): PreparationTransition {
  if (state.stage === "awaiting_consent") {
    const consent = preparationConsent(userText);
    if (consent === "declined") {
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: "Akzeptiere die Absage an die Vorbereitungsfragen ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.",
      };
    }
    if (consent === "unknown") {
      return {
        state,
        instruction: "Die Antwort war unklar. Frage freundlich noch einmal nur, ob zwei Minuten für kurze Vorbereitungsfragen passen.",
      };
    }
    const next = nextUnansweredQuestion(state, turns, 0);
    if (!next) {
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: "Die bereits geklärten Angaben reichen für die Vorbereitung. Frage nur noch nach der E-Mail-Adresse für die Terminbestätigung.",
      };
    }
    return {
      state: { ...state, stage: "asking", currentQuestionIndex: next.index },
      instruction: `Stelle ausschließlich diese Vorbereitungsfrage: "${next.question}"`,
    };
  }

  if (state.stage === "asking") {
    if (/^(?:nein|nö|lieber nicht|keine zeit|nicht jetzt|möchte ich nicht(?:s)? beantworten|das möchte ich nicht|will ich nicht)\b/i.test(userText.trim())) {
      const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
      if (next) {
        return {
          state: { ...state, currentQuestionIndex: next.index },
          instruction: `Akzeptiere die Absage freundlich ohne Nachfassen. Stelle ausschließlich die nächste Frage: "${next.question}"`,
        };
      }
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: "Akzeptiere das Nein ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.",
      };
    }
    const currentQuestion = state.questions[state.currentQuestionIndex ?? -1];
    if (currentQuestion && !isAnswerPlausible(currentQuestion, userText)) {
      return {
        state,
        instruction: `Die Antwort passt noch nicht eindeutig zur Frage. Stelle ausschließlich dieselbe Vorbereitungsfrage noch einmal, ohne dich zu bedanken: "${currentQuestion}"`,
      };
    }
    const followUps = currentQuestion ? followUpQuestions(currentQuestion, userText) : [];
    if (followUps.length) {
      const questions = [...state.questions];
      questions.splice((state.currentQuestionIndex ?? -1) + 1, 0, ...followUps);
      return {
        state: { ...state, questions, currentQuestionIndex: (state.currentQuestionIndex ?? -1) + 1 },
        instruction: `Bedanke dich knapp und stelle ausschließlich die nächste Vorbereitungsfrage: "${followUps[0]}"`,
      };
    }
    const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
    if (next) {
      return {
        state: { ...state, currentQuestionIndex: next.index },
        instruction: `Bedanke dich knapp und stelle ausschließlich die nächste Vorbereitungsfrage: "${next.question}"`,
      };
    }
    return {
      state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
      instruction: "Die Vorbereitungsfragen sind vollständig. Sage nur kurz: Danke, das hilft Herrn Duic bei der Vorbereitung. Frage danach ausschließlich nach der E-Mail-Adresse für die Terminbestätigung.",
    };
  }


  if (state.stage === "awaiting_email") {
    if (!/@|\b(?:at|punkt)\b/i.test(userText)) {
      return { state, instruction: "Frage ausschließlich noch einmal nach der E-Mail-Adresse für die Terminbestätigung." };
    }
    return {
      state: { ...state, stage: "completed", currentQuestionIndex: undefined },
      instruction: "Bedanke dich einmal kurz für die E-Mail-Adresse, verabschiede dich freundlich und rufe danach end_call auf. Stelle keine weitere Frage.",
    };
  }
  if (state.stage === "completed" || state.stage === "declined") {
    return {
      state: { ...state, stage: "completed", currentQuestionIndex: undefined },
      instruction: "Keine weitere Antwort erforderlich. Warte auf das Gesprächsende.",
    };
  }

  return {
    state,
    instruction: "Antworte kurz und situativ.",
  };
}