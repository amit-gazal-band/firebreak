# Firebreak — Implementation Plan

Companion to [SPEC.md](SPEC.md). Section references (§) point there.

Build order: **engine → recording/replay → viewer → LLM agents → real teams → metrics**. The viewer and replay are built and tested with scripted (non-LLM) bots before any tokens are spent. The game is tuned with the reference teams before any real communication method is compared.

Sizes: **S** ≈ 1 day, **M** ≈ 2–3 days, **L** ≈ 1 week.

## Status (2026-09-29)

| Milestone | Status | Notes |
|---|---|---|
| M0 Scaffold | done | pnpm workspace, strict TS, Vitest, ESLint, Prettier, CI |
| M1 Engine | done | deterministic, shared per-tile randomness, scripted bots |
| M2 Recorder and replay core | done | one SQLite file per match (`node:sqlite`), config stored with it, `verify` |
| M3 Viewer | done | Canvas 2D instead of PixiJS; single-file build |
| M4 LLM runtime and reference teams | done | Claude/OpenAI API plus subscription backends; `claude-code` tuned to ~4 s/decision |
| M5 Tune the game | first pass, needs more seeds | batch 1: perfect beat none 3/3; batch 2 (prompt v3): band best (+26 mean) but perfect ≈ none. Needs 10–20 seeds (docs/TUNING.md §6) |
| M6 Band team | done | real Band rooms; delivery semantics measured |
| M7 Sub-agent team | done | orchestrator + spawn/report, hub-and-spoke in the viewer |
| M8 Metrics and batch | done | metrics as SQL over recordings; `batch`, `report` |
| M9 Demo polish | done | `export`, focus-on-one-team mode, 2×2 layout; showcase: `showcase/seed-11-four-teams.html` |
| M9a Expandable message feed | done | `feed.ts`: 3 lines collapsed, 10 expanded; incremental, follow-newest, click to seek |
| M9b Communication graph | done | `graph.ts`, `?view=board\|graph\|both`; `communicationMatrix` in `recorder`, matrix and concentration in `report`; showcases regenerated |
| M9c Role icons | done | `icons.ts`: SVG paths as `Path2D`, cached bitmaps; board, graph, feed, inspector, global legend; same render in Chromium, Firefox, WebKit; no 10× frame-time change |
| M9d Agent actions feed | done | `?feed=messages\|actions\|all`; actions from `llm` tool calls + `order_done`/`order_blocked` (bots: `order_issued`); agent filter; inspector pins a decision, ◀ / ▶; order lines + hover label |
| M9e Score explanation | done | score log in `timeline` (test: matches `tick_state` on every tick of every committed recording), chips, pop-ups, log, one labelled outcome chart, per-agent points |
| M9f Viewer fixes | done | one expand state for every feed; pop-ups name the event (`SCORE_LABEL`, shared with the score log) and stack (`stackLabels`); layout fits the expanded feeds, then drops feed lines, then scrolls the boards area in the grid that hides the least |
| M9g Replay commentator | done | omniscient post-match broadcast, persisted sidecars, automatic historical generation |
| M9h Replay comparison | done | responsive score/mission/operational stats, per-team timeline lanes, multi-metric outcome chart, persistent panel and Dark/Light preferences, adaptive map/graph surface layout |

---

## v0: Band vs sub-agents, plus reference teams

### M0: Scaffold (S)
- pnpm workspace with the `packages/*` from §12, TypeScript strict, Vitest, ESLint/Prettier.
- `cli` package with an empty `firebreak` command.
- GitHub Actions: lint, typecheck, test.
- `.env.example` (optional billed API keys, BAND_* per agent), `runs/` git-ignored.

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
- `LlmClient` interface with API and subscription backends for Anthropic and OpenAI. Token/cost/latency accounting, per-match budget cap, usage-limit abort (§6.3).
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
  - synchronized decisions finish reliably; provider latency is recorded separately and wall time remains practical.
- Record the chosen defaults in `configs/default.yaml` and note the reasoning in `docs/TUNING.md`.

**Done when:** the target gap holds on a fresh set of 10 seeds. **If the gap can't be reached, stop and redesign the rules before building real teams.**

### M6: Band team (M)
- Register 5 external agents (open question §14.2), config loading.
- `band` transport on `@band-ai/sdk` `GenericAdapter`: team room setup, `send_message`, `create_room`, `add_participant` (§7.4).
- Room cleanup after a match.
- Resolve delivery semantics (§14.1) and document them in the transport.
- Handle reconnects and rate-limit errors, and log them as events.

