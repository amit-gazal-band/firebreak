import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CodexAppServerClient,
  type CodexAppServerConnection,
  type DecideRequest,
  type RpcMessage,
} from "../src";

class FakeConnection implements CodexAppServerConnection {
  listener: ((message: RpcMessage) => void) | null = null;
  calls: { method: string; params: unknown }[] = [];
  responses: { id: number | string; result: unknown }[] = [];
  closed = false;
  turns = 0;

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "gpt-5.6-luna", model: "gpt-5.6-luna" }] } as T;
    if (method === "thread/start")
      return {
        thread: { id: "thread-1" },
        model: "gpt-5.6-luna",
        instructionSources: [],
      } as T;
    if (method === "turn/start") {
      const turn = ++this.turns;
      queueMicrotask(() =>
        this.listener?.({
          method: "item/tool/call",
          id: 91,
          params: {
            threadId: "thread-1",
            turnId: `turn-${turn}`,
            callId: `call-${turn}`,
            tool: "move_to",
            arguments: { x: 3, y: 4 },
          },
        }),
      );
      return { turn: { id: `turn-${turn}` } } as T;
    }
    if (method === "turn/interrupt") return {} as T;
    throw new Error(`unexpected request ${method}`);
  }

  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
    const turn = this.turns;
    queueMicrotask(() => {
      this.listener?.({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turn}`,
          tokenUsage: {
            total: {
              inputTokens: 100 + (turn - 1) * 60,
              outputTokens: 20 + (turn - 1) * 15,
              cachedInputTokens: 10 + (turn - 1) * 40,
              cacheWriteInputTokens: 5,
            },
          },
        },
      });
      this.listener?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turn}`,
          item: { type: "agentMessage", text: `moving ${turn}` },
        },
      });
      this.listener?.({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: `turn-${turn}`, status: "completed", error: null },
        },
      });
    });
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("CodexAppServerClient", () => {
  it("reuses one isolated thread per agent session and records per-turn usage", async () => {
    const connection = new FakeConnection();
    const client = new CodexAppServerClient(
      "gpt-5.6-luna",
      { reasoningEffort: "low", maxTokens: 512 },
      async () => connection,
    );
    const execute = vi.fn().mockResolvedValue({ text: "accepted", isError: false });
    const req: DecideRequest = {
      session_id: "test:agent",
      system: "system",
      user: "observation",
      tools: [{ name: "move_to", description: "move", schema: { x: z.number(), y: z.number() } }],
      execute,
      maxTurns: 3,
      signal: new AbortController().signal,
    };

    const result = await client.decide(req);
    const second = await client.decide({ ...req, user: "next observation" });

    expect(execute).toHaveBeenCalledWith("move_to", { x: 3, y: 4 });
    const starts = connection.calls.filter((call) => call.method === "thread/start");
    expect(starts).toHaveLength(1);
    expect(connection.calls.filter((call) => call.method === "turn/start")).toHaveLength(2);
    const start = starts[0]!;
    expect(start.params as Record<string, unknown>).toMatchObject({
      model: "gpt-5.6-luna",
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "system",
      developerInstructions: "",
      dynamicTools: [{ type: "function", name: "move_to" }],
    });
    expect(connection.responses).toHaveLength(2);
    expect(connection.responses[0]).toEqual({
      id: 91,
      result: {
        contentItems: [{ type: "inputText", text: "accepted" }],
        success: true,
      },
    });
    expect(result).toMatchObject({
      response: "moving 1",
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 10,
      tool_calls: [{ name: "move_to", input: { x: 3, y: 4 }, result: "accepted" }],
      cost_estimated: true,
    });
    expect(result.cost_usd).toBeGreaterThan(0);
    expect(second).toMatchObject({
      response: "moving 2",
      input_tokens: 60,
      output_tokens: 15,
      cache_read_tokens: 40,
    });

    await client.close();
    expect(connection.closed).toBe(true);
  });
});
