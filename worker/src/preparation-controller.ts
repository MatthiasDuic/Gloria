import type { ConversationTurn } from "./pkv-conversation-controller.js";


export const FINAL_FAREWELL_TEXT = "Vielen Dank für das Gespräch. Auf Wiederhören.";

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

export type PreparationStage = "inactive" | "awaiting_consent" | "asking" | "awaiting_email" | "awaiting_final_questions" | "completed" | "declined";

export type PreparationState = {
  stage: PreparationStage;
  questions: string[];
  currentQuestionIndex?: number;
  consentRetryCount?: number;
  questionRetryCount?: number;
};

export type PreparationTransition = {
  state: PreparationState;
  instruction: string;
};

const PKV_FALLBACK_QUESTIONS = [
  "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
  "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
  "Wie hoch ist Ihr derzeitiger Monatsbeitrag in der Krankenversicherung?",
  "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
  "Gibt es aktuell laufende Behandlungen?",
  "Gibt es bestehende Diagnosen, die wir berücksichtigen sollten?",
].join("\n");

export function buildPreparationQuestions(policy: PreparationPolicy | null): string[] {
  const isPkv = /private\s+krankenversicherung|pkv/i.test(policy?.topic || "");
  if (isPkv) return PKV_FALLBACK_QUESTIONS.split("\n");
  const source = isPkv
    ? policy?.pkvHealthQuestions || policy?.requiredQuestions || policy?.requiredData || PKV_FALLBACK_QUESTIONS
    : policy?.requiredQuestions || policy?.requiredData || "";
  const questions = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3);
  return questions;
}

export function createPreparationState(policy: PreparationPolicy | null = null): PreparationState {
  return {
    stage: "inactive",
    questions: buildPreparationQuestions(policy),
    consentRetryCount: 0,
    questionRetryCount: 0,
  };
}

function preparationConsent(text: string): "granted" | "declined" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (/^(?:ja\b|gerne\b|klar\b|okay\b|ok\b|passt\b|in ordnung\b|machen wir\b)/i.test(normalized)) return "granted";
  if (/^(?:nein\b|nö\b|lieber nicht|keine zeit|nicht jetzt|später|möchte ich nicht|das möchte ich nicht|will ich nicht)/i.test(normalized)) return "declined";
  return "unknown";
}

