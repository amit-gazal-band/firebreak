# Prompt-v8 persistent-session benchmark

This report records the first full comparison made after Firebreak switched to synchronized logical ticks and persistent Claude/Codex subscription sessions. The SQLite recordings remain the source of truth; this document is a human-readable analysis of those recordings.

## Experiment

- Eight completed matches: two each with Claude Opus 5.5, GPT-5.6 Sol, Claude Sonnet 4.5, and GPT-5.6 Luna.
- Every match used seed 42, 60 synchronized ticks, engine 0.3.0, prompt v8, low reasoning effort, and all five communication conditions.
- Sub-agents were task-lived with no hard lifetime limit (`subagents.max_lifetime_ticks=0`).
- Each logical agent reused one provider session for the match. Each spawned sub-agent worker used one fresh session for its assignment.
- All eight recordings passed deterministic replay verification and have five saved commentary tracks.
- Claude and Codex ran through subscription backends. Dollar amounts in recordings are API-equivalent estimates, not charges incurred by these runs.

Holding seed 42 constant makes the communication conditions face the same world and event schedule. Repeating the same seed measures model sampling variance; it does **not** measure generalization across maps. With only two repetitions per model, these results are directional rather than definitive.

## Recordings and winners

| Model/run | Recording | None | Perfect | Sub-agents | Mentions | Broadcast | Winner |
|---|---|---:|---:|---:|---:|---:|---|
| Sol 1 | `runs/20260928-212300-s42-c1kc.sqlite` | 3 | 50 | 19 | 38 | 20 | Perfect |
| Opus 1 | `runs/20260928-214648-s42-bbfx.sqlite` | -36 | 80 | -15 | 53 | 35 | Perfect |
| Sol 2 | `runs/20260928-221326-s42-p6x7.sqlite` | -42 | 47 | 29 | 67 | 50 | Mentions |
| Opus 2 | `runs/20260928-223014-s42-geq6.sqlite` | -33 | 37 | 61 | 55 | 10 | Sub-agents |
| Sonnet 1 | `runs/20260928-230133-s42-9669.sqlite` | 27 | 62 | -46 | -16 | 11 | Perfect |
| Luna 1 | `runs/20260928-232749-s42-slxp.sqlite` | -28 | 19 | -22 | 8 | 37 | Broadcast |
| Sonnet 2 | `runs/20260928-235046-s42-j8g9.sqlite` | -14 | 43 | -52 | 20 | 36 | Perfect |
| Luna 2 | `runs/20260929-040758-s42-0v18.sqlite` | -19 | 73 | -23 | 38 | 0 | Perfect |

Win count: Perfect 5, Mentions 1, Broadcast 1, Sub-agents 1, None 0.

## Exact per-run outcomes

`Houses` means houses still standing at match end. `Fires out` is the number of extinguished fire tiles. `Calls` and `messages` are totals within that team world.

