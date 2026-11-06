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

export function detectTopicKind(topic?: string): TopicKind {
  const value = (topic || "").toLowerCase();
  if (/pkv|kranken|gkv|beitr/.test(value)) return "pkv";
  if (/gewerb|haftpflicht|cyber|inhalt|sachversicher|risikoschutz/.test(value)) return "commercial";
  if (/strom|gas|energie/.test(value)) return "energy";
  if (/bav|altersvorsorge|rente|pension/.test(value)) return "retirement";
  return "generic";
}

export function createVoiceProfile(topic?: string): VoiceProfile {
  const topicKind = detectTopicKind(topic);
  const mode = (process.env.GLORIA_VOICE_MODE || "balanced").toLowerCase();

  const base: Record<TopicKind, VoiceProfile> = {
    pkv: {
      profileName: "human_warm_consultative",
      stability: 0.38,
      similarity: 0.84,
      style: 0.36,
      speed: 0.96,
      speakerBoost: true,
      segmentPauseMs: 120,
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
