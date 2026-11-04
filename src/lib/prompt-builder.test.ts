import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptBlocks, firstFilled, joinFilled } from "./prompt-builder";
import { TopicPolicyPayloadSchema, TOPIC_POLICY_JSON_SCHEMA_V1 } from "./topic-policy-schema";

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

test("preserves assignments up to 5000 characters and rejects longer assignments", () => {
  const callObjective = "x".repeat(5000);
  const parsed = TopicPolicyPayloadSchema.safeParse({ topic: "Test", callObjective });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.callObjective, callObjective);
  assert.equal(TopicPolicyPayloadSchema.safeParse({ topic: "Test", callObjective: `${callObjective}x` }).success, false);
  assert.equal(TOPIC_POLICY_JSON_SCHEMA_V1.properties.callObjective.maxLength, 5000);
});
