import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { listRecordings } from "@firebreak/recorder";
import { RECORDING_DIRS, RUNS_DIR, loadResolvedConfig, relRuns, runMatch } from "./run";
import { verifyRecording } from "./verify";

const HELP = `firebreak — multi-agent communication showdown

Usage:
  firebreak run [--config FILE] [--seed N] [--teams a,b,c] [--set key=value]... [--virtual] [--config-from MATCH] [--live] [--port N]
  firebreak verify MATCH
  firebreak list
  firebreak serve [--port N]              viewer for recordings (and live matches)
  firebreak replay MATCH [--port N]       open a recording in the viewer
  firebreak export MATCH [--out FILE]     single-file HTML replay
  firebreak batch --seeds N [--config FILE] [--first-seed N] [--set key=value]... [--yes]
  firebreak report [MATCH...] [--out FILE]

MATCH is a path to a .sqlite recording, or its file name inside runs/ or recordings/.
`;

export function matchPath(p: string): string {
  if (p.includes("/")) return resolve(process.env.INIT_CWD ?? process.cwd(), p);
  const file = p.endsWith(".sqlite") ? p : `${p}.sqlite`;
  for (const dir of RECORDING_DIRS) if (existsSync(resolve(dir, file))) return resolve(dir, file);
  return resolve(RUNS_DIR, file);
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      "config-from": { type: "string" },
      seed: { type: "string" },
      teams: { type: "string" },
      set: { type: "string", multiple: true },
      virtual: { type: "boolean" },
      live: { type: "boolean" },
      port: { type: "string" },
      out: { type: "string" },
      seeds: { type: "string" },
      "first-seed": { type: "string" },
      yes: { type: "boolean", short: "y" },
      prompts: { type: "boolean" },
      open: { type: "boolean" },
    },
  });
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const runArgs = {
    ...(values.config ? { configPath: resolve(cwd, values.config) } : {}),
    ...(values["config-from"] ? { configFrom: matchPath(values["config-from"]) } : {}),
    ...(values.seed ? { seed: Number(values.seed) } : {}),
    ...(values.teams ? { teams: values.teams.split(",").map((s) => s.trim()) } : {}),
    sets: values.set ?? [],
    virtual: values.virtual ?? false,
    cliArgs: argv,
  };
  const port = values.port ? Number(values.port) : 5173;

  switch (cmd) {
    case "run": {
      const rc = loadResolvedConfig(runArgs);
      const c = rc.config;
      const log = (l: string) => console.log(l);
      let live: { sink: import("@firebreak/recorder").FrameSink; url: string; close(): void } | undefined;
      if (values.live) {
        const { startServer } = await import("./server");
        live = await startServer({ port, live: true });
        console.log(`live viewer: ${live.url}`);
      }
      console.log(
        `match: seed ${c.seed}, teams ${c.teams.join(", ")}, ${c.ticks} ticks × ${c.tick_ms} ms` +
          (runArgs.virtual ? " (virtual time)" : "") +
          (c.teams.some((t) => !t.startsWith("bots")) ? `, llm ${c.llm.backend}/${c.llm.model}` : ""),
      );
      const { file, result } = await runMatch(rc, {
        virtual: runArgs.virtual,
        cliArgs: argv,
        ...(live ? { extraSinks: [live.sink] } : {}),
        log,
      });
      console.log(`\n${result.status}${result.reason ? ` (${result.reason})` : ""}`);
      for (const r of result.results)
        console.log(
          `  ${r.team.padEnd(14)} score ${String(r.score).padStart(4)}   $${r.cost_usd.toFixed(3)}`,
        );
      console.log(`recording: ${relRuns(file)}`);
      if (live) {
        console.log("viewer still running — Ctrl+C to exit");
        await new Promise(() => {});
      }
      return result.status === "completed" ? 0 : 2;
    }
    case "verify": {
      const p = positionals[0];
      if (!p) throw new Error("verify needs a MATCH");
      const r = verifyRecording(matchPath(p));
      console.log(`scenario matches seed: ${r.scenario_ok ? "yes" : "NO"}`);
      for (const w of r.worlds)
        console.log(
          `  ${w.world_id.padEnd(18)} ${w.ticks} ticks  ${w.mismatch_tick === null ? "ok" : `MISMATCH at tick ${w.mismatch_tick}`}`,
        );
      console.log(r.ok ? "verified" : "verification FAILED");
      return r.ok ? 0 : 1;
    }
    case "list": {
      for (const s of RECORDING_DIRS.flatMap((d) => listRecordings(d))) {
        console.log(
          `${s.file}  ${s.status}${s.abort_reason ? `(${s.abort_reason})` : ""}  ` +
            s.teams.map((t) => `${t.team}:${t.score ?? "-"}`).join("  "),
        );
      }
      return 0;
    }
    case "serve":
    case "replay": {
      const { startServer } = await import("./server");
      const srv = await startServer({ port, live: false });
      const target =
        cmd === "replay" && positionals[0]
          ? `${srv.url}/?rec=${encodeURIComponent(matchPath(positionals[0]).split("/").pop()!)}`
          : srv.url;
      console.log(`viewer: ${target}`);
      await new Promise(() => {});
      return 0;
    }
    case "export": {
      const { exportHtml } = await import("./export");
      const p = positionals[0];
      if (!p) throw new Error("export needs a MATCH");
      const out = exportHtml(matchPath(p), values.out ? resolve(cwd, values.out) : undefined, {
        prompts: values.prompts ?? false,
      });
      console.log(`wrote ${out}`);
      return 0;
    }
    case "batch": {
      const { runBatch } = await import("./batch");
      return runBatch({
        ...runArgs,
        seeds: Number(values.seeds ?? 20),
        firstSeed: Number(values["first-seed"] ?? 1),
        yes: values.yes ?? false,
      });
    }
    case "report": {
      const { writeReport } = await import("./report");
      const files = positionals.length ? positionals.map(matchPath) : undefined;
      const out = writeReport(files, values.out ? resolve(cwd, values.out) : undefined);
      console.log(`wrote ${out}`);
      return 0;
    }
    default:
      console.log(HELP);
      return cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
