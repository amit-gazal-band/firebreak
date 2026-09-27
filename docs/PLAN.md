# Firebreak — Implementation Plan

Companion to [SPEC.md](SPEC.md). Section references (§) point there.

Build order: **engine → recording/replay → viewer → LLM agents → real teams → metrics**. The viewer and replay are built and tested with scripted (non-LLM) bots before any tokens are spent. The game is tuned with the reference teams before any real communication method is compared.

Sizes: **S** ≈ 1 day, **M** ≈ 2–3 days, **L** ≈ 1 week.

## Status (2026-09-27)

| Milestone | Status | Notes |
|---|---|---|
| M0 Scaffold | done | pnpm workspace, strict TS, Vitest, ESLint, Prettier, CI |
| M1 Engine | done | deterministic, shared per-tile randomness, scripted bots |
| M2 Recorder and replay core | done | one SQLite file per match (`node:sqlite`), config stored with it, `verify` |
| M3 Viewer | done | Canvas 2D instead of PixiJS; single-file build |
| M4 LLM runtime and reference teams | done | both backends; `claude-code` tuned to ~4 s/decision |
| M5 Tune the game | first pass | bot sweep + prompt v2; gap confirmed on seed 5; batch in docs/TUNING.md |
| M6 Band team | done | real Band rooms; delivery semantics measured |
| M7 Sub-agent team | done | orchestrator + spawn/report, hub-and-spoke in the viewer |
| M8 Metrics and batch | done | metrics as SQL over recordings; `batch`, `report` |
| M9 Demo polish | partly | `export` works; showcase seeds still to pick |

---

## v0: Band vs sub-agents, plus reference teams

### M0: Scaffold (S)
- pnpm workspace with the `packages/*` from §12, TypeScript strict, Vitest, ESLint/Prettier.
- `cli` package with an empty `firebreak` command.
- GitHub Actions: lint, typecheck, test.
- `.env.example` (ANTHROPIC_API_KEY, BAND_* per agent), `runs/` git-ignored.

**Done when:** `pnpm i && pnpm test` passes on a clean clone, and CI is green.

### M1: Engine (L)
- Types for tiles, world state, agents, orders, observations (§4).
- Map generation from a seed (lake, river, bridge, roads, houses, forest).
- Hashed randomness `roll(seed, tick, x, y, purpose)` (§5).
- Scheduled event generation from the seed (§4.5).
- Tick function `step(state, ordersThisTick) → state`, in the order of §4.4.
- Pathfinding for `move_to`, and order lifecycle (active / completed / blocked).
- Observation builder per agent, plus the "union" builder for `perfect` (§4.7, §7.2).
- Scoring (§4.6) and a state hash.
- **Scripted bots**: simple rule-based agents (go to nearest fire, etc.) for tests and viewer development.
- Tests: rules unit tests, determinism (same seed + orders → same hashes), identical rolls across diverged worlds.

**Done when:** a 60-tick, 4-world match with scripted bots runs in under 1 s and is fully deterministic.

### M2: Recorder and replay core (M)
- SQLite schema from §8.2 (`better-sqlite3`), writer and reader.
- Store the full resolved configuration with every recording (config, code versions, environment; secrets redacted), and `run --config-from <match>` (§8.2).
- Match runner (`runtime`): tick clock (real or accelerated), N worlds, writes `tick_state`/`event` as it goes.
- Event stream API: a live websocket that tails the match being written, and a reader over a recording file (§8.4).
- `firebreak run --bots scripted` and `firebreak verify <match>` (§8.5).

**Done when:** a scripted-bot match is recorded to one `.sqlite` file, and `verify` passes on it.

### M3: Viewer (L)
- Vite + PixiJS app that connects to the event stream.
- Board renderer: tiles, fire intensity, agents, civilians, fog of war (§9).
- Multi-board grid layout with team labels and scores.
- Replay player: virtual clock, speeds 0.5/1/2/4/10×, pause, scrubber with event markers, ±1 tick, instant seek via snapshots (§8.3).
- Interpolated agent movement between ticks.
- Message lines layer (fed by fake messages from scripted bots at this stage).
- `firebreak replay <match>` opens the viewer on a recording.

**Done when:** a recorded scripted match replays smoothly at 10×, and seeking to any tick is instant.

