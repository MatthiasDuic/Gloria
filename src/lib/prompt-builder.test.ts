import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlocks, firstFilled, joinFilled } from "./prompt-builder";

test("buildPromptBlocks keeps only non-empty sections", () => {
  const prompt = buildPromptBlocks([
    { label: "Thema", value: "bKV" },
    { label: "Ziel", value: "" },
    { label: "Verhalten", value: "ruhig und klar" },
  ]);

  assert.equal(prompt, "Thema: bKV\nVerhalten: ruhig und klar");
});

test("firstFilled and joinFilled provide stable fallbacks", () => {
  assert.equal(firstFilled(undefined, "fallback"), "fallback");
  assert.equal(firstFilled("", "fallback"), "fallback");
  assert.equal(joinFilled(["alpha", "", "beta"], " | "), "alpha | beta");
});
