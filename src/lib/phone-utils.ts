// Gemeinsame Telefon- und Kontakt-Normalisierung für Matching von
// Twilio-Nummern, Durchwahlen und Ansprechpartnernamen.

export function normalizePhoneForMatch(value: string | undefined): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");

  if (!digits) {
    return "";
  }

  return plus ? `+${digits}` : digits;
}

export function phoneMatches(
  leftRaw: string | undefined,
  rightRaw: string | undefined,
): boolean {
  const left = normalizePhoneForMatch(leftRaw);
  const right = normalizePhoneForMatch(rightRaw);

  if (!left || !right) {
    return false;
  }

  if (left === right) {
    return true;
  }

  const leftDigits = left.replace(/^\+/, "");
  const rightDigits = right.replace(/^\+/, "");

  return leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits);
}

export function normalizeContactName(raw: string | undefined): string {
  if (!raw) {
    return "";
  }

  const cleaned = raw.replace(/\s+/g, " ").replace(/^(herr|frau)\s+/i, "").trim();

  // Platzhalter aus Testformularen dürfen nicht als echter Name in den
  // Dialog geraten ("... mit Ansprechpartner verbinden?").
  if (/^(ansprechpartner|ansprechpartnerin|kontakt|kontaktperson|name)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

export function normalizeDirectDial(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }

  const compact = raw.trim().replace(/\(0\)/g, "");
  const keepsPlus = compact.startsWith("+");
  const digits = compact.replace(/[^\d]/g, "");

  if (digits.length < 6) {
    return undefined;
  }

  if (keepsPlus) {
    return `+${digits}`;
  }

  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }

  return digits;
}

export function extractDirectDialFromText(text: string): string | undefined {
  const match = text.match(/(\+?\d[\d\s()\/-]{5,}\d)/);
  return normalizeDirectDial(match?.[1]);
}

export function normalizePhoneForDial(
  raw: string | undefined,
  options?: { defaultCountryCode?: string },
): string | undefined {
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  // SIP endpoints are already valid targets for Telnyx.
  if (/^sip:/i.test(trimmed)) {
    return trimmed;
  }

  const compact = trimmed.replace(/\(0\)/g, "").replace(/[\s()./-]/g, "");
  const defaultCountryCode = options?.defaultCountryCode?.trim() || "+49";
  const ccDigits = defaultCountryCode.replace(/^\+/, "").replace(/\D/g, "");

  if (compact.startsWith("+")) {
    const digits = compact.slice(1).replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }

  const digits = compact.replace(/\D/g, "");
  if (!digits) {
    return undefined;
  }

  // International format with 00 prefix.
  if (digits.startsWith("00")) {
    const normalized = digits.slice(2);
    return normalized.length >= 8 && normalized.length <= 15 ? `+${normalized}` : undefined;
  }

  // Local DE-like number with leading trunk zero.
  if (digits.startsWith("0")) {
    const normalized = `${ccDigits}${digits.slice(1)}`;
    return normalized.length >= 8 && normalized.length <= 15 ? `+${normalized}` : undefined;
  }

  // Number already includes country code but without plus.
  if (ccDigits && digits.startsWith(ccDigits)) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }

  // Fallback: treat as national number and prepend default country code.
  if (digits.length >= 7 && digits.length <= 12) {
    const normalized = `${ccDigits}${digits}`;
    return normalized.length >= 8 && normalized.length <= 15 ? `+${normalized}` : undefined;
  }

  return undefined;
}