**Done when:** a `band` vs `none` vs `perfect` match runs end to end with real Band rooms, and message timings are recorded.

### M7: Sub-agent team (M)
- Orchestrated team controller (§7.5): orchestrator loop, `spawn`, sub-agent lifetime, `finish`, auto-report with structured sightings.
- Viewer: hub-and-spoke message lines, spawn/report markers, and an orchestrator panel (its queue and live sub-agents).

**Done when:** a four-team match (`none`, `perfect`, `band`, `subagents`) runs live and replays.

### M8: Metrics and batch (M)
- The metrics in §10 as SQL queries in `recorder`, with tests on hand-made fixture recordings.
- Live counters under each board.
- `firebreak batch --seeds N` (sequential, with a cost estimate and confirmation before it starts).
- `firebreak report` → HTML summary across seeds (means, spread, per-seed table).

**Done when:** a 20-seed batch produces a report.

### M9: Demo polish (M)
- `firebreak export --html`: a single-file shareable replay (§8.6).
- Presenter layout for a big screen, with a "focus on a team" zoom.
- Pick 2–3 good "showcase" seeds and keep their recordings with the repo (or in releases).

**Done when:** someone with no setup can open an exported HTML file and watch a match at 4×.

---

## Before v1: communication views

Both are viewer-only. They read the existing `message` table and event stream, so the recording format doesn't change and every committed recording and showcase gets them.

### M9a: Expandable message feed (S)
- Replace the 3-line ticker (`packages/viewer/src/player.ts`, `.ticker` in `style.css`) with a feed component: collapsed shows 3 lines, expanded shows 10 and scrolls through every message up to `t` (§9.2).
- Per-card expand toggle plus an "expand all" control; long messages wrap when expanded.
- Follow-newest while at the bottom; "↓ new messages" button once scrolled up.
- Render incrementally (append new messages, rebuild only on seek) instead of rewriting `innerHTML` every frame, so scrolling isn't reset.
- Click a line to seek to its `sent_at`.
- Board sizing (the `chrome` height in `player.ts`) accounts for the expanded feed, so the board doesn't shrink or jump.

**Done when:** on the seed-11 showcase at 4×, expanding a feed shows 10 lines, scrolling back through earlier messages works while playback continues, and the board stays the same size.

### M9b: Communication graph (M)
- `timeline`: a per-world edge count `(from, to) → count` up to `t`, built incrementally and rebuilt on seek, with a *recent* variant (last 10 ticks). Expand multi-recipient and channel messages per recipient (§9.1).
- Graph renderer (Canvas 2D): fixed pentagon layout with HQ in the centre, directed curved edges with arrowheads, width `sqrt(count)`, grey → red colour, node size by total traffic, flash on send.
- A weight scale shared across all visible teams, with a legend.
- Card view switch *board / graph / both*, global, persisted in `?view=`; *both* by default in focus mode.
- Edge hover tooltip; click an edge to filter the M9a feed to that pair; click a node to open the inspector.
- Same data as a SQL query in `recorder` (communication matrix and concentration, §10), with a fixture test, and a matrix per team in `firebreak report`.
- Works in `export --html`; regenerate the showcase files.

**Done when:** on the seed-11 showcase, the subagents graph is visibly a star around HQ, the band graph shows its real pairwise pattern, the graph matches the matrix from the SQL query, and scrubbing backwards shrinks the edges.

## Before v1: readability

Also viewer-only. Everything needed is already in the recording: tool calls in `llm_call.tool_calls_json`, order outcomes and scoring events in `event`, and the score in every `tick_state`. Committed recordings and showcases get all three after a rebuild.

### M9c: Role icons (S)
- `packages/viewer/src/icons.ts`: one SVG path per role, HQ and civilian (§9.3), as `Path2D`, with a per-size offscreen-canvas cache.
- `drawAgent` in `render.ts`: role-colour disc + icon in place of the letter; keep the selected / blocked rings and water pips; FF1/FF2 number badge.
- Use the same icons for graph nodes (`graph.ts`), the inspector header, feed lines, and the global role legend. Label the bodyless orchestrator `HQ`.
- Civilian person icon in place of the dot, keeping the countdown ring.

**Done when:** on the seed-11 showcase in the 3×2 layout, every role is recognisable without the legend at the smallest board size, the exported HTML looks the same in Chrome, Safari and Firefox, and 10× playback frame time doesn't regress.

