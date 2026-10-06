export * from "./config";
export * from "./clock";
export * from "./budget";
export * from "./team";
export * from "./transport";
export * from "./match";
export * from "./provenance";
export * from "./commentator";
export * from "./llm/types";
export { AnthropicApiClient, jsonSchema } from "./llm/anthropic-api";
export { ClaudeCodeClient } from "./llm/claude-code";
export { CodexAppServerClient, type CodexAppServerConnection, type RpcMessage } from "./llm/codex-app-server";
export { OpenAiResponsesClient } from "./llm/openai-responses";
export { costUsd } from "./llm/pricing";
export * from "./agent/agent";
export * from "./agent/order-tools";
export * from "./agent/prompts";

import type { MatchConfig } from "./config";
import { AnthropicApiClient } from "./llm/anthropic-api";
import { ClaudeCodeClient } from "./llm/claude-code";
import { CodexAppServerClient } from "./llm/codex-app-server";
import { OpenAiResponsesClient } from "./llm/openai-responses";
import type { LlmClient } from "./llm/types";

export function createLlmClient(c: MatchConfig): LlmClient {
  switch (c.llm.backend) {
    case "api":
      return new AnthropicApiClient(c.llm.model, {
        temperature: c.llm.temperature,
        reasoningEffort: c.llm.reasoning_effort,
        maxTokens: c.llm.max_tokens,
      });
    case "openai":
      return new OpenAiResponsesClient(c.llm.model, {
        reasoningEffort: c.llm.reasoning_effort,
        maxTokens: c.llm.max_tokens,
      });
    case "codex":
      return new CodexAppServerClient(c.llm.model, {
        reasoningEffort: c.llm.reasoning_effort,
        maxTokens: c.llm.max_tokens,
      });
    case "claude-code":
      return new ClaudeCodeClient(c.llm.model);
  }
}
