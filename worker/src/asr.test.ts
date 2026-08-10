import assert from "node:assert/strict";
import test from "node:test";
import { resolveAsrProvider, type AsrProvider } from "./asr.js";

test("prefers deepgram when configured", () => {
  const env: NodeJS.ProcessEnv = { DEEPGRAM_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "deepgram" as AsrProvider);
});

test("falls back to openai when deepgram is unavailable", () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "openai" as AsrProvider);
});

test("honors explicit provider selection", () => {
  const env: NodeJS.ProcessEnv = { ASR_PROVIDER: "openai", DEEPGRAM_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "openai" as AsrProvider);
});

test("defaults to openai when only openai credentials exist", () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "openai" as AsrProvider);
});
