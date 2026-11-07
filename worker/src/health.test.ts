import assert from "node:assert/strict";
import test from "node:test";
import { dependenciesAreReady, evaluateDependencyHealth } from "./health.js";
import { classifyProviderFailure, getServiceOutage, markServiceOutage, resetServiceOutagesForTests } from "./service-status.js";

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

test("a known provider outage blocks calls and is reported in German, unreachability alone does not block", () => {
  resetServiceOutagesForTests();
  const healthy = evaluateDependencyHealth({ openai: true, telnyx: true, elevenlabs: true });
  assert.equal(healthy.blocking, false);
  assert.deepEqual(healthy.issues, []);

  const unreachable = evaluateDependencyHealth({ openai: false, telnyx: true, elevenlabs: true });
  assert.equal(unreachable.blocking, false);
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

test("provider outages expire so a manual top-up is picked up without a restart", () => {
  resetServiceOutagesForTests();
  markServiceOutage("openai", "quota", "insufficient_quota", 1_000);
  assert.equal(getServiceOutage("openai", 1_000 + 60_000)?.kind, "quota");
  assert.equal(getServiceOutage("openai", 1_000 + 11 * 60_000), undefined);
  resetServiceOutagesForTests();
});
