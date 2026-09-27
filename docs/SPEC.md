# Firebreak — Specification

> A live, replayable game that compares how well teams of AI agents coordinate when the **only** difference between them is how they communicate.

Status: draft v0.1 · Owner: Amit Gazal

---

## 1. Purpose

Show the difference between multi-agent communication methods (Band, sub-agents, Slack, Linear) in a way people can **watch**, and back it with numbers people can **check**.

Several teams play the same game on identical copies of the same world, at the same time, side by side on one screen. After a fixed time the scores are compared. Every match is recorded and can be replayed later at any speed.

## 2. Principles

1. **One variable.** All teams use the same model, prompts, game seed, clock, and agent loop. Only the communication layer differs.
2. **Faithful setups.** Each communication method is used the way people actually use it, in its best reasonable configuration. If a setup looks rigged, the demo fails.
3. **Reference teams.** A *no-communication* team (lower bound) and a *perfect-communication* team (upper bound) run next to the real teams. Results are shown relative to them.
4. **Stats, not anecdotes.** Any claim is backed by many seeds. A single live match is for show only.
5. **Everything is recorded.** Every match can be replayed, inspected, and re-analysed without calling any LLM or external service.

## 3. Glossary

| Term | Meaning |
|---|---|
| **Match** | One run of the game: N worlds, one per team, on the same seed and clock |
| **World** | One team's copy of the game map and state |
| **Team** | 5 agents that share one communication method |
| **Agent** | An LLM-driven player with one role and one body in the world |
| **Tick** | One step of the world clock (default 5 s). The world advances every tick whether agents acted or not |
| **Seed** | Determines the map, every scheduled event, and every random roll |
| **Order** | An agent's current standing action (e.g. "move to (4,7)"), executed by the engine tick after tick until it completes or is blocked |
| **Recording** | The stored log of a match, which is enough to replay it fully |

## 4. The game: Wildfire

A team of 5 AI firefighters defends a town from spreading wildfires for 60 ticks (5 minutes at default settings).

### 4.1 Map

- 20×20 grid, generated from the seed.
- Tile types: `grass`, `forest`, `house`, `road`, `water`, `bridge`, `debris`, `firebreak`, `ash`.
- One lake (the water source), one river with one bridge, 8–12 houses, a road network.
- `debris` sits on road tiles and blocks movement until an engineer clears it.

### 4.2 Roles

| Role | Count | Move / tick | Vision radius | Abilities | Limits |
|---|---|---|---|---|---|
| Scout | 1 | 2 | 5 | **The only role that receives the wind forecast** | Can't fight fires, clear debris, or rescue |
| Firefighter | 2 | 1 | 2 | Extinguish an adjacent fire (uses 1 water), refill next to the lake | Carries 3 water |
| Engineer | 1 | 1 | 2 | Clear debris (2 ticks), build a firebreak on grass/forest (1 tick) | Can't fight fires |
| Rescuer | 1 | 1 | 2 | Evacuate an adjacent civilian (1 tick) | Can't pass debris |

Every role is missing something another role has, so the team has to share information to do well.

### 4.3 Actions

Agents issue **orders**, not single steps. The engine carries out the order each tick until it completes or is blocked. This keeps LLM calls to decisions rather than footsteps.

| Order | Roles | Completes when |
|---|---|---|
| `move_to(x, y)` | all | arrived (engine pathfinding over passable tiles) |
| `extinguish(x, y)` | firefighter | fire out, out of water, or target not adjacent |
| `refill()` | firefighter | full (needs to be next to water) |
| `clear_debris(x, y)` | engineer | cleared |
| `build_firebreak(x, y)` | engineer | built |
| `rescue(civilian_id)` | rescuer | evacuated |
| `wait()` | all | the next order arrives |

An order that arrives before a tick boundary takes effect on that tick. A new order replaces the current one.

### 4.4 World dynamics (applied each tick, in this order)

1. **Orders** are applied (movement, then abilities).
2. **Joint check.** An intensity-3 fire can only be reduced if **two firefighters extinguish it in the same tick** (it then drops by 2). One firefighter alone has no effect on it.
3. **Fire growth.** A burning tile gains +1 intensity (max 3) every 4 ticks unless it was fought during that time.
4. **Fire spread.** Each burning tile may ignite its 4 neighbours. Probability = `base × fuel(tile) × wind(direction)`. Downwind ×3, upwind ×0.3. `forest` fuel > `grass` > `house`. `firebreak`, `road`, `water`, `ash` don't burn.
5. **Burn-out.** A tile that has been burning for 10 ticks becomes `ash`. A house that stays at intensity 3 for 3 ticks is destroyed.
6. **Civilians.** A civilian dies if fire reaches its tile or its deadline passes (12 ticks after it appears).
7. **Scheduled events** fire (see 4.5).
8. **Observations** are computed and delivered.

