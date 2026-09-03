export type TopicModule = {
  id: string;
  label: string;
  aliases: readonly string[];
};

export const TOPIC_REGISTRY: readonly TopicModule[] = [
  { id: "bkv", label: "Betriebliche Krankenversicherung", aliases: ["bkv", "betriebliche krankenversicherung"] },
  { id: "pkv", label: "Private Krankenversicherung", aliases: ["pkv", "private krankenversicherung", "gkv", "gesetzliche krankenversicherung"] },
  { id: "bav", label: "Betriebliche Altersvorsorge", aliases: ["bav", "betriebliche altersvorsorge", "altersvorsorge"] },
  { id: "energy", label: "Energie", aliases: ["energie", "strom", "gas"] },
  { id: "commercial", label: "Gewerbe", aliases: ["gewerbe", "gewerbliche versicherungen", "betriebshaftpflicht"] },
  { id: "lead-qualification", label: "Lead-Qualifizierung", aliases: ["lead", "qualifizierung"] },
  { id: "appointment", label: "Terminvereinbarung", aliases: ["termin", "terminvereinbarung", "rückruf"] },
];

export function resolveTopicModule(topic?: string): TopicModule | undefined {
  const normalized = topic?.trim().toLocaleLowerCase("de-DE");
  if (!normalized) return undefined;
  return TOPIC_REGISTRY.find((module) =>
    module.aliases.some((alias) => normalized === alias || normalized.includes(alias)),
  );
}