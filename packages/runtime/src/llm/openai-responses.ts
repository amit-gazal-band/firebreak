import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { jsonSchema } from "./anthropic-api";
import { costUsd } from "./pricing";
import type { DecideRequest, DecideResult, LlmClient } from "./types";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/** OpenAI Responses API backend with stateless decisions and local function execution. */
export class OpenAiResponsesClient implements LlmClient {
  readonly backend = "openai" as const;
  readonly retainsSessionContext = false;
  private client: OpenAI;

  constructor(
    readonly model: string,
    private opts: { reasoningEffort: ReasoningEffort; maxTokens: number },
    apiKey = process.env.OPENAI_API_KEY,
    client?: OpenAI,
  ) {
    if (!apiKey && !client) throw new Error("llm.backend=openai needs OPENAI_API_KEY");
    this.client = client ?? new OpenAI({ apiKey });
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const out: DecideResult = {
      response: "",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      cost_estimated: true,
    };
    let cacheWrite = 0;
    const input: ResponseInputItem[] = [{ role: "user", content: req.user }];
    const tools = req.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: jsonSchema(t),
      strict: true,
    }));

    try {
      for (let turn = 0; turn < req.maxTurns; turn++) {
        const response = await this.client.responses.create(
          {
            model: this.model,
            instructions: req.system,
            input,
            tools,
            parallel_tool_calls: true,
            max_output_tokens: this.opts.maxTokens,
            reasoning: { effort: this.opts.reasoningEffort, context: "current_turn" },
            store: false,
          },
          { signal: req.signal },
        );
        const usage = response.usage;
        out.input_tokens += usage?.input_tokens ?? 0;
        out.output_tokens += usage?.output_tokens ?? 0;
        out.cache_read_tokens += usage?.input_tokens_details.cached_tokens ?? 0;
        cacheWrite += usage?.input_tokens_details.cache_write_tokens ?? 0;
        if (response.output_text) out.response += (out.response ? "\n" : "") + response.output_text;

        const calls = response.output.filter((item) => item.type === "function_call");
        if (!calls.length) break;
        input.push(...toResponseInputItems(response.output));
        let anyError = false;
        for (const call of calls) {
          let args: Record<string, unknown> = {};
          let result: { text: string; isError: boolean };
          try {
            args = JSON.parse(call.arguments) as Record<string, unknown>;
            result = await req.execute(call.name, args);
          } catch (e) {
            result = {
              text: `invalid tool arguments: ${e instanceof Error ? e.message : String(e)}`,
              isError: true,
            };
          }
          out.tool_calls.push({ name: call.name, input: args, result: result.text });
          anyError ||= result.isError;
          input.push({ type: "function_call_output", call_id: call.call_id, output: result.text });
        }
        // Match the Anthropic backend: retry only rejected calls; accepted actions end the decision.
        if (!anyError) break;
      }
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
      if (e instanceof OpenAI.AuthenticationError) out.fatal = "auth";
    }

    const c = costUsd(this.model, {
      input: Math.max(0, out.input_tokens - out.cache_read_tokens - cacheWrite),
      output: out.output_tokens,
      cacheRead: out.cache_read_tokens,
      cacheWrite,
    });
    out.cost_usd = c.usd;
    out.cost_estimated = !c.known;
    return out;
  }
}
