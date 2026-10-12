export function parseGermanEuroAmount(text: string): number | undefined {
  const direct = text.match(/\b(\d{1,3}(?:\.\d{3})+|\d{1,5})(?:,\d{1,2})?\s*(?:euro|€)\b/i);
  if (direct) return Number.parseInt(direct[1].replace(/\./g, ""), 10);

  const words = text.match(/\b(?:[a-zäöüß-]*tausend[a-zäöüß-]*|[a-zäöüß-]*hundert[a-zäöüß-]*)(?:\s+[a-zäöüß-]+){0,3}/i)?.[0];
  if (!words) return undefined;
  const normalized = words
    .toLowerCase()
    .replace(/\s+euro\b/, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/-/g, "")
    .replace(/\s+/g, "");
  const units: Record<string, number> = {
    ein: 1,
    eins: 1,
    zwei: 2,
    drei: 3,
    vier: 4,
    fuenf: 5,
    sechs: 6,
    sieben: 7,
    acht: 8,
    neun: 9,
  };
  const tens: Record<string, number> = {
    zehn: 10,
    zwanzig: 20,
    dreissig: 30,
    vierzig: 40,
    fuenfzig: 50,
    sechzig: 60,
    siebzig: 70,
    achtzig: 80,
    neunzig: 90,
  };
  const parse = (value: string): number | undefined => {
    if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
    if (value in units) return units[value];
    if (value in tens) return tens[value];
    const thousand = value.indexOf("tausend");
    if (thousand >= 0) {
      return (parse(value.slice(0, thousand) || "ein") || 0) * 1000
        + (parse(value.slice(thousand + 7)) || 0);
    }
    const hundred = value.indexOf("hundert");
    if (hundred >= 0) {
      return (parse(value.slice(0, hundred) || "ein") || 0) * 100
        + (parse(value.slice(hundred + 7)) || 0);
    }
    const und = value.indexOf("und");
    if (und > 0) return (units[value.slice(0, und)] || 0) + (tens[value.slice(und + 3)] || 0);
    return undefined;
  };
  return parse(normalized);
}