function isQuestionAlreadyAnswered(question: string, turns: ConversationTurn[]): boolean {
  const userText = turns.filter((turn) => turn.role === "user").map((turn) => turn.text).join(" ");
  if (/privat\s+oder\s+gesetzlich|versicherungsstatus/i.test(question)) return /\b(?:privat|gesetzlich|pkv|gkv)\b/i.test(userText);
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
  if (/privat\s+oder\s+gesetzlich/i.test(question)) return /\b(?:privat|gesetzlich|pkv|gkv)\b/i.test(normalized);
  if (/krankenversicherer/i.test(question)) return normalized.length >= 3 && !/^(?:ja|nein|nö|keine?|nicht)[.!?\s]*$/i.test(normalized);
  if (/monatsbeitrag/i.test(question)) return /\b(?:\d{2,5}(?:[.,]\d{1,2})?\s*(?:euro|€)|(?:hundert|tausend|eintausend|zweitausend)[a-zäöüß-]*\s+euro)\b/i.test(normalized);
  if (/geburtsdatum/i.test(question)) return /\b\d{1,2}[.\s]+(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)[.\s,]+(?:19|20)\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b/i.test(normalized);
  if (/behandlung|diagnos/i.test(question)) return /\b(?:ja|nein|nö|keine?|nicht)\b/i.test(normalized);
  return normalized.length >= 3;
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
    state: {
      ...state,
      stage: "awaiting_consent",
      currentQuestionIndex: undefined,
      consentRetryCount: 0,
      questionRetryCount: 0,
    },
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
      const retries = (state.consentRetryCount || 0) + 1;
      if (retries >= 2) {
        return {
          state: { ...state, consentRetryCount: retries },
          instruction: "Die Antwort blieb unklar. Frage exakt: 'Ist es für Sie in Ordnung: ja oder nein?' Stelle keine weitere Frage.",
        };
      }
      return {
        state: { ...state, consentRetryCount: retries },
        instruction: "Die Antwort war unklar. Sage nur noch einmal: 'Sind zwei Minuten für kurze Vorbereitungsfragen in Ordnung?' Stelle keine andere Frage.",
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
      state: {
        ...state,
        stage: "asking",
        currentQuestionIndex: next.index,
        consentRetryCount: 0,
        questionRetryCount: 0,
      },
      instruction: `Sage keine Einleitung und stelle ausschließlich diese eine Vorbereitungsfrage: "${next.question}". Warte danach vollständig auf die Antwort.`,
    };
  }

  if (state.stage === "asking") {
    if (/^(?:lieber nicht|keine zeit|nicht jetzt|möchte ich nicht(?:s)? beantworten|das möchte ich nicht|will ich nicht)\b/i.test(userText.trim())) {
      const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
      if (next) {
        return {
          state: { ...state, currentQuestionIndex: next.index, questionRetryCount: 0 },
          instruction: `Akzeptiere die Absage freundlich in höchstens einem kurzen Satz. Stelle danach ausschließlich diese eine nächste Frage: "${next.question}".`,
        };
      }
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: "Akzeptiere das Nein ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.",
      };
    }
    const currentQuestion = state.questions[state.currentQuestionIndex ?? -1];
    if (currentQuestion && !isAnswerPlausible(currentQuestion, userText)) {
      const retries = (state.questionRetryCount || 0) + 1;
      if (retries >= 2) {
        return {
          state: { ...state, questionRetryCount: retries },
          instruction: `Die Antwort bleibt unklar. Stelle dieselbe Frage noch einmal, aber mit Antwortformat-Hinweis: "${currentQuestion}" und ergänze kurz "Bitte kurz mit Ja oder Nein oder mit einem konkreten Wert antworten."`,
        };
      }
      return {
        state: { ...state, questionRetryCount: retries },
        instruction: `Die Antwort passt noch nicht eindeutig zur Frage. Stelle ausschließlich dieselbe Vorbereitungsfrage noch einmal, ohne dich zu bedanken: "${currentQuestion}"`,
      };
    }
    const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
    if (next) {
      return {
        state: { ...state, currentQuestionIndex: next.index, questionRetryCount: 0 },
        instruction: `Stelle ausschließlich diese eine Vorbereitungsfrage: "${next.question}". Warte danach vollständig auf die Antwort.`,
      };
    }
    return {
      state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
      instruction: "Die Vorbereitungsfragen sind vollständig. Frage danach ausschließlich nach der E-Mail-Adresse für die Terminbestätigung.",
    };
  }


  if (state.stage === "awaiting_email") {
    const hasAtIndicator = /@|\bat\b/i.test(userText);
    const hasDotIndicator = /\.|\bpunkt\b|\bdot\b/i.test(userText);
    if (!hasAtIndicator || !hasDotIndicator) {
      return { state, instruction: "Frage ausschließlich noch einmal nach der E-Mail-Adresse für die Terminbestätigung." };
    }
    return {
      state: { ...state, stage: "awaiting_final_questions", currentQuestionIndex: undefined },
      instruction: "Nimm die E-Mail-Adresse an und frage dann genau einmal: 'Haben Sie noch eine Frage zum Ablauf oder zum Termin?' Stelle sonst nichts.",
    };
  }

  if (state.stage === "awaiting_final_questions") {
    const normalized = userText.trim().toLowerCase();
    const noMoreQuestions = /\b(?:nein\b|ne\b|n[öo]\b|keine\s+frage|keine\s+fragen|nichts\s+mehr|passt\s+so|alles\s+klar|das\s+war\s+alles|wir\s+k[öo]nnen\s+das\s+gespr[äa]ch\s+beenden|gespr[äa]ch\s+beenden|keine\s+zeit\s+mehr|ich\s+habe\s+keine\s+zeit\s+mehr)\b/i.test(normalized);
    const hasQuestion = /\?|\b(?:wer|wie|was|warum|wieso|weshalb|wann|wo|welche[rmn]?)\b/i.test(normalized);

    if (noMoreQuestions) {
      return {
        state: { ...state, stage: "completed", currentQuestionIndex: undefined },
        instruction: `Da der Kunde keine Zeit mehr hat, nehme ich die wichtigsten Gesundheitsfragen in die Terminbestätigung per Mail auf und schließe das Gespräch ab. Sage exakt: '${FINAL_FAREWELL_TEXT}' Danach rufe end_call auf. Keine weitere Rückfrage.`,
      };
    }

    if (hasQuestion) {
      return {
        state,
        instruction: "Beantworte die Frage kurz und konkret. Wenn Details besser in den Termin gehören, sage transparent, dass Herr Duic diesen Punkt in der Terminvorbereitung aufnimmt und im Termin beantwortet. Frage danach nur: 'Gibt es noch eine weitere Frage?'",
      };
    }

    return {
      state,
      instruction: "Wenn unklar, frage kurz nach: 'Haben Sie noch eine Frage, oder sollen wir das Gespräch beenden?'",
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