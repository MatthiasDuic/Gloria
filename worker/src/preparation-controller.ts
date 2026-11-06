import type { ConversationTurn } from "./pkv-conversation-controller.js";
import type { AppointmentMode } from "./appointment-controller.js";


export const FINAL_FAREWELL_TEXT = "Vielen Dank für das Gespräch. Auf Wiederhören.";
const APPOINTMENT_EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9][a-z0-9-]*[a-z0-9](?![a-z0-9-])/i;

export type AppointmentConfirmationOwner = {
  ownerRealName?: string;
  appointmentMode?: AppointmentMode;
};

function appointmentAdvisor(owner: AppointmentConfirmationOwner): string {
  return owner.ownerRealName?.trim() || "Ihre Ansprechperson";
}

function appointmentEmailQuestion(complete = false): string {
  return `Damit Sie die Terminbestätigung per E-Mail erhalten, brauche ich noch Ihre ${complete ? "vollständige " : ""}E-Mail-Adresse.`;
}

// Gloria versendet selbst nichts; der Benutzer schickt die Bestätigung (bei Teams mit Meeting-Link) manuell.
export function appointmentFarewellText(owner: AppointmentConfirmationOwner = {}): string {
  const sender = owner.ownerRealName?.trim() ? ` von ${owner.ownerRealName.trim()}` : "";
  const linkHint = owner.appointmentMode === "Microsoft Teams" ? " Darin ist auch der Link zum Teams-Meeting enthalten." : "";
  return `Vielen Dank für das Gespräch. Der Termin ist eingetragen. Sie erhalten die Terminbestätigung${sender} per E-Mail.${linkHint} Auf Wiederhören.`;
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
  preparationQuestions?: string;
  requiredQuestions?: string;
  requiredData?: string;
  pkvHealthQuestions?: string;
};

export type PreparationStage = "inactive" | "awaiting_consent" | "asking" | "awaiting_email" | "completed" | "declined";

export type PreparationState = {
  stage: PreparationStage;
  questions: string[];
  currentQuestionIndex?: number;
  consentRetryCount?: number;
  questionRetryCount?: number;
  appointmentMode?: AppointmentMode;
};

export type PreparationTransition = {
  state: PreparationState;
  instruction: string;
  speechText?: string;
};

const PKV_FALLBACK_QUESTIONS = [
  "Sind Sie aktuell privat oder gesetzlich krankenversichert?",
  "Bei welchem Krankenversicherer sind Sie derzeit versichert?",
  "Darf ich bitte Ihr Geburtsdatum aufnehmen?",
  "Wie groß sind Sie?",
  "Wie viel wiegen Sie derzeit?",
  "Sind Sie derzeit in Behandlung?",
  "Bestehen bekannte Diagnosen?",
].join("\n");

export function buildPreparationQuestions(policy: PreparationPolicy | null): string[] {
  const isPkv = /private\s+krankenversicherung|pkv/i.test(policy?.topic || "");
  const source = policy?.preparationQuestions || policy?.pkvHealthQuestions
    || (isPkv ? PKV_FALLBACK_QUESTIONS : policy?.requiredQuestions || policy?.requiredData || "");
  const questions = source
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 3 && !/\b(?:e-?mail|terminbestätigung)\b/i.test(line));
  return questions.slice(0, 20);
}

export function createPreparationState(policy: PreparationPolicy | null = null): PreparationState {
  return {
    stage: "inactive",
    questions: buildPreparationQuestions(policy),
    consentRetryCount: 0,
    questionRetryCount: 0,
  };
}

export function createPreparationStateForCall(
  topicKind: "pkv" | "other",
  topic?: string,
  policy?: PreparationPolicy | null,
): PreparationState {
  const hasConfiguredQuestions = Boolean(policy?.preparationQuestions?.trim() || policy?.pkvHealthQuestions?.trim());
  return createPreparationState({
    ...policy,
    topic: topicKind === "pkv" && !hasConfiguredQuestions
      ? "private Krankenversicherung"
      : topic || (topicKind === "pkv" ? "private Krankenversicherung" : undefined),
  });
}

