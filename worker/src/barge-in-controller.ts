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
}): BargeInPlan {
  if (!params.responseActive && !params.playbackPending) {
    return { interrupted: false, clearTelnyxPlayback: false, openAiEvents: [] };
  }

  const openAiEvents: Array<Record<string, unknown>> = [];
  if (params.responseActive) openAiEvents.push({ type: "response.cancel" });
  if (params.assistantItemId) {
    openAiEvents.push({
      type: "conversation.item.truncate",
      item_id: params.assistantItemId,
      content_index: 0,
      audio_end_ms: Math.max(0, Math.round(params.audioEndMs)),
    });
  }

  return {
    interrupted: true,
    clearTelnyxPlayback: params.playbackPending,
    openAiEvents,
  };
}