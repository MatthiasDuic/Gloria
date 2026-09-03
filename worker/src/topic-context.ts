import type { TopicPolicyFields } from "./topic-policy-prompt.js";
import { resolveTopicModule } from "./topic-registry.js";

export type TopicContext = {
  topic?: string;
  moduleId?: string;
  policy?: TopicPolicyFields;
  objective?: string;
  version: number;
};

export function createTopicContext(topic?: string): TopicContext {
  return {
    topic,
    moduleId: resolveTopicModule(topic)?.id,
    version: 0,
  };
}

export function withTopicPolicy(context: TopicContext, policy: TopicPolicyFields | undefined): TopicContext {
  const topic = policy?.topic || context.topic;
  return {
    ...context,
    topic,
    moduleId: resolveTopicModule(topic)?.id || context.moduleId,
    policy,
    objective: policy?.callObjective || context.objective,
    version: context.version + 1,
  };
}