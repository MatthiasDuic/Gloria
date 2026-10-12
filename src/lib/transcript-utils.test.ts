import assert from "node:assert/strict";
import test from "node:test";
import { buildReportTranscriptFallback, parseReportTranscriptFallback } from "./transcript-utils";

test("round-trips a report transcript fallback", () => {
  const fallback = buildReportTranscriptFallback([
    { role: "assistant", text: "Wie groß sind Sie?" },
    { role: "user", text: "Ein Meter achtundachtzig." },
  ]);

  assert.match(fallback, /GESPRAECHSPROTOKOLL/);
  assert.deepEqual(parseReportTranscriptFallback(fallback), [
    { speaker: "Gloria", text: "Wie groß sind Sie?" },
    { speaker: "Interessent", text: "Ein Meter achtundachtzig." },
  ]);
});
