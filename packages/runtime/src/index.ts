export * from "./config";
export * from "./clock";
export * from "./budget";
export * from "./team";
export * from "./transport";
export * from "./match";
export * from "./provenance";
export * from "./llm/types";
export { AnthropicApiClient, jsonSchema } from "./llm/anthropic-api";
export { ClaudeCodeClient } from "./llm/claude-code";
export { costUsd } from "./llm/pricing";
export * from "./agent/agent";
export * from "./agent/order-tools";
export * from "./agent/prompts";

import type { MatchConfig } from "./config";
import { AnthropicApiClient } from "./llm/anthropic-api";
import { ClaudeCodeClient } from "./llm/claude-code";
import type { LlmClient } from "./llm/types";

export function createLlmClient(c: MatchConfig): LlmClient {
  return c.llm.backend === "api"
    ? new AnthropicApiClient(c.llm.model, { temperature: c.llm.temperature, maxTokens: c.llm.max_tokens })
    : new ClaudeCodeClient(c.llm.model);
}
