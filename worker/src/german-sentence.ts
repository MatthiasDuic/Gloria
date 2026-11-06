export function endsWithSentenceAbbreviation(text: string): boolean {
  return /\b(?:Dr|Prof|bzw|ca|Nr|etc|z|B)\.\s*$/i.test(text);
}
