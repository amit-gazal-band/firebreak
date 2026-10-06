import { DEFAULT_GAME_CONFIG, type GameConfig } from "@firebreak/engine";
import { parse } from "yaml";

export type LlmBackend = "api" | "claude-code" | "openai" | "codex";
export type ClockMode = "synchronized" | "realtime";

/** The full, resolved configuration of a match (SPEC §11). */
export interface MatchConfig {
  seed: number;
  ticks: number;
  tick_ms: number;
  clock: { mode: ClockMode };
  teams: string[];
  llm: {
    backend: LlmBackend;
    model: string;
    temperature: number;
    reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
    max_tokens: number;
    max_turns_per_decision: number;
  };
  budget: { usd: number; tokens: number };
  map: {
    size: number;
    houses: [number, number];
    civilians: [number, number];
    wind_shifts: [number, number];
    initial_fires: [number, number];
    extra_fires: [number, number];
    debris: number;
    forest_share: number;
  };
  fire: GameConfig["fire"];
  rules: {
    civilian_deadline: number;
    forecast_lead: number;
    water_capacity: number;
    clear_debris_ticks: number;
  };
  agent: {
    message_window: number;
    heartbeat_ticks: number;
    order_log: number;
    max_decisions_per_tick: number;
  };
  /** 0 keeps a sub-agent alive until it reports completion/blockage; positive values opt into a hard cap. */
  subagents: { max_lifetime_ticks: number };
  commentator: {
    enabled: boolean;
    interval_ticks: number;
    /** "same" inherits the gameplay backend/model. */
    backend: LlmBackend | "same";
    model: string;
    max_tokens: number;
    reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  band: { agents_file: string; rest_url: string; ws_url: string };
  record: { dir: string; prompts: boolean };
}

const G = DEFAULT_GAME_CONFIG;

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  seed: 42,
  ticks: G.ticks,
  tick_ms: 5000,
  clock: { mode: "synchronized" },
  teams: ["none", "perfect", "chat-mentions", "chat-broadcast"],
  llm: {
    backend: "claude-code",
    model: "claude-haiku-4-5-20251001",
    temperature: 0.2,
    reasoning_effort: "low",
    max_tokens: 1024,
    max_turns_per_decision: 3,
  },
  budget: { usd: 5, tokens: 10_000_000 },
  map: {
    size: G.size,
    houses: G.houses,
    civilians: G.civilians,
    wind_shifts: G.wind_shifts,
    initial_fires: G.initial_fires,
    extra_fires: G.extra_fires,
    debris: G.debris,
    forest_share: G.forest_share,
  },
  fire: G.fire,
  rules: {
    civilian_deadline: G.civilian_deadline,
    forecast_lead: G.forecast_lead,
    water_capacity: G.water_capacity,
    clear_debris_ticks: G.clear_debris_ticks,
  },
  agent: { message_window: 30, heartbeat_ticks: 3, order_log: 5, max_decisions_per_tick: 3 },
  subagents: { max_lifetime_ticks: 0 },
  commentator: {
    enabled: false,
    interval_ticks: 10,
    backend: "claude-code",
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2400,
    reasoning_effort: "low",
  },
  band: {
    agents_file: "band_agents.yaml",
    rest_url: "https://app.band.ai",
    ws_url: "wss://app.band.ai/api/v1/socket/websocket",
  },
  record: { dir: "runs", prompts: true },
};

export function toGameConfig(c: MatchConfig): GameConfig {
  return {
    ...G,
    ...c.map,
    ...c.rules,
    ticks: c.ticks,
    fire: { ...c.fire },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Set a dotted path, e.g. "llm.backend=api" from the CLI. Values are parsed as YAML scalars. */
export function setPath(obj: Record<string, unknown>, path: string, raw: string): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = parse(raw);
}

export interface ResolvedConfig {
  config: MatchConfig;
  source_text: string | null;
  source_path: string | null;
  overrides: Record<string, unknown>;
}

export function resolveConfig(opts: {
  sourceText?: string | null;
  sourcePath?: string | null;
  base?: unknown;
  overrides?: Record<string, unknown>;
}): ResolvedConfig {
  const fromFile = opts.sourceText ? (parse(opts.sourceText) as unknown) : {};
  let config = deepMerge(DEFAULT_MATCH_CONFIG, opts.base ?? {});
  config = deepMerge(config, fromFile);
  config = deepMerge(config, opts.overrides ?? {});
  validateConfig(config);
  return {
    config,
    source_text: opts.sourceText ?? null,
    source_path: opts.sourcePath ?? null,
    overrides: opts.overrides ?? {},
  };
}

export function validateConfig(c: MatchConfig): void {
  if (!Number.isInteger(c.seed)) throw new Error("seed must be an integer");
  if (c.ticks < 1) throw new Error("ticks must be >= 1");
  if (c.tick_ms < 0) throw new Error("tick_ms must be >= 0");
  if (!["synchronized", "realtime"].includes(c.clock.mode))
    throw new Error(`unknown clock.mode ${c.clock.mode}`);
  if (!["api", "claude-code", "openai", "codex"].includes(c.llm.backend))
    throw new Error(`unknown llm.backend ${c.llm.backend}`);
  if (c.teams.length === 0) throw new Error("teams must not be empty");
  if (!Number.isInteger(c.commentator.interval_ticks) || c.commentator.interval_ticks < 1)
    throw new Error("commentator.interval_ticks must be an integer >= 1");
  if (c.commentator.max_tokens < 1) throw new Error("commentator.max_tokens must be >= 1");
  if (
    c.commentator.backend !== "same" &&
    !["api", "claude-code", "openai", "codex"].includes(c.commentator.backend)
  )
    throw new Error(`unknown commentator.backend ${c.commentator.backend}`);
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|authorization)/i;

/** Replace values under secret-looking keys, recursively (SPEC §8.2: secrets are never stored). */
export function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redact) as T;
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v))
    out[k] = SECRET_KEY.test(k) && typeof val === "string" ? "<redacted>" : redact(val);
  return out as T;
}