| Model/run | Communication | Score | Saved | Lost | Houses | Fires out | Calls | Messages |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Sol 1 | None | 3 | 1 | 4 | 11 | 18 | 177 | 0 |
| Sol 1 | Perfect | 50 | 3 | 2 | 10 | 10 | 214 | 0 |
| Sol 1 | Sub-agents | 19 | 2 | 3 | 8 | 19 | 233 | 25 |
| Sol 1 | Mentions | 38 | 3 | 2 | 8 | 8 | 261 | 81 |
| Sol 1 | Broadcast | 20 | 2 | 3 | 9 | 15 | 660 | 191 |
| Opus 1 | None | -36 | 0 | 5 | 10 | 14 | 177 | 0 |
| Opus 1 | Perfect | 80 | 4 | 1 | 9 | 15 | 217 | 0 |
| Opus 1 | Sub-agents | -15 | 1 | 4 | 8 | 15 | 211 | 24 |
| Opus 1 | Mentions | 53 | 3 | 2 | 9 | 18 | 274 | 66 |
| Opus 1 | Broadcast | 35 | 3 | 2 | 8 | 5 | 397 | 100 |
| Sol 2 | None | -42 | 0 | 5 | 9 | 13 | 188 | 0 |
| Sol 2 | Perfect | 47 | 3 | 2 | 9 | 12 | 199 | 0 |
| Sol 2 | Sub-agents | 29 | 2 | 3 | 11 | 14 | 250 | 40 |
| Sol 2 | Mentions | 67 | 4 | 1 | 8 | 7 | 247 | 71 |
| Sol 2 | Broadcast | 50 | 3 | 2 | 10 | 10 | 471 | 102 |
| Opus 2 | None | -33 | 0 | 5 | 10 | 17 | 180 | 0 |
| Opus 2 | Perfect | 37 | 3 | 2 | 8 | 7 | 218 | 0 |
| Opus 2 | Sub-agents | 61 | 3 | 2 | 9 | 26 | 241 | 27 |
| Opus 2 | Mentions | 55 | 3 | 2 | 10 | 15 | 259 | 62 |
| Opus 2 | Broadcast | 10 | 2 | 3 | 8 | 10 | 366 | 69 |
| Sonnet 1 | None | 27 | 2 | 3 | 10 | 17 | 171 | 0 |
| Sonnet 1 | Perfect | 62 | 4 | 1 | 8 | 2 | 191 | 0 |
| Sonnet 1 | Sub-agents | -46 | 0 | 5 | 10 | 4 | 194 | 17 |
| Sonnet 1 | Mentions | -16 | 1 | 4 | 9 | 9 | 235 | 38 |
| Sonnet 1 | Broadcast | 11 | 2 | 3 | 9 | 6 | 259 | 34 |
| Luna 1 | None | -28 | 1 | 4 | 8 | 2 | 190 | 0 |
| Luna 1 | Perfect | 19 | 2 | 3 | 10 | 9 | 230 | 0 |
| Luna 1 | Sub-agents | -22 | 1 | 4 | 8 | 8 | 304 | 70 |
| Luna 1 | Mentions | 8 | 2 | 3 | 8 | 8 | 335 | 112 |
| Luna 1 | Broadcast | 37 | 3 | 2 | 8 | 7 | 546 | 155 |
| Sonnet 2 | None | -14 | 1 | 4 | 9 | 11 | 161 | 0 |
| Sonnet 2 | Perfect | 43 | 3 | 2 | 8 | 13 | 222 | 0 |
| Sonnet 2 | Sub-agents | -52 | 0 | 5 | 9 | 3 | 207 | 20 |
| Sonnet 2 | Mentions | 20 | 2 | 3 | 10 | 10 | 319 | 95 |
| Sonnet 2 | Broadcast | 36 | 3 | 2 | 8 | 6 | 311 | 50 |
| Luna 2 | None | -19 | 1 | 4 | 8 | 11 | 189 | 0 |
| Luna 2 | Perfect | 73 | 4 | 1 | 9 | 8 | 218 | 0 |
| Luna 2 | Sub-agents | -23 | 1 | 4 | 8 | 7 | 246 | 41 |
| Luna 2 | Mentions | 38 | 3 | 2 | 8 | 8 | 339 | 90 |
| Luna 2 | Broadcast | 0 | 2 | 3 | 7 | 5 | 564 | 146 |

## Aggregate results

Every non-SD cell below is `mean / median`. Score variability is the sample standard deviation across the runs in that block.

### Opus 5.5 and GPT-5.6 Sol (four runs)

| Communication | Score | Score SD | Saved | Lost | Houses | Fires out | Calls | Messages |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| None | -27.0 / -34.5 | 20.3 | 0.25 / 0 | 4.75 / 5 | 10 / 10 | 15.5 / 15.5 | 180.5 / 178.5 | 0 / 0 |
| Perfect | **53.5 / 48.5** | 18.5 | 3.25 / 3 | 1.75 / 2 | 9 / 9 | 11 / 11 | 212 / 215.5 | 0 / 0 |
| Sub-agents | 23.5 / 24 | 31.3 | 2 / 2 | 3 / 3 | 9 / 8.5 | 18.5 / 17 | 233.8 / 237 | 29 / 26 |
| Mentions | 53.3 / **54** | 11.9 | 3.25 / 3 | 1.75 / 2 | 8.75 / 8.5 | 12 / 11.5 | 260.3 / 260 | 70 / 68.5 |
| Broadcast | 28.8 / 27.5 | 17.5 | 2.5 / 2.5 | 2.5 / 2.5 | 8.75 / 8.5 | 10 / 10 | 473.5 / 434 | 115.5 / 101 |

Perfect and Mentions were effectively tied on mean score in the advanced-model block. Perfect had the slightly higher mean; Mentions had the higher median and lower variance.

### Sonnet 4.5 and GPT-5.6 Luna (four runs)

| Communication | Score | Score SD | Saved | Lost | Houses | Fires out | Calls | Messages |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| None | -8.5 / -16.5 | 24.4 | 1.25 / 1 | 3.75 / 4 | 8.75 / 8.5 | 10.25 / 11 | 177.8 / 180 | 0 / 0 |
| Perfect | **49.3 / 52.5** | 23.7 | 3.25 / 3.5 | 1.75 / 1.5 | 8.75 / 8.5 | 8 / 8.5 | 215.3 / 220 | 0 / 0 |
| Sub-agents | -35.8 / -34.5 | 15.5 | 0.5 / 0.5 | 4.5 / 4.5 | 8.75 / 8.5 | 5.5 / 5.5 | 237.8 / 226.5 | 37 / 30.5 |
| Mentions | 12.5 / 14 | 22.6 | 2 / 2 | 3 / 3 | 8.75 / 8.5 | 8.75 / 8.5 | 307 / 327 | 83.75 / 92.5 |
| Broadcast | 21 / 23.5 | 18.5 | 2.5 / 2.5 | 2.5 / 2.5 | 8 / 8 | 6 / 6 | 420 / 428.5 | 96.25 / 98 |