### 4.5 Scheduled events (all fixed by the seed)

- **Initial fires:** 2–3 fires start at tick 0.
- **New fires:** 2–4 more start at random ticks, at least one on the far side of the map.
- **Wind shifts:** 2–3 per match. The scout gets each one **6 ticks in advance**. Everyone else notices the new wind only once it has changed.
- **Civilians:** 4–6 appear at random ticks and places. Each is visible only to agents that can see its tile.
- **Bridge collapse:** at a random tick in the second half, the bridge becomes impassable.

### 4.6 Scoring

| Event | Points |
|---|---|
| Civilian evacuated | +10 |
| Civilian lost | −20 |
| House still standing at the end | +5 |
| Fire tile extinguished | +1 |

A match ends after `ticks` (default 60), or earlier if no fire is left and no civilian is waiting.

### 4.7 Observations

Every agent gets a compact JSON observation whenever it is woken (see 6.2):

```jsonc
{
  "tick": 23, "ticks_left": 37,
  "self": { "id": "ff1", "role": "firefighter", "pos": [4, 7], "water": 2, "order": "extinguish(5,7)", "order_status": "active" },
  "wind": "E",                                  // current wind, everyone can feel it
  "forecast": [{ "tick": 29, "wind": "S" }],   // scout only
  "visible": {
    "fires":     [{ "pos": [5, 7], "intensity": 3 }],
    "civilians": [{ "id": "c2", "pos": [6, 9], "deadline_tick": 30 }],
    "debris":    [[3, 9]],
    "houses":    [{ "pos": [6, 6], "state": "ok" }],
    "teammates": [{ "id": "ff2", "pos": [5, 8] }]
  },
  "events": ["order_completed", "new_fire_seen"]
}
```

## 5. Fairness mechanics

- **Shared randomness.** Every random roll comes from `hash(seed, tick, x, y, purpose)`, not from a stream. So the same tile gets the same roll in every world on the same tick, even though the worlds have drifted apart. Luck is identical across teams.
- **Scheduled events** are generated from the seed before the match and are identical in every world.
- **Same model, same settings** (model id, temperature, max tokens) for every LLM call in the match, orchestrator included.
- **Same base prompt** for every agent. Only a short section describing the communication tools differs between teams (section 7).
- **Same context budget.** Each agent's prompt holds its role, its latest observation, its last 30 messages, and a short log of its own recent orders. Every team gets the same limits.
- **Recorded model latency.** Every LLM call's latency is recorded, so a slow-API streak can be spotted and a match discarded.

## 6. Agent runtime

### 6.1 Agent loop (identical for every team)

```
loop until match ends:
  wait for a wake trigger
  build prompt(role, latest observation, recent messages, own order log)
  LLM → tool calls: at most one order tool, plus any of the team's communication tools (§6.4)
  submit order to the engine; send messages through the team's transport
```

At most one LLM call per agent is in flight. Triggers that arrive during a call are merged and handled by the next call.

### 6.2 Wake triggers

- A message was delivered to this agent.
- Its order completed or was blocked.
- It saw something notable for the first time (new fire, civilian, debris, destroyed house).
- The wind changed (or, for the scout, a new forecast arrived).
- Heartbeat: 3 ticks passed with no other trigger.

### 6.3 LLM backends

The runtime calls models through one interface, `LlmClient.decide(prompt, tools) → { toolCalls, usage, latency }`. It has two backends:

| Backend | Auth | Implementation | Notes |
|---|---|---|---|
| `api` | `ANTHROPIC_API_KEY` | `@anthropic-ai/sdk` Messages API with tool use | Lowest latency, billed per token |
| `claude-code` | Claude subscription: the local `claude` login, or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | `@anthropic-ai/claude-agent-sdk` `query()`, with a custom `systemPrompt`, built-in tools disabled, and game tools served through `createSdkMcpServer` | Not billed per token. Subject to the subscription's usage limits. Higher per-call overhead |

