export type TopicKind = "pkv" | "commercial" | "energy" | "retirement" | "generic";

export type VoiceProfile = {
  profileName: string;
  stability: number;
  similarity: number;
  style: number;
  speed: number;
  speakerBoost: boolean;
  segmentPauseMs: number;
};

export type PkvConversationData = {
  insuranceStatus?: "pkv" | "gkv";
  startingContribution?: number;
  currentContribution?: number;
  interest?: "positive" | "negative" | "unclear";
  appointmentPreference?: "morning" | "afternoon";
};

export type CallFlowState = {
  topicKind: TopicKind;
  stage:
    | "opener"
    | "need_relevance"
    | "need_insurance"
    | "need_contribution"
    | "need_projection"
    | "need_interest"
    | "ready_for_schedule"
    | "scheduling"
    | "post_booking";
  insuranceKnown: boolean;
  contributionKnown: boolean;
  projectionDelivered: boolean;
  interestConfirmed: boolean;
  pkvData: PkvConversationData;
  awaiting:
    | "relevance"
    | "starting_contribution"
    | "concept_interest"
    | "insurance_status"
    | "current_contribution"
    | "projection_interest"
    | "appointment_preference"
    | "appointment_selection"
    | undefined;
  lastUserSignal?: string;
  lastAssistantSignal?: string;
};

export function detectTopicKind(topic?: string): TopicKind {
  const value = (topic || "").toLowerCase();
  if (/pkv|kranken|gkv|beitr/.test(value)) return "pkv";
  if (/gewerb|haftpflicht|cyber|inhalt|sachversicher|risikoschutz/.test(value)) return "commercial";
  if (/strom|gas|energie/.test(value)) return "energy";
  if (/bav|altersvorsorge|rente|pension/.test(value)) return "retirement";
  return "generic";
}

export function createInitialFlowState(topic?: string): CallFlowState {
  const topicKind = detectTopicKind(topic);
  if (topicKind === "pkv") {
    return {
      topicKind,
      stage: "need_relevance",
      insuranceKnown: false,
      contributionKnown: false,
      projectionDelivered: false,
      interestConfirmed: false,
      pkvData: {},
      awaiting: "relevance",
    };
  }

  return {
    topicKind,
    stage: "opener",
    insuranceKnown: false,
    contributionKnown: false,
    projectionDelivered: false,
    interestConfirmed: false,
    pkvData: {},
    awaiting: undefined,
  };
}

export function createVoiceProfile(topic?: string): VoiceProfile {
  const topicKind = detectTopicKind(topic);
  const mode = (process.env.GLORIA_VOICE_MODE || "balanced").toLowerCase();

  const base: Record<TopicKind, VoiceProfile> = {
    pkv: {
      profileName: "human_warm_consultative",
      stability: 0.27,
      similarity: 0.86,
      style: 0.62,
      speed: 0.9,
      speakerBoost: false,
      segmentPauseMs: 180,
    },
    commercial: {
      profileName: "confident_structured",
      stability: 0.44,
      similarity: 0.9,
      style: 0.34,
      speed: 0.92,
      speakerBoost: true,
      segmentPauseMs: 80,
    },
    energy: {
      profileName: "clear_brisk",
      stability: 0.46,
      similarity: 0.88,
      style: 0.28,
      speed: 0.94,
      speakerBoost: true,
      segmentPauseMs: 70,
    },
    retirement: {
      profileName: "calm_advisory",
      stability: 0.43,
      similarity: 0.9,
      style: 0.36,
      speed: 0.9,
      speakerBoost: true,
      segmentPauseMs: 90,
    },
    generic: {
      profileName: "balanced_professional",
      stability: 0.42,
      similarity: 0.9,
      style: 0.32,
      speed: 0.92,
      speakerBoost: true,
      segmentPauseMs: 80,
    },
  };

  const selected = { ...base[topicKind] };

  if (mode === "warm" || mode === "human") {
    selected.stability = Math.max(0.34, selected.stability - 0.04);
    selected.style = Math.min(0.72, selected.style + 0.04);
    selected.speed = Math.max(0.86, selected.speed - 0.01);
    selected.segmentPauseMs += 25;
    selected.profileName = `${selected.profileName}_warm`;
  } else if (mode === "crisp") {
    selected.stability = Math.min(0.52, selected.stability + 0.04);
    selected.style = Math.max(0.22, selected.style - 0.04);
    selected.speed = Math.min(0.97, selected.speed + 0.02);
    selected.segmentPauseMs = Math.max(55, selected.segmentPauseMs - 15);
    selected.profileName = `${selected.profileName}_crisp`;
  }

  return selected;
}

