export interface PromptBlock {
  label: string;
  value?: string;
}

export function firstFilled(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return "";
}

export function joinFilled(values: Array<string | undefined>, separator = "\n"): string {
  return values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .join(separator);
}

export function buildPromptBlocks(blocks: PromptBlock[], separator = "\n"): string {
  return blocks
    .map(({ label, value }) => {
      const text = firstFilled(value);
      return text ? `${label}: ${text}` : "";
    })
    .filter(Boolean)
    .join(separator);
}