- **One backend per match.** All teams in a match use the same backend, so the comparison stays fair. The backend is recorded with the match (§8.2).
- **Compare within a backend.** Latency differs between backends, so reports compare matches from the same backend only (and the same `tick_ms`).
- **Stateless calls in both backends.** Every decision is a fresh call with a freshly built prompt (§6.1). No backend-side session memory, so both backends see exactly the same input.
- **Cost:** `api` records real cost from token usage. `claude-code` records tokens plus the SDK's `total_cost_usd` as an *estimated* cost.
- **Usage limits:** a match is about 1,200 model calls. Before a `claude-code` match or batch starts, the runner warns that it may hit the subscription's usage limits. If a limit is hit, the match is aborted and marked `aborted: usage_limit`, not scored.
- Default model: `claude-haiku-4-5-20251001` (fast and cheap, which keeps ticks short). Configurable per match.
- **Per-match budget cap** (tokens, and $ for `api`). The match aborts cleanly if it's exceeded.

### 6.4 Tools

Everything an agent does goes through tool calls. There is no free-text parsing.

- **Orders are tools**, one per order type, with a JSON schema for the arguments: `move_to(x, y)`, `extinguish(x, y)`, `refill()`, `clear_debris(x, y)`, `build_firebreak(x, y)`, `rescue(civilian_id)`, `wait()`.
- **Only the role's own orders are exposed.** A scout gets `move_to` and `wait`. A firefighter adds `extinguish` and `refill`. An engineer adds `clear_debris` and `build_firebreak`. A rescuer adds `rescue`. This is identical across teams.
- **An order tool returns right away**, without waiting for the order to finish. It returns either `accepted, takes effect on tick N`, or a validation error (e.g. "not adjacent", "no water", "unknown civilian"). Completion and blocking arrive later as wake triggers (§6.2).
- **At most one order per decision.** The last valid one wins.
- **Communication tools** come from the team's transport (§7). The reference teams have none.
- **Sub-agent team:** sub-agents get their role's order tools plus `finish(report)`. The orchestrator gets only `spawn(body, brief)` and `wait()`.
- **Turn limit:** one decision allows up to 3 model turns, so the model can correct itself after a validation error. After that the decision ends.
- Tool definitions are versioned and recorded with each match (§8.2).

## 7. Teams

Two kinds of team controller:

- **Peer teams** (none, perfect, band, slack, linear): 5 agents, each running the loop in 6.1, talking through a `Transport`.
- **Orchestrated team** (subagents): an orchestrator plus spawned sub-agents (7.4).

```ts
interface Transport {
  setup(team: TeamInfo): Promise<void>;
  tools(agent: AgentId): ToolDef[];                     // native affordances exposed to the LLM
  call(agent: AgentId, tool: string, args: unknown): Promise<ToolResult>;
  onDeliver(agent: AgentId, cb: (m: DeliveredMessage) => void): void;
  teardown(): Promise<void>;
}
```

The runtime wraps every transport so it logs `sent_at` (tool call made), `delivered_at` (recipient's transport got it), and `consumed_at` (the message appeared in the recipient's LLM prompt).

### 7.1 `none` (lower bound)
No communication tools. Each agent knows only its own observation.

### 7.2 `perfect` (upper bound)
No communication tools. Each agent's observation is the **union** of all teammates' observations, plus every teammate's current order and the scout's forecast, delivered instantly. Wake triggers are computed on that union.

### 7.3 `band`
- 5 Band agents (external agents on the platform), connected with `@band-ai/sdk` using `GenericAdapter` as the transport only. The LLM loop stays ours, identical to the other teams.
- A team room containing all 5 agents is created at setup.
- Tools exposed: `send_message(room, text, mentions[])`, `create_room(topic, participants[])`, `add_participant(room, agent)`. They map to `band_send_message`, `band_create_chatroom`, and `band_add_participant`.
- Delivery follows Band's own semantics (room membership plus @mentions).

### 7.4 `subagents`
Follows the real sub-agent pattern (Claude Agent SDK / Task tool, LangGraph supervisor, agents-as-tools).

- **Orchestrator:** a 6th LLM with no body. It sees only what sub-agents report. Its tokens are included in the team's cost.
- **Tools:** `spawn(body, brief)` starts a sub-agent that controls one body (at most one live sub-agent per body). The orchestrator is woken whenever a report arrives and handles reports one at a time as they come in. It never waits for all of them.
- **Sub-agent:** runs the same agent loop and gets **only its brief** (no memory of earlier spawns) plus its own observations. Tools: its role's order tools and `finish(report)` (§6.4).
- **Lifetime:** a sub-agent ends when it calls `finish`, when its order is blocked and it can't recover, or after 8 ticks (then an automatic report is produced).
- **Report:** the sub-agent's text **plus an automatic structured list of everything it saw** (generous on purpose).
- **Faithful limits:** no incoming channel while running, no talking between peers, no interrupting.
- Bodies with no live sub-agent keep their last order, then wait.