### M9d: Agent actions feed (M)
- `timeline`: an action list per world built from `llm` frames (one entry per tool call, at `ended_ms`) plus `order_done` / `order_blocked` events, incremental and rebuilt on seek, like messages.
- `feed.ts`: *Messages / Actions / All* tabs, global and in `?feed=`; action line formatting (✓ / ✗ / ⛔, dimmed `wait` and completions); hide-completions checkbox; communication tools shown once, as messages, in *All* (§9.4).
- Agent filter chip, alongside the pair filter from M9b.
- Inspector: open on a specific decision (from a clicked line), with ◀ / ▶ through the agent's decisions (`lastLlmCall` becomes an index lookup).
- Board: dashed order lines from each agent to its target (red when blocked), hover label with the current order, toggle to hide.
- Card sizing: the tabs don't change the feed height budget from M9a.

**Done when:** on the seed-11 showcase, every order an agent issues and every validation error appears in *Actions* at the right time, *All* has no duplicate lines for messages, clicking an action opens that exact decision in the inspector, and the order lines match the orders shown in the inspector.

### M9e: Score explanation (M)
- `timeline`: a per-world score log from the scoring events (§4.6 table), with delta, credited agent and running total; a test that the running total equals `tick_state.score.total` on every tick of the committed recordings.
- Card: aligned breakdown components under the score and score flash; click the score to open the log (click a line to seek). Do not repeat the initial score on a dedicated row because the house component already shows it.
- Board: floating score pop-ups at the event's tile.
- Outcome chart: one labelled, collapsible all-teams chart below the cards. Do not repeat unexplained sparklines or a second miniature chart.
- Inspector: per-agent points and the team's losses.

**Done when:** on the seed-11 showcase, the breakdown always adds up to the shown score, every score change has a pop-up and a log line explaining it, the chart shows where the teams diverged, and someone who hasn't seen the rules can explain a final score from the card alone.

### M9f: Viewer fixes (S)
Viewer-only; showcases get them after a rebuild.

- **Linked expand/collapse** (§9.2): one global expanded state in `player.ts`. A card's feed toggle (`onToggle` in `feed.ts`) sets it for every feed, like the "expand feeds" button already does, and every toggle label follows it.
- **Event pop-ups** (§9.5): the board pop-ups in `render.ts` draw the event's name (`Civilian evacuated`, `Civilian lost`, `Fire put out`, `House destroyed`) instead of the delta, keeping the green / red colour and the rise-and-fade. One label map shared with the score log so the wording matches. Pop-ups on the same tile and tick stack instead of overlapping.
- **No page scroll** (§9.2): `layout()` in `player.ts` uses the expanded feed height in `chromeHeight()` when the feeds are expanded, so the boards shrink to fit and the page never scrolls; re-run layout on every expand/collapse. Check the `Math.max(220, …)` floor doesn't force a scrollbar at common window sizes; if it would, cap the expanded feed's line count instead.

**Done when:** on the seed-11 showcase in the 2×2 and 3×2 layouts at a 1440×900 window, clicking any one card's expand toggle expands every feed and flips every label, the page has no vertical scrollbar collapsed or expanded (boards shrink when expanded and grow back when collapsed), and every scoring event shows its event name on the board instead of points.

---

## v1: Slack and Linear

### M10: Slack team (M)
- Sandbox workspace, 5 bot users, Socket Mode transport, `post` and `reply_in_thread` (§7.6).
- Viewer: broadcast-style message lines.

### M11: Linear team (M)
- Sandbox workspace, webhook receiver (local tunnel), `create_issue`, `comment`, `set_status`, `assign` (§7.7).
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
| LLM latency varies between teams | Synchronized mode removes it from simulated reaction time; record it for wall-time diagnosis. Keep `--realtime` results separate |
| Rate limits (Band, Slack, Linear, Anthropic) distort results | Log every rate-limit event; report them per team; use sandbox workspaces |
| A setup looks rigged | Faithful setups (§7), generous choices where unsure, open-source harness (§14.6) |
| Sub-agents win in easy configurations | Expected; show where the crossover is (score vs. spread rate / team size) |
| Band SDK gaps | Built in-house; raise issues on `band-sdk-typescript` early (M6) |
| Cost | Budget cap per match, cheap default model, confirmation for batches |

## Open decisions to settle before M4

See §14 in SPEC.md, especially Band delivery semantics (§14.1) and how to implement sub-agents (§14.3).
