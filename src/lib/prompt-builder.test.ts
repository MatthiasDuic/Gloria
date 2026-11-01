import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlocks, firstFilled, joinFilled } from "./prompt-builder";
import { TopicPolicyPayloadSchema } from "./topic-policy-schema";

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

test("accepts administrator-created campaign topics without a code change", () => {
  const result = TopicPolicyPayloadSchema.safeParse({
    topic: "Jahresgespräch für Firmenkunden",
    callObjective: "Einen Betreuungstermin vereinbaren.",
  });

  assert.equal(result.success, true);
});

test("rejects empty or oversized campaign topic names", () => {
  assert.equal(TopicPolicyPayloadSchema.safeParse({ topic: "  " }).success, false);
  assert.equal(TopicPolicyPayloadSchema.safeParse({ topic: "x".repeat(121) }).success, false);
});
