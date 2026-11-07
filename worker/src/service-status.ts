export type ProviderService = "openai" | "elevenlabs";
export type ProviderFailure = "quota" | "auth";

type Outage = { kind: ProviderFailure; reason: string; at: number };

const outages = new Map<ProviderService, Outage>();
let version = 0;

/** Changes whenever an outage is recorded or cleared, so cached health results can be invalidated. */
export function serviceStatusVersion(): number {
  return version;
}

/** Detects provider errors that make every further call fail until someone tops up credits or fixes the key. */
export function classifyProviderFailure(...parts: Array<string | undefined | null>): ProviderFailure | undefined {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!text) return undefined;
  if (/insufficient_quota|quota_exceeded|exceeded your current quota|exceeds your quota|no credits|credits remaining|billing|payment_required|insufficient[_ ]credits/.test(text)) {
    return "quota";
  }
  if (/invalid_api_key|incorrect api key|invalid api key|unauthorized|authentication|account_deactivated|detected_unusual_activity|unexpected server response: 40[13]\b/.test(text)) {
    return "auth";
  }
  return undefined;
}

export function markServiceOutage(service: ProviderService, kind: ProviderFailure, reason: string, now = Date.now()): void {
  outages.set(service, { kind, reason: reason.slice(0, 200), at: now });
  version += 1;
}

export function clearServiceOutage(service: ProviderService): void {
  if (outages.delete(service)) version += 1;
}

export function getServiceOutage(service: ProviderService): Outage | undefined {
  return outages.get(service);
}

export function resetServiceOutagesForTests(): void {
  outages.clear();
  version += 1;
}
