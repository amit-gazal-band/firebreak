# Tuning notes

Measurements behind the defaults in `packages/engine/src/config.ts` and `packages/runtime/src/config.ts`. Dates are 2026-09-27; model `claude-haiku-4-5-20251001`, backend `claude-code` unless noted.

## 1. Game rules (scripted bots)

`packages/cli/scripts/bot-tune.ts` plays `bots-none` (own vision only) against `bots-perfect` (union vision) on 30 seeds per setting. The bots are dumb on purpose; the question is only whether shared information pays.

| spread | growth every | civilian deadline | none | perfect |
|---|---|---|---|---|
| 0.08 | 4 | 12 | −22 | +14 |
| 0.05 | 6 | 16 | −3 | +36 |
| 0.035 | 6 | 16 | −3 | +38 |

Chosen: `base_spread 0.05`, `growth_every 5`, `civilian_deadline 15`, and the rescuer drives at 2 tiles/tick (at 1 tile/tick almost every civilian was lost even with perfect information). Fires still escalate if ignored, and information clearly matters.

## 2. LLM latency on the `claude-code` backend

| Change | Mean decision latency | Mean input tokens |
|---|---|---|
| First version, one `query()` per decision | 14–21 s (max 43 s) | 3k, but some calls ~85k |
| Pre-started ("warm") streaming sessions | ~4.7 s | 82k on every call (reverted) |
| Return on the tool result instead of waiting for the subprocess to exit | ~2 s saved per call | — |
| `thinking: { type: "disabled" }` | **~4 s** | 19–30k |
| `strictMcpConfig: true` (don't load the account's claude.ai connectors) | ~4 s | **~3k** |

Concurrency is not the bottleneck: 10 parallel trivial calls take ~3.4 s, 20 take 4–9 s. A 5 s tick fits.

## 3. Agent competence (prompt version 2)

First full match (seed 5, four teams): `none −52`, `perfect −54`, `band −54`, `subagents +7`. All the difference was two civilians the sub-agents happened to reach. The replays showed why the other teams failed:

- firefighters on `wait()` with fires in view,
- the rescuer retrying `move_to` behind debris after a bare `no_path`,
- many `move_to` orders onto water or houses (coordinate misreads), each costing a retry turn.

Fixes, identical for every team:

- `move_to` onto an impossible tile is redirected to the nearest reachable tile (SPEC §4.3).
- Blocked orders explain themselves: `no_path: debris at (17,6) blocks the way; the engineer can clear it`.
- Role playbooks in the system prompt (target orders walk there by themselves; don't wait when there is work; pair up on intensity-3 fires; debris the rescuer needs comes first).
- The map header shows two-digit column numbers.

After the fixes, seed 5 over 30 ticks: `none −60`, `perfect +3`. The reference gap exists.

## 4. Batch 1: seeds 11–13, prompt v2

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | −80 | 17 | 12 | −50 |
| 12 | −1 | 49 | −34 | −9 |
| 13 | −52 | 7 | −47 | −50 |
| **mean** | **−44** | **+24** | **−23** | **−36** |

- The reference gap holds on every seed (perfect − none ≈ 68 points on average), so the game rewards information. That was the M5 gate.
- Band averaged ahead of sub-agents but far below perfect. Its metrics showed why: 2–3× more idle agent-ticks than perfect, and **about 30% of Band decisions sent a message without giving an order** (73 of 239 on seed 11). The agents talked instead of acting. Band never used `create_room`.
- Sub-agents: the orchestrator's queue is short, but bodies sit idle between spawns (idle agent-ticks 126–156, the highest of all teams). The forecast almost never reached a non-scout (0–1 tick lead).

Fix (prompt v3, shared rules text, so it applies to every team with communication tools): *"a message never replaces an order. In the same turn, send what teammates need to know AND give your own order."*

## 5. Batch 2: seeds 11–13, prompt v3

Not run yet: the first match hit the Claude subscription's usage limit at tick 1. The runner aborted it as `aborted: usage_limit`, the batch stopped, and `report` skips it. Rerun when the limit resets:

```bash
pnpm firebreak batch --seeds 3 --first-seed 11 --yes && pnpm firebreak report
```

Budget note: batch 1 (3 four-team matches) used ~2,000 decisions (~$8 at API prices). On the subscription backend that is enough to hit the usage window; plan larger batches on the `api` backend or across several windows.
