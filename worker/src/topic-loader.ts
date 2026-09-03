import type { TopicPolicyFields } from "./topic-policy-prompt.js";
import { resolveTopicModule } from "./topic-registry.js";

export type TopicPolicyLoader = (topic: string) => Promise<TopicPolicyFields | null>;

export async function loadTopicModule(
  topic: string | undefined,
  loadPolicy: TopicPolicyLoader,
): Promise<TopicPolicyFields | null> {
  const module = resolveTopicModule(topic);
  if (!module) return null;
  return loadPolicy(module.label);
}