### 7.5 `slack` (v1)
- 5 Slack bot users in one workspace, one `#team-<match>` channel, Socket Mode (real-time push).
- Tools: `post(text)`, `reply_in_thread(thread_ts, text)`.
- Every channel message is delivered to every agent (that's how channels work). Real Slack rate limits apply.

### 7.6 `linear` (v1)
- 5 Linear agents/users, one team and project per match, webhooks (not polling).
- Tools: `create_issue(title, description, assignee?)`, `comment(issue, text)`, `set_status(issue, status)`, `assign(issue, agent)`.
- An agent is sent events for issues assigned to it, issues it's subscribed to, and comments that mention it.

## 8. Recording and replay

### 8.1 Goals
- Replay any past match at 0.5×, 1×, 2×, 4× or 10× speed, with pause, seek, and stepping one tick at a time.
- Replay needs **no** LLM calls, API keys, or network.
- A recording is **one file** that can be copied and shared.
- Clicking an agent at any moment shows what it saw, read, and decided (its prompt and response).

### 8.2 What is recorded
Each match is stored in one SQLite file: `runs/<match-id>.sqlite`.

| Table | Contents |
|---|---|
| `match` | id, created_at, seed, final status, abort reason (if any) |
| `match_config` | the full run configuration (see below) |
| `world` | world_id, team type, final score, cost |
| `tick_state` | world_id, tick, **full world state** (JSON), state hash |
| `event` | id, world_id, t_ms (since match start), tick, type, agent_id, payload (JSON) |
| `message` | id, world_id, from, to[] (or channel/room), text, sent_at, delivered_at per recipient, consumed_at per recipient |
| `llm_call` | id, world_id, agent_id, started_at, ended_at, input/output tokens, cost, prompt, response, tool calls |

**The configuration is always stored with the recording**, so every match documents exactly how it was produced:

- **Resolved config:** the final values after defaults, the config file, and CLI overrides were merged, plus the original config file text and the CLI arguments.
- **LLM:** backend (`api` / `claude-code`), model id, temperature, max tokens, turn limit.
- **Prompts and tools:** the full text of every role prompt and transport tools section, and every tool definition, each with a content hash.
- **Code:** engine version, git commit, a dirty-tree flag, and package versions (e.g. `@band-ai/sdk`, the Agent SDK).
- **Environment:** OS, Node version, and the Band / Slack / Linear environment URLs.
- **Never stored:** API keys, OAuth tokens, or other secrets. Config values that look like secrets are redacted before writing.

`firebreak run --config-from <match>` starts a new match with the exact configuration of an old one (a new seed can be passed).

Event types: `order_issued`, `order_completed`, `order_blocked`, `wake`, `spawn`, `report`, `room_created`, `score`, `civilian_spawned`, `civilian_lost`, `house_destroyed`, `wind_changed`, `bridge_collapsed`, `match_aborted`.

Why store the **full state every tick**: at 20×20 × 60 ticks × 6 worlds it takes a few MB at most. Seeking is then instant (load one snapshot), and old recordings keep working after engine rules change.

### 8.3 Timeline
- Time in a recording is **continuous milliseconds** since the match started, not just ticks. Messages and LLM calls sit at their real timestamps between ticks.
- The player keeps a virtual clock `t = t0 + speed × real_elapsed`. At each frame it:
  - draws world state at `floor(t / tick_ms)`, with agent positions interpolated toward the next tick,
  - shows every message and event with `t_ms ≤ t` (message lines animate at their `sent_at`/`delivered_at`).
- Seek = pick a tick, load its snapshot, and replay events from that point.

### 8.4 Live and replay use the same code
The viewer only ever consumes an **event stream**. Live mode is a websocket that tails the match as it's written. Replay mode reads the recording and releases events on the virtual clock. Same renderer, same panels.

### 8.5 Verification
`firebreak verify <match>` re-runs the engine from the seed and the recorded orders (their arrival ticks) and compares the state hash on every tick. This catches engine non-determinism and proves the recording is complete. LLMs are never re-run.

### 8.6 Sharing
`firebreak export <match> --html` writes a single self-contained HTML file with the viewer and the recording embedded. Anyone can open it offline.

## 9. Viewer

- **Layout:** a grid of boards, one per team (2×2 for four teams, 3×2 with the reference teams), each labelled with team name and live score.
- **Board:** the tile map, fire intensity, agents as role icons, civilians with countdown rings, and fog of war shaded by the team's combined vision.
- **Message traffic:** messages drawn as lines between agents while in flight (hub-and-spoke for sub-agents, broadcast for a Slack channel, targeted for Band rooms).
- **Counters** under each board: score, $ spent, messages, stale actions, idle ticks, missed joint tasks.
- **Inspector:** click an agent to see its latest observation, its prompt's message window, and its last LLM response.
- **Controls:** play/pause, speed (0.5–10×), timeline scrubber with event markers, step ±1 tick, choose which teams are shown.
- Stack: Vite + TypeScript + PixiJS.

## 10. Metrics

Every metric is a SQL query over the recording.

**Headline**
- **Score:** final score per team.
- **Relative score:** `(team − none) / (perfect − none)`, meaning how much of the possible coordination gain the team captured.
- **Cost:** total tokens and $ (orchestrator included).
- **Time to clear:** tick when the map was cleared, if it was.

**Diagnostic**
- **Message latency:** `consumed_at − sent_at`, median and p90.
- **Idle ticks:** ticks where an agent had no active order.
- **Stale actions:** orders that targeted something already changed when issued (e.g. a fire already out, a civilian already evacuated or lost, a path through the collapsed bridge).
- **Missed joint tasks:** ticks where an intensity-3 fire had exactly one firefighter extinguishing it.
- **Duplicate work:** two agents with orders on the same target at the same time.
- **Noise ratio:** share of the messages in an agent's prompt that weren't addressed to it and didn't affect its next order (a heuristic: not mentioned and no referenced entity in its vision).
- **Context size:** prompt tokens per agent over time.
- **Orchestrator queue time** (subagents only): report arrival → orchestrator handles it.
- **Forecast lead used:** ticks between the scout learning of a wind shift and the first order by another agent that acts on it.

**Across seeds**
- `firebreak batch --seeds 20` runs matches, and `firebreak report` writes an HTML summary with the mean, spread, and per-seed table for each metric.

## 11. Configuration

```yaml
# configs/default.yaml
seed: 42
ticks: 60
tick_ms: 5000
teams: [none, perfect, band, subagents]
llm:
  backend: api                  # api | claude-code
  model: claude-haiku-4-5-20251001
  temperature: 0.2
  max_turns_per_decision: 3
budget: { usd: 5.00, tokens: 10000000 }
map: { size: 20, houses: [8, 12], civilians: [4, 6], wind_shifts: [2, 3] }
fire: { base_spread: 0.08, growth_every: 4, burnout_ticks: 10 }
agent: { message_window: 30, heartbeat_ticks: 3 }
subagents: { max_lifetime_ticks: 8 }
```

Every knob in section 4 is configurable, so difficulty can be tuned.

## 12. Tech stack and repo layout

TypeScript, Node 22, pnpm workspaces, Vitest (same stack as `@band-ai/sdk`).

```
firebreak/
  packages/
    engine/     pure deterministic simulation (no I/O, no clock)
    recorder/   SQLite schema, writer, reader, export
    runtime/    match runner, tick clock, agent loop, LLM client, budget
    teams/      none, perfect, band, subagents (later slack, linear)
    viewer/     Vite + PixiJS web app (live + replay)
    cli/        firebreak run | replay | verify | export | batch | report
  configs/      match configs
  runs/         recordings (git-ignored)
  docs/         SPEC.md, PLAN.md
```

## 13. Non-goals (for now)

- Humans playing inside a match (a possible v2 demo: a human joins the Band room mid-match).
- Mixing models or frameworks within one match.
- Hosting matches as a public service. Everything runs locally; Band, Slack and Linear are the only external services.
- Making Wildfire a general research benchmark.

## 14. Open questions

1. **Band delivery semantics.** Do room members that weren't @mentioned receive a message? This decides how the Band team handles broadcast vs targeted messages.
2. **Band accounts.** Which Band environment and organisation should host the match agents? 5 agents per concurrent Band team, created once and reused across matches?
3. **Sub-agent implementation.** Implement the spawn/return pattern ourselves (identical LLM client, cleanest comparison), or run it on the real Claude Agent SDK (more credible to outsiders, but a different loop)? Current proposal: our own implementation, with an Agent SDK variant as a later check.
4. **Tick length.** Is 5 s right? It depends on real model latency. Settle it during tuning (PLAN M5).
5. **Slack and Linear workspaces.** Dedicated sandbox workspaces for v1?
6. **Publishing.** Open-source the repo so outsiders can check fairness? That affects what can be committed (no internal URLs or keys).