### M4: LLM agent runtime and reference teams (L)
- `LlmClient` interface with two backends: `api` (Anthropic SDK, API key) and `claude-code` (Claude Agent SDK, subscription login). Token/cost/latency accounting, per-match budget cap, usage-limit abort (§6.3).
- Order tools per role, validation errors as tool results, turn limit per decision (§6.4).
- Measure per-call latency on both backends; record the numbers in `docs/TUNING.md`.
- Agent loop, wake triggers, and trigger merging (§6.1–6.2).
- Base prompt per role, plus a per-transport tools section.
- `Transport` interface with delivery logging (`sent_at` / `delivered_at` / `consumed_at`) (§7).
- `none` and `perfect` teams (§7.1–7.2).
- `llm_call` recording, and an inspector panel in the viewer (§9).

**Done when:** a full 60-tick match with `none` and `perfect` runs live on **each** backend, is recorded, and replays, including the inspector.

### M5: Tune the game (M)
- Run `none` vs `perfect` across ~10 seeds.
- Adjust spread rate, tick length, vision radius, civilian deadlines, and joint-fire frequency until:
  - `perfect` clearly beats `none` (target: ≥ 40% higher mean score),
  - neither team hits the score floor or ceiling on most seeds,
  - LLM latency (p90) fits comfortably inside a tick.
- Record the chosen defaults in `configs/default.yaml` and note the reasoning in `docs/TUNING.md`.

**Done when:** the target gap holds on a fresh set of 10 seeds. **If the gap can't be reached, stop and redesign the rules before building real teams.**

### M6: Band team (M)
- Register 5 external agents (open question §14.2), config loading.
- `band` transport on `@band-ai/sdk` `GenericAdapter`: team room setup, `send_message`, `create_room`, `add_participant` (§7.3).
- Room cleanup after a match.
- Resolve delivery semantics (§14.1) and document them in the transport.
- Handle reconnects and rate-limit errors, and log them as events.

**Done when:** a `band` vs `none` vs `perfect` match runs end to end with real Band rooms, and message timings are recorded.

### M7: Sub-agent team (M)
- Orchestrated team controller (§7.4): orchestrator loop, `spawn`, sub-agent lifetime, `finish`, auto-report with structured sightings.
- Viewer: hub-and-spoke message lines, spawn/report markers, and an orchestrator panel (its queue and live sub-agents).

**Done when:** a four-team match (`none`, `perfect`, `band`, `subagents`) runs live and replays.

### M8: Metrics and batch (M)
- The metrics in §10 as SQL queries in `recorder`, with tests on hand-made fixture recordings.
- Live counters under each board.
- `firebreak batch --seeds N` (sequential, with a cost estimate and confirmation before it starts).
- `firebreak report` → HTML summary across seeds (means, spread, relative score, per-seed table).

**Done when:** a 20-seed batch produces a report.

### M9: Demo polish (M)
- `firebreak export --html`: a single-file shareable replay (§8.6).
- Presenter layout for a big screen, with a "focus on a team" zoom.
- Pick 2–3 good "showcase" seeds and keep their recordings with the repo (or in releases).

**Done when:** someone with no setup can open an exported HTML file and watch a match at 4×.

---

## v1: Slack and Linear

### M10: Slack team (M)
- Sandbox workspace, 5 bot users, Socket Mode transport, `post` and `reply_in_thread` (§7.5).
- Viewer: broadcast-style message lines.

### M11: Linear team (M)
- Sandbox workspace, webhook receiver (local tunnel), `create_issue`, `comment`, `set_status`, `assign` (§7.6).
- Viewer: issue cards next to the board.

### M12: Full batch
- Six-team batch over 20+ seeds, then a final report.

---

## Cost estimate (per match, default config)

About 5 agents × 4 LLM teams × ~60 decisions ≈ 1,200 calls, plus the orchestrator's. With Haiku 4.5 and ~4–6k input tokens per call, that's roughly **6–8M input tokens per match**. On the `claude-code` backend this counts against the subscription's usage limits rather than being billed. Verify it in M4 and put the real number here. `batch` always shows an estimate and asks before it starts.

## Risks

| Risk | Mitigation |
|---|---|
| The game doesn't reward communication | M5 gate: tune with reference teams before building real teams |
| LLM latency varies between teams | Same model; latency recorded per call; discard outlier matches; many seeds |
| Rate limits (Band, Slack, Linear, Anthropic) distort results | Log every rate-limit event; report them per team; use sandbox workspaces |
| A setup looks rigged | Faithful setups (§7), generous choices where unsure, open-source harness (§14.6) |
| Sub-agents win in easy configurations | Expected; show where the crossover is (score vs. spread rate / team size) |
| Band SDK gaps | Built in-house; raise issues on `band-sdk-typescript` early (M6) |
| Cost | Budget cap per match, cheap default model, confirmation for batches |

## Open decisions to settle before M4

See §14 in SPEC.md, especially Band delivery semantics (§14.1) and how to implement sub-agents (§14.3).
