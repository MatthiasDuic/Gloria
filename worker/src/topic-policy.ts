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
    };
  }

  return {
    topicKind,
    stage: "opener",
    insuranceKnown: false,
    contributionKnown: false,
    projectionDelivered: false,
    interestConfirmed: false,
  };
}

export function createVoiceProfile(topic?: string): VoiceProfile {
  const topicKind = detectTopicKind(topic);
  const mode = (process.env.GLORIA_VOICE_MODE || "balanced").toLowerCase();

  const base: Record<TopicKind, VoiceProfile> = {
    pkv: {
      profileName: "warm_consultative",
      stability: 0.4,
      similarity: 0.9,
      style: 0.42,
      speed: 0.91,
      speakerBoost: true,
      segmentPauseMs: 90,
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

  if (mode === "warm") {
    selected.stability = Math.max(0.34, selected.stability - 0.04);
    selected.style = Math.min(0.55, selected.style + 0.06);
    selected.speed = Math.max(0.88, selected.speed - 0.02);
    selected.segmentPauseMs += 20;
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

  if (hasContributionSignal(text)) {
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

  if (/zehn\s+jahr|10\s+jahr|hochrechn|projektion|beitragsprognose|vier\s+prozent\s+pro\s+jahr|4\s*%\s+pro\s+jahr/i.test(text)) {
    next.projectionDelivered = true;
    if (next.topicKind === "pkv" && next.stage === "need_projection") next.stage = "need_interest";
    next.lastAssistantSignal = "projection";
  }

  if (/w[äa]re\s+.*hilfreich|sinnvoll\s+f[üu]r\s+sie|grunds[äa]tzlich\s+hilfreich/i.test(text)) {
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
