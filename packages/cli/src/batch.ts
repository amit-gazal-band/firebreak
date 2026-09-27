import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { teamFactory } from "@firebreak/teams";
import { RUNS_DIR, loadResolvedConfig, relRuns, runMatch, type RunArgs } from "./run";

/** Rough per-decision cost, measured on Haiku 4.5 (docs/TUNING.md). */
const USD_PER_CALL = 0.004;
/** Decisions per agent per tick, measured on real matches. */
const CALLS_PER_AGENT_TICK = 0.7;

export async function runBatch(
  a: RunArgs & { seeds: number; firstSeed: number; yes: boolean },
): Promise<number> {
  const base = loadResolvedConfig(a);
  const c = base.config;
  const llmTeams = c.teams.map(teamFactory).filter((t) => t.usesLlm);
  const bodies = llmTeams.length * 5 + (c.teams.includes("subagents") ? 1 : 0);
  const calls = Math.round(bodies * c.ticks * CALLS_PER_AGENT_TICK * a.seeds);
  const minutes = ((c.ticks * c.tick_ms) / 60000) * a.seeds;
  console.log(
    `batch: ${a.seeds} matches (seeds ${a.firstSeed}..${a.firstSeed + a.seeds - 1}), teams ${c.teams.join(", ")}`,
  );
  if (llmTeams.length) {
    console.log(
      `estimate: ~${calls} LLM calls, ~$${(calls * USD_PER_CALL).toFixed(2)}, ~${Math.ceil(minutes)} min`,
    );
    if (c.llm.backend === "claude-code")
      console.log("backend claude-code: this counts against your Claude subscription's usage limits.");
    if (!a.yes) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await rl.question("continue? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (ans !== "y" && ans !== "yes") return 1;
    }
  }
  const files: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifest = join(RUNS_DIR, `batch-${stamp}.json`);
  for (let i = 0; i < a.seeds; i++) {
    const seed = a.firstSeed + i;
    const rc = loadResolvedConfig({ ...a, seed });
    console.log(`\n[${i + 1}/${a.seeds}] seed ${seed}`);
    const { file, result } = await runMatch(rc, {
      virtual: a.virtual,
      cliArgs: [...a.cliArgs, `--seed=${seed}`],
    });
    files.push(file);
    writeFileSync(
      manifest,
      JSON.stringify(
        { created_at: stamp, config: a.cliArgs, files: files.map((f) => f.split("/").pop()) },
        null,
        2,
      ),
    );
    console.log(
      `  ${result.status}${result.reason ? ` (${result.reason})` : ""}: ` +
        result.results.map((r) => `${r.team} ${r.score}`).join(" | "),
    );
    if (result.status === "aborted" && result.reason === "usage_limit") {
      console.log("stopping: usage limit reached");
      break;
    }
    if (result.status === "aborted" && result.reason === "interrupted") break;
  }
  console.log(`\nbatch manifest: ${relRuns(manifest)}\nreport: pnpm firebreak report`);
  return 0;
}
