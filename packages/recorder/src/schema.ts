export const SCHEMA_VERSION = 2;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS match (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  abort_reason TEXT,
  header_json TEXT NOT NULL,
  results_json TEXT
);

-- The full run configuration, one row per section (SPEC §8.2):
-- resolved, source_text, cli_args, llm, prompts, tools, code, environment.
CREATE TABLE IF NOT EXISTS match_config (
  section TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world (
  world_id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  label TEXT NOT NULL,
  final_score INTEGER,
  cost_usd REAL
);

CREATE TABLE IF NOT EXISTS tick_state (
  world_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (world_id, tick)
);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_type ON event (world_id, type);

CREATE TABLE IF NOT EXISTS message (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  sender TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS delivery (
  message_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  stage TEXT NOT NULL,
  t_ms INTEGER NOT NULL,
  PRIMARY KEY (message_id, recipient, stage)
);

CREATE TABLE IF NOT EXISTS llm_call (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  latency_ms INTEGER,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  cost_estimated INTEGER NOT NULL,
  prompt TEXT,
  response TEXT NOT NULL,
  tool_calls_json TEXT NOT NULL,
  error TEXT
);

-- Frame order as written, so a replay reproduces the exact live sequence.
CREATE TABLE IF NOT EXISTS frame_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL
);
`;
