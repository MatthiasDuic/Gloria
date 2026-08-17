import type { ConversationTurn } from "./pkv-conversation-controller.js";

export type PreparationPolicy = {
  topic?: string;
  requiredQuestions?: string;
  requiredData?: string;
  pkvHealthQuestions?: string;
};

export type PreparationStage = "inactive" | "awaiting_consent" | "asking" | "completed" | "declined";

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

export function beginPreparation(
  state: PreparationState,
  confirmedSlotPhrase: string,
  turns: ConversationTurn[],
): PreparationTransition {
  if (state.questions.length === 0) {
    return {
      state: { ...state, stage: "completed" },
      instruction: `Bestätige nur den Termin ${confirmedSlotPhrase}. Frage danach nur nach der E-Mail-Adresse für die Terminbestätigung.`,
    };
  }
  const firstQuestion = nextUnansweredQuestion(state, turns, 0);
  if (!firstQuestion) {
    return {
      state: { ...state, stage: "completed" },
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
        state: { ...state, stage: "declined", currentQuestionIndex: undefined },
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
        state: { ...state, stage: "completed", currentQuestionIndex: undefined },
        instruction: "Die bereits geklärten Angaben reichen für die Vorbereitung. Frage nur noch nach der E-Mail-Adresse für die Terminbestätigung.",
      };
    }
    return {
      state: { ...state, stage: "asking", currentQuestionIndex: next.index },
      instruction: `Stelle ausschließlich diese Vorbereitungsfrage: "${next.question}"`,
    };
  }

  if (state.stage === "asking") {
    if (preparationConsent(userText) === "declined") {
      return {
        state: { ...state, stage: "declined", currentQuestionIndex: undefined },
        instruction: "Akzeptiere das Nein ohne Nachfassen. Sage kurz, dass Herr Duic die offenen Punkte im Termin klärt, und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.",
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
      state: { ...state, stage: "completed", currentQuestionIndex: undefined },
      instruction: "Die Vorbereitungsfragen sind vollständig. Bedanke dich kurz und frage dann nur nach der E-Mail-Adresse für die Terminbestätigung.",
    };
  }

  if (state.stage === "completed" || state.stage === "declined") {
    return {
      state: { ...state, stage: "completed", currentQuestionIndex: undefined },
      instruction: "Bedanke dich kurz für die Angabe und bestätige, dass die Vorbereitung für den Termin abgeschlossen ist. Stelle keine weitere Frage.",
    };
  }

  return {
    state,
    instruction: "Antworte kurz und situativ.",
  };
}