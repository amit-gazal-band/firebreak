import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { StreamFrame } from "@firebreak/engine";
import { RecordingWriter, openRecording, readConfig, type FrameSink } from "@firebreak/recorder";
import {
  MatchRunner,
  createLlmClient,
  provenance,
  redact,
  resolveConfig,
  setPath,
  type ClockMode,
  type MatchConfig,
  type MatchResult,
  type ResolvedConfig,
} from "@firebreak/runtime";
import { teamFactory } from "@firebreak/teams";
import { REPO_ROOT } from "./paths";
import { ensureCommentary } from "./commentary";

export interface RunArgs {
  configPath?: string;
  configFrom?: string;
  seed?: number;
  teams?: string[];
  commentary?: boolean;
  sets: string[];
  clockMode?: ClockMode;
  cliArgs: string[];
}

export function loadResolvedConfig(a: RunArgs): ResolvedConfig {
  const overrides: Record<string, unknown> = {};
  for (const s of a.sets) {
    const i = s.indexOf("=");
    if (i < 0) throw new Error(`--set expects key=value, got ${s}`);
    setPath(overrides, s.slice(0, i), s.slice(i + 1));
  }
  if (a.seed !== undefined) overrides.seed = a.seed;
  if (a.teams) overrides.teams = a.teams;
  if (a.commentary) setPath(overrides, "commentator.enabled", "true");
  if (a.clockMode) setPath(overrides, "clock.mode", a.clockMode);
  let base: unknown = undefined;
  if (a.configFrom) {
    const db = openRecording(a.configFrom);
    const recorded = (readConfig(db).resolved as Record<string, unknown> | undefined) ?? undefined;
    // Recordings made before clock.mode existed used the wall-clock runner.
    base = recorded && !("clock" in recorded) ? { ...recorded, clock: { mode: "realtime" } } : recorded;
    db.close();
  }
  const sourceText = a.configPath ? readFileSync(a.configPath, "utf8") : null;
  return resolveConfig({ sourceText, sourcePath: a.configPath ?? null, base, overrides });
}

export function matchId(c: MatchConfig): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-s${c.seed}-${Math.random().toString(36).slice(2, 6)}`;
}

export async function runMatch(
  rc: ResolvedConfig,
  opts: { cliArgs: string[]; extraSinks?: FrameSink[]; log?: (l: string) => void },
): Promise<{ file: string; result: MatchResult }> {
  const config = rc.config;
  const teams = config.teams.map(teamFactory);
  const usesLlm = teams.some((t) => t.usesLlm);
  const llm = usesLlm ? createLlmClient(config) : null;
  const id = matchId(config);
  const file = resolve(REPO_ROOT, config.record.dir, `${id}.sqlite`);
  const writer = new RecordingWriter(file);
  const prov = provenance(REPO_ROOT);
  const sections = {
    resolved: redact(config),
    source_text: rc.source_text,
    source_path: rc.source_path,
    cli_args: opts.cliArgs,
    overrides: redact(rc.overrides),
    llm: usesLlm ? { ...config.llm } : { backend: "none" },
    code: prov.code,
    environment: {
      ...prov.environment,
      band: { rest_url: config.band.rest_url, ws_url: config.band.ws_url },
    },
  };
  const runner = new MatchRunner({
    matchId: id,
    config,
    teams,
    sinks: [writer, ...(opts.extraSinks ?? [])],
    configSections: sections,
    onConfigSection: (s, v) => writer.setConfig(s, v),
    llm,
    ...(opts.log ? { log: opts.log } : {}),
  });
  const header = runner.header();
  writer.begin(header, sections);
  for (const s of opts.extraSinks ?? []) (s as { begin?: (h: typeof header) => void }).begin?.(header);
  const onSig = () => runner.abort("interrupted");
  process.once("SIGINT", onSig);
  let result: MatchResult;
  try {
    result = await runner.run();
  } finally {
    process.off("SIGINT", onSig);
    try {
      await llm?.close?.();
    } catch (e) {
      opts.log?.(`LLM shutdown failed: ${e instanceof Error ? e.message : e}`);
    }
    writer.close();
  }
  if (config.commentator.enabled) {
    opts.log?.("generating replay commentary (post-match; gameplay is already fixed)…");
    try {
      const commentary = await ensureCommentary(file, { config });
      for (const frame of commentary) for (const sink of opts.extraSinks ?? []) sink.write(frame);
      opts.log?.(`saved ${commentary.length} team broadcasts`);
    } catch (e) {
      opts.log?.(`commentary generation failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { file, result };
}

export function relRuns(file: string): string {
  return file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
}

export type { StreamFrame };
export const RUNS_DIR = join(REPO_ROOT, "runs");
/** Curated recordings committed to the repo. */
export const RECORDINGS_DIR = join(REPO_ROOT, "recordings");
/** Where to look for a recording by file name: local runs first, then the committed ones. */
export const RECORDING_DIRS = [RUNS_DIR, RECORDINGS_DIR];
