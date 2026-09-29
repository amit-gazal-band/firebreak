# AGENTS.md

Guidance for coding agents working in this repo. Humans: start with [README.md](README.md).

Firebreak runs identical wildfire worlds side by side, one per team, and compares teams whose only difference is how their AI agents communicate. The design is in [docs/SPEC.md](docs/SPEC.md), the milestones in [docs/PLAN.md](docs/PLAN.md), and the measurements behind every default in [docs/TUNING.md](docs/TUNING.md).

## Layout

```
packages/engine    pure deterministic simulation: rules, scenario, observations, scripted bots, stream types (browser-safe)
packages/recorder  SQLite recordings: schema, writer, reader, metrics
packages/runtime   match runner, clock, agent loop, prompts, order tools, LLM backends (api, claude-code)
packages/teams     none, perfect, band (Band SDK), subagents, bots-*
packages/viewer    Vite + Canvas 2D viewer, built to one self-contained index.html
packages/cli       `firebreak` CLI: run, replay, verify, metrics, export, batch, report, serve
recordings/        curated recordings committed to the repo
runs/              local recordings, batch manifests, reports (git-ignored)
```

## Commands

```bash
pnpm install
pnpm test          # Vitest: engine rules + determinism, recording/replay, teams with a fake LLM (offline)
pnpm typecheck
pnpm lint
pnpm format
pnpm firebreak --help
```

Run all four before committing. Tests never call a model or Band.

## Using recordings

A recording (`*.sqlite`) is the source of truth for anything that happened in a match. To answer a question about a match, read the recording rather than re-running it: runs cost model usage and are not reproducible (LLMs are not deterministic, only the engine is).

- `pnpm firebreak list` finds recordings in `runs/` and `recordings/`; commands accept a path or a file name.
- `pnpm firebreak metrics <match>` prints per-team metrics as JSON (score, cost, latency, idle agent-ticks, stale actions, missed joint tasks, noise, forecast lead...). Definitions: SPEC §10, code: `packages/recorder/src/metrics.ts`.
- `pnpm firebreak report <files...>` aggregates several matches into HTML (mean ± sd). Only compare matches from the same prompt version and LLM backend.
- `pnpm firebreak verify <match>` re-runs the engine from the seed and recorded orders and compares every tick hash. Run it after any engine change on an old recording to see whether rules changed outcomes.
- Query with `sqlite3`. Tables: `match`, `match_config`, `world`, `tick_state`, `event`, `message`, `delivery`, `llm_call` (schema: `packages/recorder/src/schema.ts`; examples in README). World ids are `w<N>-<team>`; agent ids `scout`, `ff1`, `ff2`, `engineer`, `rescuer`, `orchestrator`.
- The exact prompts, tool definitions, config, git commit and package versions of a match are in `match_config` (`prompts`, `tools`, `resolved`, `code`). Use them instead of guessing what a match ran with.
- Never edit a recording; `verify` and every metric depend on it. Recordings in `recordings/` are curated: add one only when asked, and update `recordings/README.md` with it.

## Rules that keep results fair

These are the point of the project (SPEC §2, §5). Breaking them makes results meaningless.

- **One variable.** Every team uses the same model, settings, base prompt (`packages/runtime/src/agent/prompts.ts`), order tools, context budget and agent loop. Only the transport's tools and its short "COMMUNICATION" prompt section may differ.
- **Improvements to agent play go in shared code**, never in one team's prompt. If a fix only helps teams with messaging tools, put it in the shared rules text, worded for every messaging team (see prompt v3 in TUNING.md).
- **Faithful setups.** Each team uses its tool the way people really do. Don't weaken a competitor to make Band win, and document any behaviour change in `docs/TUNING.md` with before/after numbers.
- **Determinism.** The engine must stay pure: no `Math.random`, no clock, no I/O. Randomness goes through `roll(seed, tick, x, y, purpose)` so every world gets the same luck per tile and tick. `pnpm test` checks this.
- **Version bumps.** Bump `ENGINE_VERSION` (`packages/engine/src/index.ts`) when rules change outcomes, and `PROMPT_VERSION` (`packages/runtime/src/agent/prompts.ts`) when prompts change. Both are recorded with every match.

## Running matches

- LLM teams run on the Claude subscription by default (`llm.backend: claude-code`, local `claude` login). A four-team, 60-tick match is ~650–850 decisions and takes ~5 minutes. Batches can exhaust the subscription's usage window; the runner then aborts with `usage_limit` and the batch stops. Ask before starting batches.
- `--set llm.backend=api` uses `ANTHROPIC_API_KEY` instead (billed).
- Use scripted bots and virtual time for anything that doesn't need a model: `pnpm firebreak run --teams bots-none,bots-perfect --virtual`.
- The Band team needs `band_agents.yaml` (git-ignored; template: `band_agents.yaml.example`) and creates real rooms in that Band account. Only one match using the band team can run at a time on one set of Band agents.

## Secrets

`band_agents.yaml` and `.env` are git-ignored and must stay that way. Recordings never contain credentials: config values under secret-looking keys are redacted before they are written (`redact` in `packages/runtime/src/config.ts`), and the `claude-code` backend strips `ANTHROPIC_API_KEY` from its subprocess.
