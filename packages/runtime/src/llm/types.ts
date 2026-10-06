import type { ZodRawShape } from "zod";

/** A tool the model can call. The schema is a zod shape, converted per backend. */
export interface ToolDef {
  name: string;
  description: string;
  schema: ZodRawShape;
}

export interface ToolResult {
  text: string;
  /** Validation failures let the model retry within the same decision (SPEC §6.4). */
  isError: boolean;
}

export interface DecideRequest {
  /** Stable logical conversation. Headless backends retain this session across decisions. */
  session_id: string;
  system: string;
  user: string;
  tools: ToolDef[];
  execute(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  maxTurns: number;
  signal: AbortSignal;
}

export interface DecideResult {
  response: string;
  tool_calls: { name: string; input: unknown; result: string }[];
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  cost_estimated: boolean;
  error?: string;
  /** Errors that should stop the match rather than one decision. */
  fatal?: "usage_limit" | "auth";
}

/** One model interface shared by every backend (SPEC §6.3). */
export interface LlmClient {
  readonly backend: "api" | "claude-code" | "openai" | "codex";
  readonly model: string;
  /** Whether later decisions in one session inherit earlier prompts and responses. */
  readonly retainsSessionContext: boolean;
  decide(req: DecideRequest): Promise<DecideResult>;
  close?(): Promise<void>;
}
