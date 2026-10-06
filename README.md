# Firebreak

A live, replayable game that compares how well teams of AI agents coordinate when the only difference between them is how they communicate.

Teams of 5 AI firefighters defend identical copies of a town from spreading wildfires, side by side, on the same seed and the same clock. Every match is recorded to one SQLite file and can be replayed at any speed, verified, measured, and exported as a single HTML file.

| Team                        | How it communicates                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `chat-mentions`             | Local shared room; only explicitly mentioned teammates receive each message                        |
| `chat-broadcast`            | Local shared room; every teammate receives every message, while mentions mark the intended readers |
| `none`                      | No communication (lower bound)                                                                     |
| `perfect`                   | Everyone sees every teammate's observations instantly (information ceiling, not a planner)         |
| `band`                      | Optional real Band rooms through `@band-ai/sdk`                                                    |
| `subagents`                 | Orchestrator delegates bounded tasks with explicit completion criteria to isolated workers         |
| `bots-none`, `bots-perfect` | Scripted bots, no LLM (for development and tuning)                                                 |

- [Specification](docs/SPEC.md) · [Implementation plan](docs/PLAN.md) · [Tuning notes](docs/TUNING.md) · [Prompt-v8 benchmark](docs/PROMPT_V8_BENCHMARK.md) · [Changelog](CHANGELOG.md) · [Guide for coding agents](AGENTS.md)

## Recent additions

- **Two local chat experiments:** `chat-mentions` delivers a message only to named agents; `chat-broadcast` delivers every room message to everyone. They use the same agents, model, prompts, world seed, and engine rules.
- **OpenAI support:** `openai` uses the billed Responses API, while `codex` uses the local ChatGPT/Codex subscription through a headless App Server. Claude continues to use the local subscription by default through `claude-code`.
- **Real subscription sessions:** Claude and Codex strip API-key variables. Each logical game agent keeps one isolated model conversation across decisions, so prior turns and provider prompt caches are reused. A spawned sub-agent gets a fresh conversation for that assignment. Codex loads no user configuration and disables its own shell, apps, plugins, web search, and subagents.
- **Comparable worlds:** every communication condition in a match uses the same scenario seed, scheduled events, tile/tick random rolls, and synchronized decision barrier. Only communication differs between teams. Perfect communication is a shared-information ceiling, not centralized planning, so independent agents may still duplicate work or make poor choices.
- **Replay broadcasts:** an omniscient post-match commentator explains the fire, rescue effort, and teamwork in plain language. Commentary is generated after gameplay, saved as a sidecar, and reused on future replay loads.
- **Viewer explanations:** the replay includes a legend, rules reference, event markers, per-team positive/negative outcome counters, an outcome-over-time comparison chart, and a full-screen broadcast transcript reader.

See [CHANGELOG.md](CHANGELOG.md) for the detailed history.

## Setup

```bash
pnpm install
cp .env.example .env                 # API credentials, if using a billed backend
cp band_agents.yaml.example band_agents.yaml   # only needed for the band team
```

Requires Node 22.13+ and pnpm. Subscription backends are the default path: `llm.backend=claude-code` (the overall default) uses the local `claude` login, while `llm.backend=codex` uses the local ChatGPT-authenticated `codex` login. Run `claude` or `codex login` once before using them. These consume plan usage rather than billing API tokens. The explicitly billed alternatives are `llm.backend=api` with `ANTHROPIC_API_KEY` and `llm.backend=openai` with `OPENAI_API_KEY`. The CLI reads credentials from the process environment; it does not load `.env` itself.

## Run a match

```bash
# All four teams, 60 logical ticks × 5 simulated seconds, with the live viewer at http://localhost:5173/?live
pnpm firebreak run --live

# Pick teams, seed, provider and any config value
pnpm firebreak run --teams chat-mentions,chat-broadcast --seed 7 --set ticks=30
pnpm firebreak run --set llm.backend=codex --set llm.model=gpt-5.6-luna

# Sub-agents receive a finite task plus explicit `done_when` criteria and live until they satisfy or are blocked on it; opt into the old hard cutoff if desired
pnpm firebreak run --teams none,perfect,subagents --set subagents.max_lifetime_ticks=8

# Generate an omniscient, human-friendly broadcast after play (one model call per team)
pnpm firebreak run --commentary

# Legacy wall-clock play: the world advances every tick_ms even while models are responding
pnpm firebreak run --realtime

# Scripted bots are instant; --virtual remains a compatibility alias for synchronized mode
pnpm firebreak run --teams bots-none,bots-perfect
```

