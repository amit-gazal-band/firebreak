import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";
import { costUsd } from "./pricing";
import type { DecideRequest, DecideResult, LlmClient } from "./types";

const SERVER = "game";

/**
 * Environment for the Claude Code subprocess: subscription auth only.
 * ANTHROPIC_API_KEY is removed so the run can never silently bill an API key,
 * and CLAUDE_CODE_* session variables of a parent Claude Code session are dropped.
 */
function subscriptionEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ANTHROPIC_API_KEY" || k === "CLAUDECODE") continue;
    if (k.startsWith("CLAUDE_CODE_") && k !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "firebreak/0.1.0";
  return env;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  chars: number;
}

/**
 * `claude-code` backend: Claude Agent SDK on a Claude subscription login (SPEC §6.3).
 * One fresh query() per decision, so decisions are stateless like the `api` backend.
 * The result is returned as soon as the decision is complete; the subprocess is shut
 * down in the background (waiting for it costs ~2 s per call).
 */
export class ClaudeCodeClient implements LlmClient {
  readonly backend = "claude-code" as const;

  constructor(readonly model: string) {}

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
    let turnHadError = false;
    const server = createSdkMcpServer({
      name: SERVER,
      version: "0.1.0",
      tools: req.tools.map((t) =>
        tool(t.name, t.description, t.schema, async (args) => {
          const r = await req.execute(t.name, args as Record<string, unknown>);
          out.tool_calls.push({ name: t.name, input: args, result: r.text });
          turnHadError ||= r.isError;
          return { content: [{ type: "text" as const, text: r.text }], isError: r.isError };
        }),
      ),
    });

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    const usage = new Map<string, Usage>();
    let sdkCost: number | null = null;
    const q = query({
      prompt: req.user,
      options: {
        model: this.model,
        systemPrompt: req.system,
        // Same as the api backend: no extended thinking (it also costs ~10 s per decision).
        thinking: { type: "disabled" },
        maxTurns: req.maxTurns + 1,
        tools: [],
        mcpServers: { [SERVER]: server },
        // Only the game's tools: never load the account's claude.ai connectors or other MCP config.
        strictMcpConfig: true,
        allowedTools: req.tools.map((t) => `mcp__${SERVER}__${t.name}`),
        settingSources: [],
        persistSession: false,
        cwd: tmpdir(),
        env: subscriptionEnv(),
        abortController: ac,
      },
    });
    try {
      for (;;) {
        const next = await q.next();
        if (next.done) break;
        const msg = next.value as { type: string; [k: string]: unknown };
        if (msg.type === "rate_limit_event") {
          const info = msg.rate_limit_info as
            { status?: string; resetsAt?: number; rateLimitType?: string } | undefined;
          if (info?.status === "rejected") {
            out.fatal = "usage_limit";
            const resets = info.resetsAt ? `; resets ${new Date(info.resetsAt * 1000).toLocaleString()}` : "";
            out.error = `claude-code: subscription usage limit reached (${info.rateLimitType ?? "limit"}${resets})`;
            break;
          }
        } else if (msg.type === "assistant") {
          const err = msg.error as string | undefined;
          if (err === "rate_limit" || err === "billing_error") out.fatal = "usage_limit";
          if (err === "authentication_failed" || err === "oauth_org_not_allowed") out.fatal = "auth";
          if (err) out.error = `claude-code: ${err}`;
          const m = msg.message as {
            id: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            content: { type: string; text?: string; input?: unknown }[];
          };
          const prev = usage.get(m.id);
          let chars = prev?.chars ?? 0;
          for (const block of m.content) {
            if (block.type === "text" && block.text) {
              out.response += (out.response ? "\n" : "") + block.text;
              chars += block.text.length;
            }
            if (block.type === "tool_use") chars += JSON.stringify(block.input ?? {}).length + 20;
          }
          const u = m.usage ?? {};
          usage.set(m.id, {
            input: Math.max(prev?.input ?? 0, u.input_tokens ?? 0),
            output: Math.max(prev?.output ?? 0, u.output_tokens ?? 0),
            cacheRead: Math.max(prev?.cacheRead ?? 0, u.cache_read_input_tokens ?? 0),
            cacheWrite: Math.max(prev?.cacheWrite ?? 0, u.cache_creation_input_tokens ?? 0),
            chars,
          });
          if (out.fatal) break;
        } else if (msg.type === "user") {
          // Tool results of a turn came back. Like the api backend, continue only when a call was rejected.
          const content = (msg.message as { content: unknown }).content;
          const hasResults =
            Array.isArray(content) && content.some((b) => (b as { type?: string }).type === "tool_result");
          if (hasResults) {
            if (!turnHadError) break;
            turnHadError = false;
          }
        } else if (msg.type === "result") {
          sdkCost = msg.total_cost_usd as number;
          const subtype = msg.subtype as string;
          if (subtype !== "success" && subtype !== "error_max_turns") out.error = `claude-code: ${subtype}`;
          break;
        }
      }
    } catch (e) {
      if (!req.signal.aborted) {
        out.error = e instanceof Error ? e.message : String(e);
        if (/usage limit|rate limit|429/i.test(out.error)) out.fatal = "usage_limit";
        if (/log ?in|authenticat|401/i.test(out.error)) out.fatal = "auth";
      }
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      ac.abort();
      void q.return(undefined).catch(() => {});
    }
    let cacheWrite = 0;
    for (const u of usage.values()) {
      out.input_tokens += u.input + u.cacheRead + u.cacheWrite;
      // Streamed usage can under-report output; fall back to a length estimate.
      out.output_tokens += Math.max(u.output, Math.ceil(u.chars / 4));
      out.cache_read_tokens += u.cacheRead;
      cacheWrite += u.cacheWrite;
    }
    out.cost_usd =
      sdkCost ??
      costUsd(this.model, {
        input: out.input_tokens - out.cache_read_tokens - cacheWrite,
        output: out.output_tokens,
        cacheRead: out.cache_read_tokens,
        cacheWrite,
      }).usd;
    return out;
  }
}
