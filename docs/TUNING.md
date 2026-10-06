# Tuning notes

Measurements behind the defaults in `packages/engine/src/config.ts` and `packages/runtime/src/config.ts`. Dates are 2026-09-27; model `claude-haiku-4-5-20251001`, backend `claude-code` unless noted.

## 1. Game rules (scripted bots)

`packages/cli/scripts/bot-tune.ts` plays `bots-none` (own vision only) against `bots-perfect` (union vision) on 30 seeds per setting. The bots are dumb on purpose; the question is only whether shared information pays.

| spread | growth every | civilian deadline | none | perfect |
|---|---|---|---|---|
| 0.08 | 4 | 12 | −22 | +14 |
| 0.05 | 6 | 16 | −3 | +36 |
| 0.035 | 6 | 16 | −3 | +38 |

The original tuning selected `base_spread 0.05`, `growth_every 5`, `civilian_deadline 15`, and a rescuer speed of 2 tiles/tick (at 1 tile/tick almost every civilian was lost even with perfect information). After the longer 120-tick agent runs exposed how little response time remained after another agent discovered and communicated a civilian, engine v0.3 raises the default deadline by two ticks to 17. The deadline remains configurable; this is an engine-rule change, so recordings from the two defaults are not outcome-comparable.

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

The first attempt hit the Claude subscription's usage limit at tick 1; the runner aborted it (`aborted: usage_limit`) and `report` skips it. Rerun after the limit reset:

| Seed | none | perfect | band | subagents |
|---|---|---|---|---|
| 11 | 10 | 14 | **43** | −20 |
| 12 | −41 | −5 | **−4** | −5 |
| 13 | 5 | −24 | **40** | −60 |
| **mean** | **−9** | **−5** | **+26** | **−28** |

- Band scored highest on 2 seeds and tied on the third. Its message-only decisions dropped, and it sent more messages (100–111 per match vs 59–75), sharing more while still acting.
- **The reference gap did not hold in this batch**: perfect ≈ none on average and below it on seed 13. The same seeds varied a lot between batches (none on seed 13: −52 then +5), so LLM variance per match is large compared to the effects.
- Likely reasons the "perfect" team is not a real ceiling with LLM agents: its prompts carry everyone's view and orders, and agents tend to herd onto the same visible fire. It remains the right *information* ceiling; it is not a *play-quality* ceiling.
- The report now computes relative score from the team means (per-seed ratios exploded, e.g. 825% on seed 11).

## 6. Before a public demo

1. Run 10–20 seeds per configuration. With per-match swings of ±50 points, 3 seeds cannot separate the teams reliably. Use the `api` backend or spread batches across usage windows (~2,000 decisions per 3 four-team matches).
2. Try one batch with a stronger model (open question §14.7): weak play adds noise that hides communication effects.
3. Look at why `perfect` underperforms (herding, prompt size), e.g. give each agent its own view plus a compact list of teammates' orders instead of the full union.
4. Keep the showcase honest: pick replays that show the mechanism (idle sub-agent bodies, forecasts that never arrive), not just the biggest score gap.

## 7. Local chat and OpenAI backend (prompt v4)

The default comparison changed from `none,perfect,band,subagents` to `none,perfect,chat-mentions,chat-broadcast`. Real Band and sub-agents remain selectable, but the default now isolates one delivery rule without credentials or network variance:

- `chat-mentions`: only mentioned teammates receive and wake.
- `chat-broadcast`: all teammates receive and wake; mentions still identify the intended recipients for noise metrics.

Both conditions expose the same tool and prompt wording except for the delivery rule. Offline fake-LLM tests verify recipient counts and deterministic replay. API smoke tests on 2026-09-28:

| Backend/model | Setup | Result | Recorded cost |
|---|---|---|---:|
| Anthropic API / `claude-haiku-4-5-20251001` | 1 tick, `none`, seed 101 | completed and verified | $0.026 |
| Anthropic API / `claude-opus-5-5` (`low` effort) | 1 tick, `none`, seed 103 | completed and verified | $0.090 |
| OpenAI Responses / `gpt-5.6-luna` (`low` effort) | 1 tick, `none`, seed 102 | blocked: supplied API key returned HTTP 401 | $0 |