Synchronized ticks are the default. At each tick, agents observe the current state, all decisions and the message/report cascades they trigger finish, their latest orders are committed, and only then does the engine advance every world once. Ongoing orders then execute for one tick and remain active until completed, blocked, or replaced. Provider speed therefore affects wall-clock run time and recorded latency, but not how many simulated ticks an agent gets to react. `--realtime` selects the old mode where the engine advances every `tick_ms` regardless of unfinished calls; use it only for legacy behavior or an experiment explicitly about real-time latency.

## Working with recordings

Every match is one SQLite file: `runs/` for your own matches (git-ignored), `recordings/` for curated ones committed to the repo ([index](recordings/README.md)). Commands take a path or just the file name; both folders are searched.

```bash
pnpm firebreak list                                     # all recordings, with scores
pnpm firebreak replay 20260927-184427-s13-mmr7.sqlite   # watch it (add ?t=120&speed=4 to the URL)
pnpm firebreak verify 20260927-184427-s13-mmr7.sqlite   # re-run the engine, compare every tick hash
pnpm firebreak metrics 20260927-184427-s13-mmr7.sqlite  # per-team metrics as JSON
pnpm firebreak report recordings/*.sqlite               # HTML summary across several matches
pnpm firebreak export 20260927-184427-s13-mmr7.sqlite   # single offline HTML file to share
pnpm firebreak commentate 20260927-184427-s13-mmr7.sqlite # generate/save broadcast now
pnpm firebreak run --config-from 20260927-184427-s13-mmr7.sqlite --seed 14   # same setup, new seed
```

Viewer keys: space play/pause, ←/→ step a tick, 1–5 speed (0.5×–10×), drag the timeline to seek, click an agent to see what it saw and decided, click a board's header to focus on that team. _board / graph / both_ (or `?view=`) shows each team's communication graph on one scale shared by all teams; hover an edge for counts and click it to filter the feed. _expand feeds_ scrolls through every message and action, while _messages / actions / all_ (or `?feed=`) selects the feed contents. _order targets_ toggles role-coloured dashed lines from each agent to its current target; red means blocked. Score chips, pop-ups, logs, and the labelled outcome chart explain where totals diverged.

Each responsive card also separates the score breakdown, mission outcomes (civilians saved/lost, fires out/active, houses standing/destroyed), and operational diagnostics (cost, calls, messages, stale actions, idle agent-ticks, and uncovered intensity-3 fire-ticks). The event strip uses one labelled row per visible team; shared wind and bridge events span every row. **Outcome over time** plots any outcome by tick and lets you toggle teams independently. The persistent **Panels** dialog independently controls the score breakdown, mission stats, operational stats, feeds, AI commentary, and comparison chart. In board-only mode maps use the available width and the content pane scrolls vertically if necessary. The agent inspector distinguishes in-flight decisions from deliberate idling. Every **AI Broadcast** explains the fire situation, teamwork, and decision quality and identifies its saved commentator backend/model. A persisted Dark/Light toggle applies to the index, replay, dialogs, charts, and rules page.

“Uncovered I3” counts every intensity-3 fire at every tick where fewer than two firefighters have active extinguish orders for that exact target. This measures whether the team has paired the required crew even while they are still travelling; lower is better. The **Sub-agents** button shows the lifecycle recorded for the replay and provides a UI control that generates the exact command for a task-driven or hard-limited next run. Sub-agent reports record assignment age; work lasting at least one quarter of the match (minimum eight ticks) is flagged `LONG-RUNNING` for diagnosis but is never stopped by that flag.

All gameplay agents receive the total match length, current tick, and ticks remaining in every decision. Visible fires include their numeric intensity. The shared rules explain that higher intensity spreads more readily, intensity 3 is the maximum, and a threatening intensity-3 fire requires both firefighters on the same coordinates in the same tick.

The default civilian survival window is 17 ticks and is configurable, for example with `--set rules.civilian_deadline=20`.

Perfect communication and room broadcast are intentionally different. `perfect` is an oracle upper bound: each agent automatically sees the union of every teammate's raw observations, current orders, and forecast on every decision. `chat-broadcast` requires an agent to choose and write a message; every teammate receives only that text, so information may be omitted, late, or noisy. The real `band` transport is mention-delivered rather than an automatic broadcast: only named members receive a room message, while mentioning `all` deliberately reaches the whole team.

