import { fetch } from "undici";
import { log } from "./log.js";
import { classifyProviderFailure, clearServiceOutage, getServiceOutage, markServiceOutage, serviceStatusVersion } from "./service-status.js";

export type DependencyHealth = {
  openai: boolean;
  telnyx: boolean;
  elevenlabs: boolean;
};

type CachedHealth = {
  checkedAt: number;
  /** Raw reachability from the last network check, before known provider outages are applied. */
  reachable: DependencyHealth;
  dependencies: DependencyHealth;
  /** Human-readable problems for the app (German, shown to the user). */
  issues: string[];
  /** New calls require a confirmed healthy dependency chain. */
  blocking: boolean;
  statusVersion?: number;
};

let cachedHealth: CachedHealth | undefined;
let pendingCheck: Promise<CachedHealth> | undefined;

async function check(url: string, headers: Record<string, string>): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    const service = url.includes("api.openai.com") ? "openai" : url.includes("api.elevenlabs.io") ? "elevenlabs" : undefined;
    if (service && response.status === 401) markServiceOutage(service, "auth", `health ${response.status}`);
    else if (service && response.ok && getServiceOutage(service)?.kind === "auth") clearServiceOutage(service);
    await response.body?.cancel();
    return response.ok;
  } catch (error) {
    log.warn("health.reachability_failed", { url, error: String(error) });
    return false;
  }
}

async function performDependencyCheck(): Promise<CachedHealth> {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const telnyxKey = process.env.TELNYX_API_KEY?.trim();
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY?.trim();
  const [openaiReachable, telnyx, elevenlabsReachable, openaiCreditsReady] = await Promise.all([
    openAiKey
      ? check("https://api.openai.com/v1/models", { Authorization: `Bearer ${openAiKey}` })
      : Promise.resolve(false),
    telnyxKey
      ? check("https://api.telnyx.com/v2/phone_numbers", { Authorization: `Bearer ${telnyxKey}` })
      : Promise.resolve(false),
    elevenLabsKey
      ? check("https://api.elevenlabs.io/v1/voices", { "xi-api-key": elevenLabsKey })
      : Promise.resolve(false),
    openAiKey ? probeOpenAiCredits(openAiKey) : Promise.resolve(false),
    elevenLabsKey ? probeElevenLabsCredits(elevenLabsKey) : Promise.resolve(),
  ]);
  return {
    checkedAt: Date.now(),
    reachable: { openai: openaiReachable && openaiCreditsReady, telnyx, elevenlabs: elevenlabsReachable },
    ...evaluateDependencyHealth({ openai: openaiReachable && openaiCreditsReady, telnyx, elevenlabs: elevenlabsReachable }),
  };
}

/** Combines reachability and successful credit probes with known provider outages. */
export function evaluateDependencyHealth(reachable: DependencyHealth): Pick<CachedHealth, "dependencies" | "issues" | "blocking"> {
  const openAiOutage = getServiceOutage("openai");
  const elevenLabsOutage = getServiceOutage("elevenlabs");
  const issues: string[] = [];
  if (openAiOutage) issues.push(openAiOutage.kind === "quota" ? "OpenAI-Guthaben aufgebraucht" : "OpenAI-API-Schlüssel ungültig");
  else if (!reachable.openai) issues.push("OpenAI nicht erreichbar");
  if (elevenLabsOutage) issues.push(elevenLabsOutage.kind === "quota" ? "ElevenLabs-Kontingent aufgebraucht" : "ElevenLabs-API-Schlüssel ungültig");
  else if (!reachable.elevenlabs) issues.push("ElevenLabs nicht erreichbar");
  if (!reachable.telnyx) issues.push("Telnyx nicht erreichbar");
  return {
    dependencies: {
      openai: reachable.openai && !openAiOutage,
      telnyx: reachable.telnyx,
      elevenlabs: reachable.elevenlabs && !elevenLabsOutage,
    },
    issues,
    blocking: Boolean(openAiOutage || elevenLabsOutage) || !dependenciesAreReady(reachable),
  };
}

let lastCreditProbeAt = 0;
let lastCreditProbeSucceeded = false;

/** A one-token request is the only reliable way to notice exhausted OpenAI credits; the models endpoint still answers. */
async function probeOpenAiCredits(apiKey: string): Promise<boolean> {
  const intervalMs = Number.parseInt(process.env.OPENAI_CREDIT_PROBE_MS?.trim() || "300000", 10);
  if (Date.now() - lastCreditProbeAt < intervalMs && lastCreditProbeSucceeded && !getServiceOutage("openai")) return true;
  lastCreditProbeAt = Date.now();
  lastCreditProbeSucceeded = false;
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.OPENAI_CREDIT_PROBE_MODEL?.trim() || "gpt-4o-mini",
        max_completion_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) {
      await response.body?.cancel();
      clearServiceOutage("openai");
      lastCreditProbeSucceeded = true;
      return true;
    }
    const body = await response.text().catch(() => "");
    const failure = response.status === 401 ? "auth" : classifyProviderFailure(body);
    if (failure && (response.status === 401 || response.status === 403 || response.status === 429)) {
      markServiceOutage("openai", failure, `probe ${response.status}: ${body}`);
    }
    log.warn("health.credit_probe_failed", { status: response.status, failure });
  } catch (error) {
    log.warn("health.credit_probe_failed", { error: String(error) });
  }
  return false;
}

async function probeElevenLabsCredits(apiKey: string): Promise<void> {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (classifyProviderFailure(body) === "quota") markServiceOutage("elevenlabs", "quota", `subscription ${response.status}: ${body}`);
      return;
    }
    const subscription = await response.json() as {
      character_count?: number;
      character_limit?: number;
      can_extend_character_limit?: boolean;
      allowed_to_extend_character_limit?: boolean;
    };
    const used = subscription.character_count;
    const limit = subscription.character_limit;
    const canExtend = subscription.can_extend_character_limit === true && subscription.allowed_to_extend_character_limit === true;
    if (typeof used === "number" && typeof limit === "number" && limit > 0 && used >= limit && !canExtend) {
      markServiceOutage("elevenlabs", "quota", `character limit reached (${used}/${limit})`);
    } else if (getServiceOutage("elevenlabs")?.kind === "quota") {
      clearServiceOutage("elevenlabs");
    }
  } catch {
    // Keys without subscription permission or network problems must not block calls.
  }
}

export async function getDependencyHealth(
  maxAgeMs = Number.parseInt(process.env.HEALTH_DEPENDENCY_CACHE_MS?.trim() || "30000", 10),
): Promise<CachedHealth> {
  if (cachedHealth && Date.now() - cachedHealth.checkedAt < maxAgeMs) {
    if (cachedHealth.statusVersion !== serviceStatusVersion()) {
      // A call just reported (or cleared) a provider outage: re-evaluate without another network round trip.
      cachedHealth = { ...cachedHealth, ...evaluateDependencyHealth(cachedHealth.reachable), statusVersion: serviceStatusVersion() };
    }
    return cachedHealth;
  }
  if (!pendingCheck) {
    pendingCheck = performDependencyCheck()
      .then((result) => {
        cachedHealth = { ...result, statusVersion: serviceStatusVersion() };
        return cachedHealth;
      })
      .finally(() => {
        pendingCheck = undefined;
      });
  }
  return pendingCheck;
}

export function dependenciesAreReady(dependencies: DependencyHealth): boolean {
  return Object.values(dependencies).every(Boolean);
}