The four new default teams also completed and verified a 6-tick Haiku API match on seed 104. Scores were all +45 at this short horizon; costs were `$0.071 none`, `$0.071 perfect`, `$0.091 chat-mentions`, and `$0.084 chat-broadcast`. The recording contains 10 targeted-room messages and 8 broadcast-room messages. `mentions: ["all"]` intentionally expands to all four peers in the targeted condition, while narrower mentions deliver only to the named peers.

The OpenAI path uses `store: false`, replays all response items only inside a validation-error retry, and records input, output, cache-read, cache-write, latency, and estimated cost. Full cross-model runs must wait for a valid OpenAI credential so both providers can be tested symmetrically.

### Paired advanced-model run protocol

Each requested production repetition uses seed `42`. Every match contains `none`, `perfect`, `chat-mentions`, and `chat-broadcast`, and `MatchRunner` constructs one scenario from that seed and gives the identical initial world and event schedule to all four teams. Using seed `42` for every Claude Opus 5.5 and GPT-5.6 Sol repetition keeps the world fixed across providers as well; only model sampling and the communication condition can vary. The recording header stores the seed, complete scenario, model, prompt version, and tool definitions so this pairing is auditable.

For a later statistical study, use several seeds but keep the same seed list for every model and condition (paired blocks). A single fixed seed is ideal for this requested apples-to-apples replay set, but it does not measure performance across different maps.

### Seed 42 advanced-model repetitions

Four 60-tick repetitions per model used prompt v4, low reasoning effort, a 1,024-token output cap, and the same five conditions. `chat-mentions` and `chat-broadcast` are the local simulated Band-style rooms, not real Band infrastructure. All eight recordings completed and replay-verified.

| Model | Repetition | None | Perfect | Sub-agents | Mentions | Broadcast | Winner |
|---|---:|---:|---:|---:|---:|---:|---|
| Claude Opus 5.5 | 1 | -5 | 85 | 51 | 51 | 63 | Perfect |
| Claude Opus 5.5 | 2 | -4 | 73 | 50 | 61 | 51 | Perfect |
| Claude Opus 5.5 | 3 | -9 | 20 | 44 | 36 | 54 | Broadcast |
| Claude Opus 5.5 | 4 | 1 | 82 | 47 | 55 | 12 | Perfect |
| GPT-5.6 Sol | 1 | -11 | 48 | 53 | 52 | 50 | Sub-agents |
| GPT-5.6 Sol | 2 | 31 | 15 | 10 | 56 | 51 | Mentions |
| GPT-5.6 Sol | 3 | -12 | 49 | 43 | 48 | 15 | Perfect |
| GPT-5.6 Sol | 4 | -3 | 53 | 17 | 52 | 49 | Perfect |

Model-specific score summaries (mean ± sample standard deviation):

| Model | None | Perfect | Sub-agents | Mentions | Broadcast |
|---|---:|---:|---:|---:|---:|
| Claude Opus 5.5 | -4.3 ± 4.1 | **65.0 ± 30.4** | 48.0 ± 3.2 | 50.8 ± 10.7 | 45.0 ± 22.6 |
| GPT-5.6 Sol | 1.3 ± 20.2 | 41.3 ± 17.6 | 30.8 ± 20.5 | **52.0 ± 3.3** | 41.3 ± 17.5 |

Across the eight equally weighted recordings, perfect won 5, and sub-agents, mentions, and broadcast won 1 each; none won 0. The descriptive combined means were perfect 53.1, mentions 51.4, broadcast 43.1, sub-agents 39.4, and none -1.5. Keep the model-specific tables as the formal comparison: mixing backends can hide model/transport interactions.

