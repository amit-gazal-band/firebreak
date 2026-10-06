import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommentaryFrame, RecordingBundle } from "@firebreak/engine";
import { loadBundle, openRecording, readConfig } from "@firebreak/recorder";
import {
  COMMENTATOR_PROMPT_VERSION,
  COMMENTATOR_SYSTEM,
  createLlmClient,
  generateCommentary,
  resolveConfig,
  type LlmClient,
  type MatchConfig,
} from "@firebreak/runtime";
import { REPO_ROOT } from "./paths";

interface CommentarySidecar {
  schema_version: 1;
  match_id: string;
  recording_created_at: string;
  commentator_prompt_version: string;
  system_prompt: string;
  generated_at: string;
  backend: string;
  model: string;
  interval_ticks: number;
  max_tokens: number;
  reasoning_effort: string;
  frames: CommentaryFrame[];
}

const inflight = new Map<string, Promise<CommentaryFrame[]>>();

const DEFAULT_COMMENTARY_DIR = join(REPO_ROOT, "runs", "commentary");

export function commentaryPath(header: RecordingBundle["header"], cacheDir = DEFAULT_COMMENTARY_DIR): string {
  const safe = header.match_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(cacheDir, `${safe}-v${COMMENTATOR_PROMPT_VERSION}.json`);
}

export function loadSavedCommentary(
  recording: string,
  bundle = loadBundle(recording),
  cacheDir = DEFAULT_COMMENTARY_DIR,
): CommentaryFrame[] {
  const path = commentaryPath(bundle.header, cacheDir);
  if (!existsSync(path)) return [];
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as CommentarySidecar;
    if (
      saved.schema_version !== 1 ||
      saved.match_id !== bundle.header.match_id ||
      saved.commentator_prompt_version !== COMMENTATOR_PROMPT_VERSION
    )
      return [];
    const worlds = new Set(bundle.header.teams.map((t) => t.world_id));
    return saved.frames.filter((f) => f.kind === "commentary" && worlds.has(f.world_id));
  } catch {
    return [];
  }
}

export function loadReplayBundle(
  recording: string,
  opts: { prompts?: boolean; cacheDir?: string } = {},
): RecordingBundle {
  const bundle = loadBundle(recording, opts);
  bundle.frames.push(...loadSavedCommentary(recording, bundle, opts.cacheDir));
  return bundle;
}

function commentatorMatchConfig(config: MatchConfig): MatchConfig {
  const c = config.commentator;
  return {
    ...config,
    llm: {
      ...config.llm,
      backend: c.backend === "same" ? config.llm.backend : c.backend,
      model: c.model === "same" ? config.llm.model : c.model,
      max_tokens: c.max_tokens,
      reasoning_effort: c.reasoning_effort,
    },
  };
}

function recordedConfig(recording: string): MatchConfig {
  const db = openRecording(recording);
  try {
    const sections = readConfig(db);
    return resolveConfig({ base: sections.resolved }).config;
  } finally {
    db.close();
  }
}

export async function ensureCommentary(
  recording: string,
  options: { llm?: LlmClient; config?: MatchConfig; cacheDir?: string } = {},
): Promise<CommentaryFrame[]> {
  const bundle = loadBundle(recording);
  const cacheDir = options.cacheDir ?? DEFAULT_COMMENTARY_DIR;
  const existing = loadSavedCommentary(recording, bundle, cacheDir);
  if (existing.length === bundle.header.teams.length) return existing;
  const path = commentaryPath(bundle.header, cacheDir);
  const active = inflight.get(path);
  if (active) return active;
  const task = (async () => {
    const config = options.config ?? recordedConfig(recording);
    const llm = options.llm ?? createLlmClient(commentatorMatchConfig(config));
    let frames: CommentaryFrame[];
    try {
      frames = await generateCommentary(bundle, llm, {
        intervalTicks: config.commentator.interval_ticks,
        includePrompts: config.record.prompts,
      });
    } finally {
      if (!options.llm) await llm.close?.();
    }
    const sidecar: CommentarySidecar = {
      schema_version: 1,
      match_id: bundle.header.match_id,
      recording_created_at: bundle.header.created_at,
      commentator_prompt_version: COMMENTATOR_PROMPT_VERSION,
      system_prompt: COMMENTATOR_SYSTEM,
      generated_at: new Date().toISOString(),
      backend: llm.backend,
      model: llm.model,
      interval_ticks: config.commentator.interval_ticks,
      max_tokens: config.commentator.max_tokens,
      reasoning_effort: config.commentator.reasoning_effort,
      frames,
    };
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(sidecar, null, 2));
    renameSync(tmp, path);
    return frames;
  })().finally(() => inflight.delete(path));
  inflight.set(path, task);
  return task;
}