export function observeUserFlowState(state: CallFlowState, userText: string): CallFlowState {
  const text = userText.toLowerCase();
  const next = { ...state };

  if (next.topicKind === "pkv") {
    const amount = parseGermanEuroAmount(text);
    if (next.awaiting === "starting_contribution" && amount !== undefined) {
      next.pkvData = { ...next.pkvData, startingContribution: amount };
      next.lastUserSignal = "starting_contribution";
    }
    if (next.awaiting === "current_contribution" && amount !== undefined) {
      next.pkvData = { ...next.pkvData, currentContribution: amount };
      next.contributionKnown = true;
      next.lastUserSignal = "current_contribution";
    }
    if (next.awaiting === "insurance_status") {
      if (/\b(?:privat|pkv)\b/i.test(text)) {
        next.pkvData = { ...next.pkvData, insuranceStatus: "pkv" };
        next.insuranceKnown = true;
        next.awaiting = "current_contribution";
      } else if (/\b(?:gesetzlich|gkv)\b/i.test(text)) {
        next.pkvData = { ...next.pkvData, insuranceStatus: "gkv" };
        next.insuranceKnown = true;
        next.awaiting = "current_contribution";
      }
    }
    if (next.awaiting === "current_contribution" && amount !== undefined) {
      next.awaiting = "projection_interest";
    }
    if (next.awaiting === "projection_interest") {
      if (/\b(?:ja|gern|gerne|hilfreich|interessant|passt|okay|ok)\b/i.test(text)) {
        next.pkvData = { ...next.pkvData, interest: "positive" };
        next.interestConfirmed = true;
      } else if (/\b(?:nein|n[öo]|eher nicht|kein interesse)\b/i.test(text)) {
        next.pkvData = { ...next.pkvData, interest: "negative" };
        next.interestConfirmed = false;
      } else {
        next.pkvData = { ...next.pkvData, interest: "unclear" };
      }
    }
    if (next.awaiting === "appointment_preference") {
      if (/vormittag|morgens|fr[üu]h/i.test(text)) {
        next.pkvData = { ...next.pkvData, appointmentPreference: "morning" };
      } else if (/nachmittag|mittags|sp[äa]ter/i.test(text)) {
        next.pkvData = { ...next.pkvData, appointmentPreference: "afternoon" };
      }
    }
  }

  if (/\b(normal|schon normal|ist ja auch normal|hoechstbeitrag|höchstbeitrag)\b/i.test(text)) {
    next.lastUserSignal = "normalized_risk";
    if (next.topicKind === "pkv" && next.stage === "need_relevance") next.stage = "need_insurance";
  }

  if (/was\s+hab\s+ich\s+davon|was\s+bringt\s+mir|warum\s+sollte\s+ich\s+einen\s+termin\s+machen|welchen\s+vorteil/i.test(text)) {
    next.lastUserSignal = "value_request";
  }

  if (/per\s+mail|e-?mail|schicken\s+sie\s+mir|senden\s+sie\s+mir|uebersicht\s+per\s+mail|übersicht\s+per\s+mail/i.test(text)) {
    next.lastUserSignal = "email_request";
  }

  if (/\b(privat(?:e[nrsm]?\s+krankenversicherung)?|pkv|gesetzlich(?:e[nrsm]?\s+krankenversicherung)?|gkv)\b/i.test(text)) {
    next.insuranceKnown = true;
    if (next.topicKind === "pkv" && (next.stage === "need_relevance" || next.stage === "need_insurance")) next.stage = "need_contribution";
    next.lastUserSignal = "insurance";
  }

  if (hasContributionSignal(text) && next.lastAssistantSignal === "current_contribution_question") {
    next.contributionKnown = true;
    if (next.topicKind === "pkv" && (next.stage === "need_insurance" || next.stage === "need_contribution")) {
      next.stage = "need_projection";
    }
    next.lastUserSignal = "contribution";
  }

  if (/\b(ja|gern|gerne|hilfreich|interessant|macht\s+sinn|klingt\s+gut|ok|okay|passt)\b/i.test(text)) {
    if (next.topicKind === "pkv" && next.stage === "need_interest") {
      next.interestConfirmed = true;
      next.stage = "ready_for_schedule";
      next.lastUserSignal = "interest_confirmed";
    }
  }

  if (/\b(vormittag|nachmittag|dienstag|mittwoch|donnerstag|freitag|montag|uhr)\b/i.test(text)) {
    next.stage = next.stage === "post_booking" ? "post_booking" : "scheduling";
    next.lastUserSignal = "schedule_preference";
  }

  return next;
}

