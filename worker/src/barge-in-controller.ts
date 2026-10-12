export type BargeInPlan = {
  interrupted: boolean;
  clearTelnyxPlayback: boolean;
  openAiEvents: Array<Record<string, unknown>>;
};

export function planBargeIn(params: {
  responseActive: boolean;
  playbackPending: boolean;
}): BargeInPlan {
  if (!params.responseActive && !params.playbackPending) {
    return { interrupted: false, clearTelnyxPlayback: false, openAiEvents: [] };
  }

  const openAiEvents: Array<Record<string, unknown>> = [];
  if (params.responseActive) openAiEvents.push({ type: "response.cancel" });

  return {
    interrupted: true,
    clearTelnyxPlayback: params.playbackPending,
    openAiEvents,
  };
}