Perfect won this block clearly. Sub-agents performed especially poorly with these two models.

### All eight runs

| Communication | Score | Score SD | Saved | Lost | Houses | Fires out | Calls | Messages |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| None | -17.8 / -23.5 | 23.0 | 0.75 / 1 | 4.25 / 4 | 9.38 / 9.5 | 12.88 / 13.5 | 179.1 / 178.5 | 0 / 0 |
| Perfect | **51.4 / 48.5** | 19.8 | 3.25 / 3 | 1.75 / 2 | 8.88 / 9 | 9.5 / 9.5 | 213.6 / 217.5 | 0 / 0 |
| Sub-agents | -6.1 / -18.5 | 39.1 | 1.25 / 1 | 3.75 / 4 | 8.88 / 8.5 | 12 / 11 | 235.8 / 237 | 33 / 26 |
| Mentions | 32.9 / 38 | 27.5 | 2.63 / 3 | 2.38 / 2 | 8.75 / 8.5 | 10.38 / 8.5 | 283.6 / 267.5 | 76.88 / 76 |
| Broadcast | 24.9 / 27.5 | 17.2 | 2.5 / 2.5 | 2.5 / 2.5 | 8.38 / 8 | 8 / 6.5 | 446.8 / 434 | 105.88 / 101 |

## Model-specific mean scores

Each cell averages the model's two repetitions.

| Model | None | Perfect | Sub-agents | Mentions | Broadcast | Best mean |
|---|---:|---:|---:|---:|---:|---|
| Claude Opus 5.5 | -34.5 | **58.5** | 23.0 | 54.0 | 22.5 | Perfect |
| GPT-5.6 Sol | -19.5 | 48.5 | 24.0 | **52.5** | 35.0 | Mentions |
| Claude Sonnet 4.5 | 6.5 | **52.5** | -49.0 | 2.0 | 23.5 | Perfect |
| GPT-5.6 Luna | -23.5 | **46.0** | -22.5 | 23.0 | 18.5 | Perfect |

## Interpretation

### Overall winner

Perfect communication was the strongest information condition on this fixed world. It had the best pooled mean score (51.4), won five of eight matches, and averaged 3.25 civilians saved with 1.75 lost. Perfect is an oracle condition: every peer sees the full current world state, so it is an upper-bound information treatment rather than a deployable communication mechanism.

### Strongest realistic peer chat

Mentions-only chat was the strongest realistic peer-to-peer communication condition. With Opus and Sol it nearly tied Perfect: 53.3 versus 53.5 mean score, while producing the higher median and lower score variance. Sol's best mean was Mentions. Across all models, however, Mentions was less reliable than Perfect and generated about 77 messages and 284 model calls per match.

### Broadcast overhead

Room broadcast averaged about 106 messages and 447 model calls, more than twice Perfect's roughly 214 calls. Every message wakes multiple recipients, increasing decision volume and context load. Broadcast won one Luna match but did not turn its much larger communication load into a consistent score advantage.

### Sub-agent sensitivity

Sub-agents had the largest score variance (39.1). They won one Opus match with 61 points and extinguished many fires in the advanced-model block, but collapsed with Sonnet and Luna. The result suggests that the orchestrator/worker lifecycle is much more model-sensitive than direct peer communication. It should not be described as uniformly better or worse from this sample.

### Why fire counts do not determine the winner

The score is `10 × saved - 20 × lost + fires extinguished + 5 × houses standing`. None and Sub-agents extinguished more fires than Perfect on average, but their additional civilian losses overwhelmed those gains. This is why a team can look active at suppression and still finish with a negative score.

## Conclusion

For this seed and prompt version, Perfect is the overall winner and the most call-efficient high-scoring condition. Mentions is the best realistic chat design, especially with the strongest models. Broadcast is costly and noisy, and task-lived Sub-agents are promising only when the model reliably completes and reports bounded assignments.

The next rigorous experiment should preserve this configuration while adding a preregistered multi-seed set and more repetitions per model. Results from different engines, prompts, clock modes, model settings, tick counts, or backends must not be pooled with this table.

## Reproducing the analysis

Inspect an individual recording with:

```bash
pnpm firebreak metrics runs/20260928-212300-s42-c1kc.sqlite
pnpm firebreak verify runs/20260928-212300-s42-c1kc.sqlite
```

Generate a formal report for each comparable model pair. The cross-model tables above are descriptive pooled summaries and retain the limitations already noted.

```bash
pnpm firebreak report \
  runs/20260928-212300-s42-c1kc.sqlite \
  runs/20260928-221326-s42-p6x7.sqlite \

pnpm firebreak report \
  runs/20260928-214648-s42-bbfx.sqlite \
  runs/20260928-223014-s42-geq6.sqlite \

pnpm firebreak report \
  runs/20260928-230133-s42-9669.sqlite \
  runs/20260928-235046-s42-j8g9.sqlite \

pnpm firebreak report \
  runs/20260928-232749-s42-slxp.sqlite \
  runs/20260929-040758-s42-0v18.sqlite
```
