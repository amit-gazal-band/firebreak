# Showcase replays

Self-contained HTML replays (open in any browser, no setup). Keys: space, ←/→, 1–5; click an agent to inspect it; click a board's header to focus on that team. *board / graph / both* switches each card to the communication graph (who messaged whom, on one scale for all teams; click an edge to filter the feed to that pair). *expand feeds* shows 10 lines of messages and lets you scroll back through all of them; click a line to jump to it. *messages / actions / all* switches the feeds to what agents did (tool calls, validation errors, order outcomes); click an action to see that decision in the inspector. Click a score for its log; the chips under it add up to the total.

| File                      | Seed | Result                                                | Why it's a good demo                                                                                                                   |
| ------------------------- | ---- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `seed-11-four-teams.html` | 11   | none −80 · perfect +17 · **band +12** · subagents −50 | Band gets close to the perfect-communication ceiling; the sub-agent bodies sit idle between spawns and the forecast never reaches them |

Recorded 2026-09-27 with `claude-haiku-4-5-20251001` on the `claude-code` backend. Each file is one match. See docs/TUNING.md for the batches and their caveats (3 seeds is not enough to call results).
