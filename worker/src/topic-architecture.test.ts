import assert from "node:assert/strict";
import test from "node:test";
import { createTopicContext, withTopicPolicy } from "./topic-context.js";
import { detectTopicAction } from "./topic-actions.js";
import { loadTopicModule } from "./topic-loader.js";
import { resolveTopicModule } from "./topic-registry.js";

test("resolves supported topic modules without network work", () => {
  assert.equal(resolveTopicModule("private Krankenversicherung")?.id, "pkv");
  assert.equal(resolveTopicModule("Strom")?.id, "energy");
});

test("loads a policy through an injected non-blocking loader", async () => {
  const policy = await loadTopicModule("bKV", async (topic) => ({ topic, opener: "open", discovery: "discover", objectionHandling: "handle", close: "close" }));
  assert.equal(policy?.topic, "Betriebliche Krankenversicherung");
});

test("keeps topic context changes explicit and actions interruptible", () => {
  const context = withTopicPolicy(createTopicContext("Energie"), { topic: "Energie", callObjective: "Termin", topicSummary: "Einordnung", objectionResponses: "Einwände kurz beantworten." });
  assert.equal(context.version, 1);
  assert.equal(detectTopicAction("Bitte verbinden Sie mich mit einem Mitarbeiter").type, "handover");
});