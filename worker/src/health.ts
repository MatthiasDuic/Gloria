import { fetch } from "undici";

export type DependencyHealth = {
  openai: boolean;
  telnyx: boolean;
  elevenlabs: boolean;
};

type CachedHealth = {
  checkedAt: number;
  dependencies: DependencyHealth;
};

let cachedHealth: CachedHealth | undefined;
let pendingCheck: Promise<CachedHealth> | undefined;

async function check(url: string, headers: Record<string, string>, acceptedStatuses: number[] = []): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok || acceptedStatuses.includes(response.status);
  } catch {
    return false;
  }
}

async function performDependencyCheck(): Promise<CachedHealth> {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  const telnyxKey = process.env.TELNYX_API_KEY?.trim();
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY?.trim();
  const [openai, telnyx, elevenlabs] = await Promise.all([
    openAiKey
      ? check("https://api.openai.com/v1/models", { Authorization: `Bearer ${openAiKey}` })
      : Promise.resolve(false),
    telnyxKey
      ? check("https://api.telnyx.com/v2/phone_numbers", { Authorization: `Bearer ${telnyxKey}` }, [401])
      : Promise.resolve(false),
    elevenLabsKey
      ? check("https://api.elevenlabs.io/v1/voices", { "xi-api-key": elevenLabsKey })
      : Promise.resolve(false),
  ]);
  return {
    checkedAt: Date.now(),
    dependencies: { openai, telnyx, elevenlabs },
  };
}

export async function getDependencyHealth(
  maxAgeMs = Number.parseInt(process.env.HEALTH_DEPENDENCY_CACHE_MS?.trim() || "30000", 10),
): Promise<CachedHealth> {
  if (cachedHealth && Date.now() - cachedHealth.checkedAt < maxAgeMs) return cachedHealth;
  if (!pendingCheck) {
    pendingCheck = performDependencyCheck()
      .then((result) => {
        cachedHealth = result;
        return result;
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
