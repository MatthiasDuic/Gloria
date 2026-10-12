export type ReportTranscriptEntry = {
  role?: "user" | "assistant";
  speaker?: string;
  text?: string;
};

export type ReportTranscriptTurn = {
  speaker: "Gloria" | "Interessent";
  text: string;
};

export function buildReportTranscriptFallback(entries: ReportTranscriptEntry[] | undefined): string {
  const lines = (entries || []).flatMap((entry) => {
    const text = entry.text?.trim();
    if (!text) return [];
    const speaker = entry.speaker === "Gloria" || entry.role === "assistant" ? "Gloria" : "Interessent";
    return [`${speaker}: ${text}`];
  });
  return lines.length ? `--- GESPRAECHSPROTOKOLL (Fallback ohne Latenzdaten) ---\n${lines.join("\n")}` : "";
}

export function parseReportTranscriptFallback(summary: string): ReportTranscriptTurn[] {
  return summary
    .split("\n")
    .map((line) => line.trim().match(/^(?:-\s*)?(?:\[[^\]]+\]\s*)?(Gloria|Interessent)(?:\s*\([^)]*\))?:\s*(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      speaker: match[1] as ReportTranscriptTurn["speaker"],
      text: match[2].trim(),
    }));
}
