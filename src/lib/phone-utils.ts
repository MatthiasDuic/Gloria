// Normalisierung von Telefonnummern für die Anwahl über Telnyx.

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