The commentator is an omniscient observer, not a sixth player. It sees the full current map and every message the team sent, even when that team's transport did not deliver the message. To protect experimental fairness, it runs only after the outcome is fixed and its tokens/cost never enter team metrics. `--commentary` generates it eagerly; opening or exporting any historical replay without commentary generates it automatically. By default the commentator uses the local Claude subscription with Haiku, independently of the gameplay provider/model, so OpenAI recordings do not require an OpenAI key merely to narrate them. Override `commentator.backend` and `commentator.model` when desired; set both to `same` to reuse the gameplay model.

Commentary is saved under `runs/commentary/` as a versioned sidecar and merged into replay data. The SQLite match is never edited, so its hashes and verification remain authoritative. If provider credentials are unavailable, the match still replays and the broadcast panel shows the generation error.

A recording holds everything needed to replay and analyse gameplay without calling a model. Human-facing commentary is a derived, cached sidecar and may require one model call per team the first time an older match is opened:

| Table                  | Contents                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `match`                | id, seed, status (`completed` / `aborted`), abort reason, header (incl. the scenario)                                            |
| `match_config`         | one row per section: `resolved` config, `llm`, `prompts`, `tools`, `code` (git commit), `environment`, `source_text`, `cli_args` |
| `world`                | one row per team: final score, cost                                                                                              |
| `tick_state`           | full world state (JSON) and hash for every tick                                                                                  |
| `event`                | orders issued/rejected/blocked/done, fires, civilians, spawns, reports, rooms…                                                   |
| `message` / `delivery` | every message, and when each recipient received (`delivered`) and read (`consumed`) it                                           |
| `llm_call`             | every decision: prompt, response, tool calls, tokens, latency, cost                                                              |

Query it directly with the `sqlite3` CLI:

```bash
R=recordings/20260927-184427-s13-mmr7.sqlite
sqlite3 -header -column $R "SELECT team, final_score, round(cost_usd, 2) AS usd FROM world"
sqlite3 $R "SELECT t_ms/5000 AS tick, sender, channel, text FROM message WHERE world_id = 'w3-band' ORDER BY t_ms"
sqlite3 $R "SELECT agent_id, response, tool_calls_json FROM llm_call WHERE world_id = 'w4-subagents' AND agent_id = 'orchestrator'"
sqlite3 $R "SELECT m.world_id, round(avg(d.t_ms - m.t_ms)) AS ms FROM delivery d JOIN message m ON m.id = d.message_id WHERE d.stage = 'delivered' GROUP BY 1"
sqlite3 $R "SELECT json_extract(value_json, '$.model') FROM match_config WHERE section = 'llm'"
```

World ids are `w<N>-<team>` (e.g. `w3-band`); agent ids are `scout`, `ff1`, `ff2`, `engineer`, `rescuer` (plus `orchestrator` on the sub-agent team). The full schema is in `packages/recorder/src/schema.ts`.

### Scoring and comparing runs

Every LLM agent—including the sub-agent orchestrator and each spawned worker—receives the exact team scoring weights in its system prompt:

| Outcome                         | Score |
| ------------------------------- | ----: |
| Civilian evacuated              |   +10 |
| Civilian lost                   |   −20 |
| House still standing at the end |    +5 |
| Fire tile extinguished          |    +1 |

Agents can therefore prioritize actions to maximize the team score. They do **not** receive an omniscient live score or hidden world state: ordinary agents see only their local observations and delivered messages, the perfect-information condition sees the team's combined observations, and the sub-agent orchestrator sees worker reports.

The house term gives each world a positive starting score. For example, seed 42 has 11 houses, so a one-tick smoke test normally finishes at `11 × 5 = 55` before civilians can expire or houses can burn down. An aborted match may also show this initial snapshot. That does not make it comparable to a complete 60-tick match, where civilian losses can quickly make the total negative.

Only compare recordings with the same seed, tick count and duration, clock mode, engine version, prompt version, backend/model, and status. In particular, exclude aborted runs, do not mix legacy real-time recordings with synchronized ones, and do not compare one-tick backend smoke tests with full matches. Use `firebreak metrics` and the recorded `match_config` when in doubt.

## Many seeds

```bash
pnpm firebreak batch --seeds 20           # asks before spending; --yes to skip
pnpm firebreak report                     # HTML summary of the latest batch
```

## Development

```bash
pnpm test        # engine rules, determinism, recording, replay, teams with a fake model
pnpm typecheck
pnpm lint
```
