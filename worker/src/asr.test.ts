import assert from "node:assert/strict";
import test from "node:test";
import { resolveAsrProvider, type AsrProvider } from "./asr.js";

test("uses OpenAI Realtime ASR", () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "openai" as AsrProvider);
});

test("requires OpenAI credentials", () => {
  assert.throws(() => resolveAsrProvider({}), /OPENAI_API_KEY/);
});

test("uses OpenAI when credentials exist", () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "demo" };
  assert.equal(resolveAsrProvider(env), "openai" as AsrProvider);
});
