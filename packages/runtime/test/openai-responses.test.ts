import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAiResponsesClient, type DecideRequest } from "../src";

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  total_tokens: 120,
  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
  output_tokens_details: { reasoning_tokens: 4 },
};

describe("OpenAiResponsesClient", () => {
  it("maps Responses function calls to game tools and records usage", async () => {
    const create = vi.fn().mockResolvedValue({
      output_text: "moving",
      output: [
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "move_to",
          arguments: '{"x":3,"y":4}',
          status: "completed",
        },
      ],
      usage,
    });
    const sdk = { responses: { create } } as unknown as OpenAI;
    const client = new OpenAiResponsesClient(
      "gpt-5.6-luna",
      { reasoningEffort: "low", maxTokens: 512 },
      "test-key",
      sdk,
    );
    const execute = vi.fn().mockResolvedValue({ text: "accepted", isError: false });
    const req: DecideRequest = {
      session_id: "test:agent",
      system: "system",
      user: "user",
      tools: [{ name: "move_to", description: "move", schema: { x: z.number(), y: z.number() } }],
      execute,
      maxTurns: 3,
      signal: new AbortController().signal,
    };

    const result = await client.decide(req);

    expect(execute).toHaveBeenCalledWith("move_to", { x: 3, y: 4 });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({
      model: "gpt-5.6-luna",
      instructions: "system",
      store: false,
      reasoning: { effort: "low", context: "current_turn" },
    });
    expect(result).toMatchObject({
      response: "moving",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 10,
      tool_calls: [{ name: "move_to", input: { x: 3, y: 4 }, result: "accepted" }],
      cost_estimated: false,
    });
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it("returns a rejected tool result for one stateless retry", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        output_text: "",
        output: [
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "move_to",
            arguments: '{"x":99,"y":99}',
            status: "completed",
          },
        ],
        usage,
      })
      .mockResolvedValueOnce({ output_text: "fixed", output: [], usage });
    const sdk = { responses: { create } } as unknown as OpenAI;
    const client = new OpenAiResponsesClient(
      "gpt-5.6-luna",
      { reasoningEffort: "low", maxTokens: 512 },
      "test-key",
      sdk,
    );
    const execute = vi.fn().mockResolvedValue({ text: "off map", isError: true });

    const result = await client.decide({
      session_id: "test:agent",
      system: "system",
      user: "user",
      tools: [{ name: "move_to", description: "move", schema: { x: z.number(), y: z.number() } }],
      execute,
      maxTurns: 3,
      signal: new AbortController().signal,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_1" }),
        { type: "function_call_output", call_id: "call_1", output: "off map" },
      ]),
    );
    expect(result.response).toBe("fixed");
  });
});