The main mechanism result is clearer than the overall winner count. Mentions beat broadcast head-to-head in all four Sol repetitions and 6 of 8 recordings overall. Broadcast woke every peer, producing more LLM calls and noise: mean noise was 50% for Opus and 61% for Sol, versus 0% for targeted mentions. It was also the most expensive condition. Total recorded API cost for the eight matches was approximately $87.08 ($50.67 Opus, $36.41 Sol).

These repetitions estimate model sampling variance on one fixed world. They do not establish performance across wildfire maps; that requires paired multi-seed blocks.

## 8. Task-lived sub-agents and joint coverage (prompt v5)

The original sub-agent condition forcibly ended every worker after 8 ticks. That made bodies repeatedly lose task context even when an assignment was still in progress. Prompt v5 makes workers task-lived: one worker owns one assignment until it explicitly reports `completed` or `blocked`, and its accumulated sightings are carried into each stateless decision. The old cutoff remains available as `subagents.max_lifetime_ticks: 8`; the new default `0` disables it. Offline lifecycle tests cover both modes (no automatic report after 10 ticks by default; an automatic blocked report at tick 8 when opted in). Production scores above are prompt-v4 results and must not be compared directly with new prompt-v5 runs.

The old “missed joint” metric only counted a firefighter already adjacent to an intensity-3 fire and spraying alone. On `20260928-065207-s42-err3.sqlite` it reported `0` for all five teams, although every team experienced 20 intensity-3 fire-ticks and none ever assigned both firefighters to the same intensity-3 target (perfect assigned one firefighter for 1 tick; the other conditions assigned none). The replacement metric counts intensity-3 fire-ticks with fewer than two assigned firefighters, producing `20` rather than the misleading `0` for each condition in that recording.

Prompt v5 also makes the clock and fire severity explicit. Every agent receives total ticks, current tick, and ticks remaining in the system layer. Observations already expose exact numeric intensity; the shared prompt now states that higher intensity raises spread probability, intensity 3 is maximum severity, and threatening intensity-3 fires require an immediate paired assignment.

## 9. 120-tick subscription runs and bounded assignments (prompts v5–v6)

Four prompt-v5 repetitions per model used seed 42, 120 ticks, low reasoning effort, a 1,024-token output cap, and `subagents.max_lifetime_ticks: 0`. Every match contained `none`, `perfect`, `subagents`, `chat-mentions`, and `chat-broadcast`. Gameplay used the local Claude and Codex subscription backends; the dollar figures in the reports are API-equivalent estimates, not bills. All eight matches completed, saved five Haiku subscription commentary broadcasts, and replay-verified exactly.

| Model | Repetition | None | Perfect | Sub-agents | Mentions | Broadcast | Winner |
|---|---:|---:|---:|---:|---:|---:|---|
| Claude Opus 5.5 | 1 | 12 | 74 | 23 | 51 | 72 | Perfect |
| Claude Opus 5.5 | 2 | 13 | -15 | -39 | 76 | 50 | Mentions |
| Claude Opus 5.5 | 3 | 13 | 73 | -16 | 81 | 56 | Mentions |
| Claude Opus 5.5 | 4 | 14 | 44 | -36 | 83 | 48 | Mentions |
| GPT-5.6 Sol | 1 | -31 | 39 | -52 | 27 | 3 | Perfect |
| GPT-5.6 Sol | 2 | -30 | 16 | -1 | 24 | 28 | Broadcast |
| GPT-5.6 Sol | 3 | -19 | 8 | -31 | -5 | -16 | Perfect |
| GPT-5.6 Sol | 4 | -27 | 60 | -65 | 7 | -4 | Perfect |

Model-specific score summaries (mean ± sample standard deviation):

| Model | None | Perfect | Sub-agents | Mentions | Broadcast |
|---|---:|---:|---:|---:|---:|
| Claude Opus 5.5 | 13.0 ± 0.8 | 44.0 ± 41.7 | -17.0 ± 28.6 | **72.8 ± 14.8** | 56.5 ± 10.9 |
| GPT-5.6 Sol | -26.8 ± 5.4 | **30.8 ± 23.5** | -37.3 ± 27.9 | 13.3 ± 15.0 | 2.8 ± 18.6 |

