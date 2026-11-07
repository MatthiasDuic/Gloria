import assert from "node:assert/strict";
import test from "node:test";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { dependenciesAreReady, evaluateDependencyHealth, getDependencyHealth } from "./health.js";
import { classifyProviderFailure, clearServiceOutage, getServiceOutage, markServiceOutage, resetServiceOutagesForTests } from "./service-status.js";

test("readiness requires every telephony dependency", () => {
  assert.equal(dependenciesAreReady({ openai: true, telnyx: true, elevenlabs: true }), true);
  assert.equal(dependenciesAreReady({ openai: true, telnyx: false, elevenlabs: true }), false);
});

test("provider errors that need a top-up or a new key are recognised, transient ones are not", () => {
  assert.equal(classifyProviderFailure("You exceeded your current quota, please check your plan and billing details."), "quota");
  assert.equal(classifyProviderFailure("insufficient_quota"), "quota");
  assert.equal(classifyProviderFailure("ElevenLabs TTS antwortete 401: This request exceeds your quota of 10000. You have 12 credits remaining, while 40 credits are required."), "quota");
  assert.equal(classifyProviderFailure("Incorrect API key provided: sk-abc"), "auth");
  assert.equal(classifyProviderFailure("Unexpected server response: 401"), "auth");
  assert.equal(classifyProviderFailure("Rate limit reached for requests"), undefined);
  assert.equal(classifyProviderFailure("Conversation already has an active response"), undefined);
  assert.equal(classifyProviderFailure("ElevenLabs stream stalled after 6s"), undefined);
  assert.equal(classifyProviderFailure(undefined, ""), undefined);
});

test("provider outages and unknown reachability block calls", () => {
  resetServiceOutagesForTests();
  const healthy = evaluateDependencyHealth({ openai: true, telnyx: true, elevenlabs: true });
  assert.equal(healthy.blocking, false);
  assert.deepEqual(healthy.issues, []);

  const unreachable = evaluateDependencyHealth({ openai: false, telnyx: true, elevenlabs: true });
  assert.equal(unreachable.blocking, true);
  assert.deepEqual(unreachable.issues, ["OpenAI nicht erreichbar"]);

  markServiceOutage("openai", "quota", "insufficient_quota");
  const exhausted = evaluateDependencyHealth({ openai: true, telnyx: true, elevenlabs: true });
  assert.equal(exhausted.blocking, true);
  assert.equal(exhausted.dependencies.openai, false);
  assert.deepEqual(exhausted.issues, ["OpenAI-Guthaben aufgebraucht"]);

  markServiceOutage("elevenlabs", "auth", "invalid_api_key");
  assert.deepEqual(evaluateDependencyHealth({ openai: true, telnyx: true, elevenlabs: true }).issues, [
    "OpenAI-Guthaben aufgebraucht",
    "ElevenLabs-API-Schlüssel ungültig",
  ]);
  resetServiceOutagesForTests();
});

test("provider outages stay blocked until a successful check clears them", () => {
  resetServiceOutagesForTests();
  markServiceOutage("openai", "quota", "insufficient_quota", 1_000);
  assert.equal(getServiceOutage("openai")?.kind, "quota");
  clearServiceOutage("openai");
  assert.equal(getServiceOutage("openai"), undefined);
  resetServiceOutagesForTests();
});

test("live dependency checks reject invalid Telnyx credentials and recover after top-up", async () => {
  const dispatcher = getGlobalDispatcher();
  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  const keys = ["OPENAI_API_KEY", "TELNYX_API_KEY", "ELEVENLABS_API_KEY", "OPENAI_CREDIT_PROBE_MS"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = key === "OPENAI_CREDIT_PROBE_MS" ? "0" : "test-key";
  resetServiceOutagesForTests();
  try {
    for (const phase of ["quota", "invalid-telnyx", "healthy"] as const) {
      agent.get("https://api.openai.com").intercept({ path: "/v1/models" }).reply(200, {});
      agent.get("https://api.openai.com").intercept({ path: "/v1/chat/completions", method: "POST" })
        .reply(phase === "quota" ? 429 : 200, phase === "quota" ? { error: { code: "insufficient_quota" } } : {});
      agent.get("https://api.telnyx.com").intercept({ path: "/v2/phone_numbers" })
        .reply(phase === "invalid-telnyx" ? 401 : 200, {});
      agent.get("https://api.elevenlabs.io").intercept({ path: "/v1/voices" }).reply(200, {});
      agent.get("https://api.elevenlabs.io").intercept({ path: "/v1/user/subscription" })
        .reply(200, { character_count: 100, character_limit: 10000 });
      const health = await getDependencyHealth(0);
      assert.equal(health.blocking, phase !== "healthy", phase);
      if (phase === "quota") assert.ok(health.issues.includes("OpenAI-Guthaben aufgebraucht"));
      if (phase === "invalid-telnyx") assert.equal(health.dependencies.telnyx, false);
      if (phase === "healthy") assert.deepEqual(health.issues, []);
    }
    agent.assertNoPendingInterceptors();
  } finally {
    setGlobalDispatcher(dispatcher);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServiceOutagesForTests();
    await agent.close();
  }
});