function asksSensitiveInformation(questions: string[]): boolean {
  return questions.some((question) => /\b(?:gesund\w*|diagnos\w*|behandl\w*|medikament\w*|krankenhaus\w*|psych\w*|zahn\w*|allerg\w*|geburtsdatum|gewicht\w*|körpergröße|koerpergroesse|versicherer\w*)/i.test(question));
}

function preparationConsentQuestion(state: PreparationState): string {
  return asksSensitiveInformation(state.questions)
    ? "Für die freiwillige Vorbereitung würde ich Ihnen auch einige persönliche Angaben stellen, darunter Gesundheitsangaben. Sie können jede Frage überspringen. Ist das für Sie in Ordnung?"
    : "Für die freiwillige Vorbereitung würde ich Ihnen noch einige kurze Fragen stellen. Ist das für Sie in Ordnung?";
}

function preparationConsent(text: string): "granted" | "declined" | "unknown" {
  const normalized = text.trim().toLowerCase();
  if (/^(?:ja\b|gerne\b|klar\b|okay\b|ok\b|passt\b|in ordnung\b|machen wir\b)/i.test(normalized)) return "granted";
  if (/\bpasst\b/i.test(normalized) && !/\b(?:passt\s+nicht|nicht\s+passt)\b/i.test(normalized)) return "granted";
  if (/^(?:nein\b|nö\b|lieber nicht|keine zeit|nicht jetzt|später|möchte ich nicht|das möchte ich nicht|will ich nicht)/i.test(normalized)) return "declined";
  return "unknown";
}