Across the eight recordings, perfect won four, mentions three, broadcast one, and neither sub-agents nor no-communication won. Perfect's 6-tick forecast lead in every repetition confirms that its failures were not missing-information failures. It is an information ceiling, not a centralized-planning or play-quality ceiling: five independent agents can still herd, duplicate work, or prioritize badly.

The task-lived lifecycle exposed a model-dependent failure. Opus created 124 assignments and received 116 reports (103 completed, 13 blocked), with a report-weighted mean duration of about 16 ticks. Sol created only 46 assignments and received 43 reports (29 completed, 14 blocked), with a mean duration of about 46 ticks; individual assignments lasted as long as 118 ticks. Sol's orchestrator therefore received far fewer opportunities to reconsider work, and its sub-agent condition averaged below no communication.

Prompt v6 responds without restoring an arbitrary lifetime. `spawn` now requires separate `brief` and `done_when` fields; `done_when` must give observable acceptance criteria. The orchestrator is forbidden from assigning indefinite watch/patrol work, and the runtime rejects explicit “until the match ends” variants. Workers re-check the criteria after every observation and order result, call `finish(completed, report)` immediately when satisfied, and use `blocked` only for a concrete unrecoverable obstacle. This preserves the real sub-agent lifecycle—task, work, completion report—while preventing an inherently endless task from occupying a body for the whole match. Prompt-v5 results above must not be compared directly with future prompt-v6 runs.

## 10. Synchronized decision barriers (prompt v7)

All production results above used the legacy real-time clock: the engine advanced every five wall-clock seconds even when a provider call was still running. Inspection of the prompt-v6 seed-42 replay showed why this confounds the communication experiment. In one broadcast world, the rescuer reached its assigned location at tick 16, then a 77.5-second call remained in flight while a civilian appeared at tick 19. The stale response arrived at tick 31; the rescuer could only react and save the civilian at tick 32. That delay was provider scheduling, not a communication decision.

Prompt v7 makes synchronized ticks the default. All decisions, deliveries, reports, orchestrator work, and newly triggered follow-up decisions settle before the next engine step. Actual model latency is stored separately as `llm_call.latency_ms`; it affects wall-clock experiment cost but not simulated reaction time. `--realtime` retains the old behavior for explicit latency experiments, and `--virtual` is a compatibility alias for synchronized mode.

This is a new experimental regime. Do not compare prompt-v7 synchronized scores against any prompt-v1–v6 table above. Future comparisons must hold `clock.mode`, prompt version, engine version, backend/model, seed set, ticks, and `tick_ms` constant.

## 11. Persistent subscription sessions (prompt v8)

The first synchronized five-condition Codex attempt exposed a backend error before it could become a result. It aborted around tick 35 at the 10-million-token safety cap after 1,015 calls. The conditions had accumulated approximately 1.16M input tokens for none, 1.07M for perfect, 1.47M for sub-agents, 2.23M for mentions, and 3.97M for broadcast. Broadcast was especially expensive because every room message wakes four recipients, but the underlying problem affected every condition: the runtime reused the Codex App Server process while starting a fresh conversation for every decision. Every wake resent the base prompt and bounded history. The aborted recording is diagnostic only and must not be scored.

Prompt v8 gives every logical agent a real provider session on the subscription backends. Claude resumes the same Agent SDK transcript; Codex sends later `turn/start` calls to the same isolated App Server thread. A sub-agent orchestrator has one match-long session, while each spawned worker gets a fresh assignment-scoped session and ends with that assignment. Later turns still receive the complete current observation, current/remaining ticks, and new wake reasons, but only newly delivered messages and order-log changes are appended. Provider-reported cumulative thread usage is converted to per-turn deltas before it reaches recording and budget accounting.

