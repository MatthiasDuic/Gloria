// Words that sound unnatural on the phone, with a grammatically compatible replacement (same gender/number).
const DISCOURAGED_WORDS: Array<[RegExp, string]> = [
  [/\bStellschrauben\b/g, "Optionen"],
  [/\bstellschrauben\b/g, "Optionen"],
  [/\bStellschraube\b/g, "Option"],
  [/\bstellschraube\b/g, "Option"],
];

export function replaceDiscouragedWords(text: string): string {
  return DISCOURAGED_WORDS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

// The model sometimes wraps verbatim answers in quotation marks; they are never spoken and must not reach TTS or the transcript.
export function stripSpokenQuotes(text: string): string {
  return text.replace(/["„“”«»]/g, "");
}
