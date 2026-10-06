import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { costUsd } from "./pricing";
import type { DecideRequest, DecideResult, LlmClient, ToolDef } from "./types";

export function jsonSchema(t: ToolDef): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(t.schema)) as Record<string, unknown>;
  return schema;
}

/** `api` backend: Messages API with an API key (SPEC §6.3). */
export class AnthropicApiClient implements LlmClient {
  readonly backend = "api" as const;
  readonly retainsSessionContext = false;
  private client: Anthropic;

  constructor(
    readonly model: string,
    private opts: {
      temperature: number;
      reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
      maxTokens: number;
    },
    apiKey = process.env.ANTHROPIC_API_KEY,
  ) {
    if (!apiKey) throw new Error("llm.backend=api needs ANTHROPIC_API_KEY");
    this.client = new Anthropic({ apiKey });
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: jsonSchema(t) as Anthropic.Tool.InputSchema,
    }));
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.user }];
    const out: DecideResult = {
      response: "",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      cost_estimated: false,
    };
    let cacheWrite = 0;
    const adaptive = /^claude-(?:opus|sonnet|fable)-(?:[5-9]|4-[7-9])/.test(this.model);
    try {
      for (let turn = 0; turn < req.maxTurns; turn++) {
        const msg = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: this.opts.maxTokens,
            ...(adaptive
              ? {
                  thinking: { type: "adaptive" as const },
                  output_config: {
                    effort: (this.opts.reasoningEffort === "none" ? "low" : this.opts.reasoningEffort) as
                      "low" | "medium" | "high" | "xhigh" | "max",
                  },
                }
              : { temperature: this.opts.temperature }),
            system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
            tools,
            messages,
          },
          { signal: req.signal },
        );
        out.input_tokens +=
          msg.usage.input_tokens +
          (msg.usage.cache_read_input_tokens ?? 0) +
          (msg.usage.cache_creation_input_tokens ?? 0);
        out.output_tokens += msg.usage.output_tokens;
        out.cache_read_tokens += msg.usage.cache_read_input_tokens ?? 0;
        cacheWrite += msg.usage.cache_creation_input_tokens ?? 0;
        const results: Anthropic.ToolResultBlockParam[] = [];
        let anyError = false;
        for (const block of msg.content) {
          if (block.type === "text") out.response += (out.response ? "\n" : "") + block.text;
          if (block.type === "tool_use") {
            const r = await req.execute(block.name, block.input as Record<string, unknown>);
            out.tool_calls.push({ name: block.name, input: block.input, result: r.text });
            results.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: r.text,
              is_error: r.isError,
            });
            anyError ||= r.isError;
          }
        }
        // Continue only so the model can fix a rejected call; otherwise the decision is done.
        if (msg.stop_reason !== "tool_use" || !anyError) break;
        messages.push({ role: "assistant", content: msg.content }, { role: "user", content: results });
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      if (e instanceof Anthropic.AuthenticationError) out.fatal = "auth";
    }
    const c = costUsd(this.model, {
      input: out.input_tokens - out.cache_read_tokens - cacheWrite,
      output: out.output_tokens,
      cacheRead: out.cache_read_tokens,
      cacheWrite,
    });
    out.cost_usd = c.usd;
    out.cost_estimated = !c.known;
    return out;
  }
}