function isQuestionAlreadyAnswered(question: string, turns: ConversationTurn[]): boolean {
  const userTurns = turns.filter((turn) => turn.role === "user");
  const userText = userTurns.map((turn) => turn.text).join(" ");
  if (/privat\s+oder\s+gesetzlich|versicherungsstatus/i.test(question)) return /\b(?:privat|gesetzlich|pkv|gkv)\b/i.test(userText);
  if (/krankenversicherer/i.test(question)) {
    return userTurns.some((turn) => {
      if (!/\bversichert\b/i.test(turn.text)) return false;
      const insurer = turn.text.match(/\bbei\s+(?:(?:der|dem)\s+)?([a-zäöüß][a-zäöüß0-9&.-]{2,})\b/i)?.[1];
      return Boolean(insurer && !/^(?:mir|uns|ihnen|euch|hause|ort)$/i.test(insurer));
    });
  }
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
  if (/geburtsdatum/i.test(question)) {
    const day = "(?:\\d{1,2}\\.?|[a-zäöüß-]+(?:te|ter|ten|tes|ste|ster|sten|stes))";
    const month = "(?:januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|\\d{1,2}|[a-zäöüß-]+)";
    const year = "(?:(?:19|20)?\\d{2}|(?:neunzehn|zwanzig)hundert[a-zäöüß-]*|zweitausend[a-zäöüß-]*)";
    return new RegExp(`\\b${day}[.\\s/-]+${month}[.\\s,/-]+${year}\\b`, "i").test(normalized);
  }
  if (/groß|gross|groess/i.test(question)) {
    return /\b(?:\d{2,3}(?:[.,]\d)?\s*(?:cm|zentimeter)?|1[.,]\d{1,2}\s*(?:m|meter)|(?:ein|eins|eine)\s+meter(?:\s+[a-zäöüß-]+)?)\b/i.test(normalized);
  }
  if (/gewicht/i.test(question)) {
    return /\b(?:\d{2,3}(?:[.,]\d)?\s*(?:kg|kilo(?:gramm)?s?)?|[a-zäöüß-]+\s+(?:kg|kilo(?:gramm)?s?))\b/i.test(normalized);
  }
  if (/behandlung|diagnos/i.test(question)) return /\b(?:ja|nein|nö|keine?|nicht)\b/i.test(normalized);
  return normalized.length >= 3;
}
export function beginPreparation(
  initialState: PreparationState,
  confirmedSlotPhrase: string,
  turns: ConversationTurn[],
  appointmentMode?: AppointmentMode,
): PreparationTransition {
  const state: PreparationState = { ...initialState, appointmentMode: appointmentMode ?? initialState.appointmentMode };
  const confirmation = `Der Termin ${confirmedSlotPhrase} ist bestätigt.`;
  const emailQuestion = appointmentEmailQuestion();
  if (state.questions.length === 0) {
    return {
      state: { ...state, stage: "awaiting_email" },
      instruction: `Sage exakt: "${confirmation} ${emailQuestion}"`,
      speechText: `${confirmation} ${emailQuestion}`,
    };
  }
  const firstQuestion = nextUnansweredQuestion(state, turns, 0);
  if (!firstQuestion) {
    return {
      state: { ...state, stage: "awaiting_email" },
      instruction: `Sage exakt: "${confirmation} Die bereits geklärten Angaben reichen für die Vorbereitung. ${emailQuestion}"`,
      speechText: `${confirmation} Die bereits geklärten Angaben reichen für die Vorbereitung. ${emailQuestion}`,
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
    instruction: `Sage exakt: "${confirmation} ${preparationConsentQuestion(state)}"`,
    speechText: `${confirmation} ${preparationConsentQuestion(state)}`,
  };
}

export function advancePreparation(
  state: PreparationState,
  userText: string,
  turns: ConversationTurn[],
  owner: AppointmentConfirmationOwner = {},
): PreparationTransition {
  const emailQuestion = appointmentEmailQuestion();
  const advisor = appointmentAdvisor(owner);
  if (state.stage === "awaiting_consent") {
    const consent = preparationConsent(userText);
    if (consent === "declined") {
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: `Akzeptiere die Absage an die Vorbereitungsfragen ohne Nachfassen. Sage exakt: 'In Ordnung, ${advisor} klärt die offenen Punkte mit Ihnen im Termin. ${emailQuestion}'`,
        speechText: `In Ordnung, ${advisor} klärt die offenen Punkte mit Ihnen im Termin. ${emailQuestion}`,
      };
    }
    if (consent === "unknown") {
      const retries = (state.consentRetryCount || 0) + 1;
      if (retries >= 2) {
        return {
          state: { ...state, consentRetryCount: retries },
          instruction: "Die Antwort blieb unklar. Frage exakt: 'Ist es für Sie in Ordnung: ja oder nein?' Stelle keine weitere Frage.",
          speechText: "Ist es für Sie in Ordnung: ja oder nein?",
        };
      }
      return {
        state: { ...state, consentRetryCount: retries },
        instruction: "Die Antwort war unklar. Sage nur noch einmal: 'Sind zwei Minuten für kurze Vorbereitungsfragen in Ordnung?' Stelle keine andere Frage.",
        speechText: "Sind zwei Minuten für kurze Vorbereitungsfragen in Ordnung?",
      };
    }
    const next = nextUnansweredQuestion(state, turns, 0);
    if (!next) {
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: `Die bereits geklärten Angaben reichen für die Vorbereitung. Sage exakt: '${emailQuestion}'`,
        speechText: `Die bereits geklärten Angaben reichen für die Vorbereitung. ${emailQuestion}`,
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
      speechText: next.question,
    };
  }

  if (state.stage === "asking") {
    if (/^(?:lieber nicht|keine zeit|nicht jetzt|möchte ich nicht(?:s)? beantworten|das möchte ich nicht|will ich nicht)\b/i.test(userText.trim())) {
      const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
      if (next) {
        return {
          state: { ...state, currentQuestionIndex: next.index, questionRetryCount: 0 },
          instruction: `Akzeptiere die Absage freundlich in höchstens einem kurzen Satz. Stelle danach ausschließlich diese eine nächste Frage: "${next.question}".`,
          speechText: `In Ordnung. ${next.question}`,
        };
      }
      return {
        state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
        instruction: `Akzeptiere das Nein ohne Nachfassen. Sage exakt: 'In Ordnung, ${advisor} klärt die offenen Punkte mit Ihnen im Termin. ${emailQuestion}'`,
        speechText: `In Ordnung, ${advisor} klärt die offenen Punkte mit Ihnen im Termin. ${emailQuestion}`,
      };
    }
    const currentQuestion = state.questions[state.currentQuestionIndex ?? -1];
    if (currentQuestion && !isAnswerPlausible(currentQuestion, userText)) {
      const retries = (state.questionRetryCount || 0) + 1;
      if (retries >= 3) {
        const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
        if (next) {
          return {
            state: { ...state, currentQuestionIndex: next.index, questionRetryCount: 0 },
            instruction: `Die Angabe blieb unklar. Überspringe diese Frage ohne weiteres Nachhaken und stelle ausschließlich die nächste Frage: "${next.question}".`,
            speechText: `Das überspringen wir. ${next.question}`,
          };
        }
        return {
          state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined, questionRetryCount: 0 },
          instruction: "Die letzte Angabe blieb unklar. Frage jetzt nach der E-Mail-Adresse für die Terminbestätigung.",
          speechText: emailQuestion,
        };
      }
      if (retries >= 2) {
        return {
          state: { ...state, questionRetryCount: retries },
          instruction: `Die Antwort bleibt unklar. Stelle dieselbe Frage noch einmal, aber mit Antwortformat-Hinweis: "${currentQuestion}" und ergänze kurz "Bitte kurz mit Ja oder Nein oder mit einem konkreten Wert antworten."`,
          speechText: `${currentQuestion} Bitte kurz mit Ja oder Nein oder mit einem konkreten Wert antworten.`,
        };
      }
      return {
        state: { ...state, questionRetryCount: retries },
        instruction: `Die Antwort passt noch nicht eindeutig zur Frage. Stelle ausschließlich dieselbe Vorbereitungsfrage noch einmal, ohne dich zu bedanken: "${currentQuestion}"`,
        speechText: currentQuestion,
      };
    }
    const next = nextUnansweredQuestion(state, turns, (state.currentQuestionIndex ?? -1) + 1);
    if (next) {
      return {
        state: { ...state, currentQuestionIndex: next.index, questionRetryCount: 0 },
        instruction: `Stelle ausschließlich diese eine Vorbereitungsfrage: "${next.question}". Warte danach vollständig auf die Antwort.`,
        speechText: next.question,
      };
    }
    return {
      state: { ...state, stage: "awaiting_email", currentQuestionIndex: undefined },
      instruction: `Die Vorbereitungsfragen sind vollständig. Sage danach exakt: '${emailQuestion}' Stelle keine weitere Frage.`,
      speechText: emailQuestion,
    };
  }


  if (state.stage === "awaiting_email") {
    if (!APPOINTMENT_EMAIL_PATTERN.test(userText)) {
      const completeEmailQuestion = appointmentEmailQuestion(true);
      return {
        state,
        instruction: `Sage ausschließlich: '${completeEmailQuestion}'`,
        speechText: completeEmailQuestion,
      };
    }
    const farewell = appointmentFarewellText({ ...owner, appointmentMode: state.appointmentMode ?? owner.appointmentMode });
    return {
      state: { ...state, stage: "completed", currentQuestionIndex: undefined },
      instruction: `Nimm die E-Mail-Adresse an. Sage exakt: '${farewell}' Danach rufe end_call auf. Stelle keine weitere Frage.`,
      speechText: farewell,
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