This changes both context and token behavior, so prompt-v8 results are not comparable with any table above. Validate the reduction with a short subscription smoke run before starting another 60- or 120-tick experiment.

## 12. Prompt-v8 persistent-session comparison

The complete benchmark report, including every per-run outcome and the mean/median tables for scores, rescues, losses, houses, fires, calls, and messages, is in [PROMPT_V8_BENCHMARK.md](PROMPT_V8_BENCHMARK.md).

Eight completed 60-tick matches used seed 42, synchronized ticks, prompt v8, engine 0.3.0, low reasoning effort, task-lived sub-agents, and all five communication conditions. Each model ran twice: Claude Opus 5.5, GPT-5.6 Sol, Claude Sonnet 4.5, and GPT-5.6 Luna. Reusing seed 42 holds the wildfire world fixed and measures model sampling variance; it does not measure generalization across maps. Every recording replay-verified, and each has five saved commentary tracks.

| Model/run | Recording | None | Perfect | Sub-agents | Mentions | Broadcast | Winner |
|---|---|---:|---:|---:|---:|---:|---|
| Sol 1 | `20260928-212300-s42-c1kc` | 3 | 50 | 19 | 38 | 20 | Perfect |
| Opus 1 | `20260928-214648-s42-bbfx` | -36 | 80 | -15 | 53 | 35 | Perfect |
| Sol 2 | `20260928-221326-s42-p6x7` | -42 | 47 | 29 | 67 | 50 | Mentions |
| Opus 2 | `20260928-223014-s42-geq6` | -33 | 37 | 61 | 55 | 10 | Sub-agents |
| Sonnet 1 | `20260928-230133-s42-9669` | 27 | 62 | -46 | -16 | 11 | Perfect |
| Luna 1 | `20260928-232749-s42-slxp` | -28 | 19 | -22 | 8 | 37 | Broadcast |
| Sonnet 2 | `20260928-235046-s42-j8g9` | -14 | 43 | -52 | 20 | 36 | Perfect |
| Luna 2 | `20260929-040758-s42-0v18` | -19 | 73 | -23 | 38 | 0 | Perfect |

Score summaries (mean / median; sample standard deviation in parentheses):

| Block | None | Perfect | Sub-agents | Mentions | Broadcast |
|---|---:|---:|---:|---:|---:|
| Opus + Sol (4) | -27.0 / -34.5 (20.3) | **53.5 / 48.5 (18.5)** | 23.5 / 24.0 (31.3) | 53.3 / **54.0** (11.9) | 28.8 / 27.5 (17.5) |
| Sonnet + Luna (4) | -8.5 / -16.5 (24.4) | **49.3 / 52.5 (23.7)** | -35.8 / -34.5 (15.5) | 12.5 / 14.0 (22.6) | 21.0 / 23.5 (18.5) |
| All eight | -17.8 / -23.5 (23.0) | **51.4 / 48.5 (19.8)** | -6.1 / -18.5 (39.1) | 32.9 / 38.0 (27.5) | 24.9 / 27.5 (17.2) |

Perfect won five matches, while Mentions, Broadcast, and Sub-agents won one each. Across all eight, Perfect averaged 3.25 civilians evacuated and 1.75 lost, compared with 2.63/2.38 for Mentions, 2.50/2.50 for Broadcast, 1.25/3.75 for Sub-agents, and 0.75/4.25 for None. Those rescue outcomes dominate the scoring: a lost civilian costs 20 points, whereas extinguishing one fire tile adds only one. None and Sub-agents extinguished more fires on average than Perfect but could not offset their civilian losses.

Perfect also achieved its result with about 214 model calls per match, versus 284 for Mentions and 447 for Broadcast. Broadcast averaged about 106 messages and created the largest wake/context load without a consistent score benefit. The result supports Perfect as the strongest information condition on this fixed world, but not as a general theorem: there are only two samples per model, the same seed is reused, and the pooled Opus/Sol and Sonnet/Luna rows mix models and backends. Model-specific comparisons remain the formal unit.
