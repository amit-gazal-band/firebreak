import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { tmpdir } from "node:os";

const env: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) if (!(k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || k === "ANTHROPIC_API_KEY")) env[k] = v;
for (let i = 0; i < 2; i++) {
  const t0 = performance.now();
  const ms = () => (performance.now() - t0).toFixed(0);
  const ac = new AbortController();
  const server = createSdkMcpServer({ name: "game", tools: [tool("extinguish", "Extinguish x,y", { x: z.number(), y: z.number() }, async () => { console.log("  tool called", ms()); return { content: [{ type: "text", text: "ok" }] }; })] });
  const q = query({ prompt: "Fire at (4,4). Call extinguish.", options: { model: "claude-haiku-4-5-20251001", systemPrompt: "Call exactly one tool.", maxTurns: 2, tools: [], mcpServers: { game: server }, allowedTools: ["mcp__game__extinguish"], settingSources: [], persistSession: false, cwd: tmpdir(), env, abortController: ac } });
  for await (const m of q) {
    const u = (m as any).message?.usage;
    console.log(`  ${m.type}/${(m as any).subtype ?? ""} at ${ms()}ms`, u ? `in=${u.input_tokens} cr=${u.cache_read_input_tokens} cw=${u.cache_creation_input_tokens}` : "");
    if (m.type === "user") { ac.abort(); break; }
  }
  console.log("total", ms());
}