export function observeAssistantFlowState(state: CallFlowState, assistantText: string): CallFlowState {
  const text = assistantText.toLowerCase();
  const next = { ...state };

  if (next.topicKind === "pkv") {
    if (/mit welchem Beitrag.*angefangen|gestartet/i.test(text)) {
      next.awaiting = "starting_contribution";
    } else if (/wie stark sp[üu]ren|wie erleben Sie.*Beitragsentwicklung/i.test(text)) {
      next.awaiting = "relevance";
    } else if (/privat oder gesetzlich|gesetzlich oder privat/i.test(text)) {
      next.awaiting = "insurance_status";
    } else if (/aktuellen? Monatsbeitrag|derzeitigen? Monatsbeitrag|wie hoch.*Beitrag/i.test(text)) {
      next.awaiting = "current_contribution";
    } else if (/Zehn-Jahres-Prognose.*hilfreich|Beitragsprognose.*hilfreich|echter\s+Mehrwert|diese\s+Klarheit/i.test(text)) {
      next.awaiting = "projection_interest";
    } else if (/Vormittag.*oder.*Nachmittag/i.test(text)) {
      next.awaiting = "appointment_preference";
    } else if (/Wie wäre es mit .* oder /i.test(text)) {
      next.awaiting = "appointment_selection";
    }
  }

  const isCurrentContributionQuestion = /(?:aktuell\w*|derzeit\w*|heutig\w*)\s+(?:monatlich\w*\s+)?beitrag|monatsbeitrag|wie\s+hoch[^.?!]{0,30}beitrag/i.test(text);
  if (!isCurrentContributionQuestion && /zehn\s+jahr|10\s+jahr|hochrechn|projektion|beitragsprognose|vier\s+prozent\s+pro\s+jahr|4\s*%\s+pro\s+jahr/i.test(text)) {
    next.projectionDelivered = true;
    if (next.topicKind === "pkv" && next.stage === "need_projection") next.stage = "need_interest";
    next.lastAssistantSignal = "projection";
  }

  if (/w[äa]re\s+.*hilfreich|sinnvoll\s+f[üu]r\s+sie|grunds[äa]tzlich\s+hilfreich|echter\s+Mehrwert|diese\s+Klarheit/i.test(text)) {
    if (next.topicKind === "pkv" && next.stage === "need_projection") next.stage = "need_interest";
    next.lastAssistantSignal = "interest_question";
  }

  if (/\b(vormittag|nachmittag|welcher\s+tag|wann\s+passt|terminvorschlag|termin\s+am)\b/i.test(text)) {
    next.stage = next.stage === "post_booking" ? "post_booking" : "scheduling";
    next.lastAssistantSignal = "scheduling";
  }

  if (/f[üu]r\s+die\s+vorbereitung|e-?mail-adresse|terminbest[äa]tigung/i.test(text)) {
    next.stage = "post_booking";
    next.lastAssistantSignal = "post_booking";
  }

  if (/(?:aktuell\w*|derzeit\w*|heutig\w*)\s+(?:monatlich\w*\s+)?beitrag|monatsbeitrag|gr[öo]ßenordnung[^.?!]{0,30}(?:aktuell|heute|monat)|wie\s+hoch[^.?!]{0,30}beitrag/i.test(text)) {
    next.lastAssistantSignal = "current_contribution_question";
  }

  return next;
}

export function canScheduleFromFlow(state: CallFlowState): boolean {
  if (state.topicKind !== "pkv") return true;
  return state.insuranceKnown && state.contributionKnown && state.projectionDelivered && state.interestConfirmed;
}

function hasContributionSignal(text: string): boolean {
  if (/\b(?:\d{2,5}(?:[.,:]\d{1,2})?)\b[^\n.?!]{0,16}\b(?:euro|€)\b/i.test(text)) return true;
  if (/\b(?:beitrag|kosten|monatlich)\b[^\n.?!]{0,30}\b(?:euro|€|tausend|hundert)\b/i.test(text)) return true;
  if (/\b(?:[a-zäöüß-]*tausend[a-zäöüß-]*|[a-zäöüß-]*hundert[a-zäöüß-]*)\b[^\n.?!]{0,24}\beuro\b/i.test(text)) return true;
  return false;
}

function parseGermanEuroAmount(text: string): number | undefined {
  const direct = text.match(/\b(\d{2,5})(?:[.,]\d{1,2})?\s*(?:euro|€)\b/i);
  if (direct) return Number.parseInt(direct[1], 10);
  const words = text.match(/\b(?:[a-zäöüß-]*tausend[a-zäöüß-]*|[a-zäöüß-]*hundert[a-zäöüß-]*)(?:\s+[a-zäöüß-]+){0,3}/i)?.[0];
  if (!words) return undefined;
  const normalized = words
    .toLowerCase()
    .replace(/\s+euro\b/, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/-/g, "")
    .replace(/\s+/g, "");
  const units: Record<string, number> = { ein: 1, eins: 1, zwei: 2, drei: 3, vier: 4, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9 };
  const tens: Record<string, number> = { zehn: 10, zwanzig: 20, dreissig: 30, vierzig: 40, fuenfzig: 50, sechzig: 60, siebzig: 70, achtzig: 80, neunzig: 90 };
  const parse = (value: string): number | undefined => {
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
    if (value in units) return units[value];
    if (value in tens) return tens[value];
    const thousand = value.indexOf("tausend");
    if (thousand >= 0) return (parse(value.slice(0, thousand) || "ein") || 0) * 1000 + (parse(value.slice(thousand + 7)) || 0);
    const hundred = value.indexOf("hundert");
    if (hundred >= 0) return (parse(value.slice(0, hundred) || "ein") || 0) * 100 + (parse(value.slice(hundred + 7)) || 0);
    const und = value.indexOf("und");
    if (und > 0) return (units[value.slice(0, und)] || 0) + (tens[value.slice(und + 3)] || 0);
    return undefined;
  };
  return parse(normalized);
}
