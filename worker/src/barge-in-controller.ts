export type BargeInPlan = {
  interrupted: boolean;
  clearTelnyxPlayback: boolean;
  openAiEvents: Array<Record<string, unknown>>;
};

export function planBargeIn(params: {
  responseActive: boolean;
  playbackPending: boolean;
  assistantItemId?: string;
  audioEndMs: number;
  assistantAudioBytes?: number;
  bytesPerMillisecond?: number;
}): BargeInPlan {
  if (!params.responseActive && !params.playbackPending) {
    return { interrupted: false, clearTelnyxPlayback: false, openAiEvents: [] };
  }

  const openAiEvents: Array<Record<string, unknown>> = [];
  if (params.responseActive) openAiEvents.push({ type: "response.cancel" });
  if (params.assistantItemId) {
    const maxAudioEndMs = typeof params.assistantAudioBytes === "number"
      ? params.assistantAudioBytes / (params.bytesPerMillisecond ?? 8)
      : undefined;
    openAiEvents.push({
      type: "conversation.item.truncate",
      item_id: params.assistantItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(
        maxAudioEndMs === undefined ? params.audioEndMs : Math.min(params.audioEndMs, maxAudioEndMs),
      )),
    });
  }

  return {
    interrupted: true,
    clearTelnyxPlayback: params.playbackPending,
    openAiEvents,
  };
}