import { z } from "zod";
import { ClaudeCodeClient } from "../src/llm/claude-code";

const c = new ClaudeCodeClient("claude-haiku-4-5-20251001");
const tools = [
  { name: "extinguish", description: "Extinguish the fire at x,y", schema: { x: z.number().int(), y: z.number().int() } },
  { name: "wait", description: "Do nothing", schema: {} },
];
const run = async (i: number, bad = false) => {
  const t0 = performance.now();
  const r = await c.decide({
    system: "You control a firefighter in a grid game. Always act by calling exactly one tool.",
    user: `Tick ${i}. You are at (3,4) with 2 water. A fire is at (4,4) intensity 1. Decide.`,
    tools,
    execute: async (name, input) => bad && !r0 ? ((r0 = true), { text: "rejected: not adjacent, use (4,4)", isError: true }) : { text: `accepted ${name} ${JSON.stringify(input)}`, isError: false },
    maxTurns: 3,
    signal: new AbortController().signal,
  });
  return `${(performance.now() - t0).toFixed(0)}ms ${JSON.stringify({ calls: r.tool_calls.map((c) => c.name + ":" + c.result.slice(0, 12)), in: r.input_tokens, out: r.output_tokens, cost: r.cost_usd.toFixed(5), err: r.error })}`;
};
let r0 = false;
console.log(await run(0));
console.log(await run(1, true));
const t0 = performance.now();
const par = await Promise.all([2, 3, 4, 5, 6].map((i) => run(i)));
console.log("5 in parallel:", (performance.now() - t0).toFixed(0), "ms"); par.forEach((p) => console.log(" ", p));
