# Changelog

Notable Firebreak changes are recorded here. Recordings remain the source of truth for match outcomes; implementation changes do not rewrite historical SQLite files.

## 2026-09-28

### Added

- Added the local `chat-mentions` communication condition, where only explicitly named agents receive a message.
- Added the local `chat-broadcast` condition, where every agent receives every room message and mentions identify intended readers.
- Added the OpenAI Responses API backend and model/cost accounting for OpenAI matches.
- Added the `codex` subscription backend using a headless Codex App Server and the local ChatGPT login.
- Added an omniscient post-match commentator for every communication condition.
- Added saved, versioned commentary sidecars under `runs/commentary/` so historical broadcasts are generated once and reused.
- Added automatic commentary generation for historical replays that do not already have saved commentary.
- Added a full broadcast transcript reader, viewer legend, rules reference, and labelled timeline markers.
- Added per-team mission-outcome counters and an outcome-over-time replay chart with metric and communication-style toggles.
- Added paired advanced-model comparison notes and reports for Claude and OpenAI runs.
- Added a replay-visible sub-agent lifecycle configurator that produces the exact next-run override.
- Added persistent View controls for mission stats, operational stats, team messages, AI commentary, and the comparison chart.
- Added a full, untruncated team-message transcript for every replay card.
- Added recorded sub-agent assignment ages and a diagnostic long-running flag that never kills or interrupts the worker.
- Added a standalone prompt-v8 benchmark report with exact outcomes from all eight persistent-session matches, complete mean/median tables, model-specific results, and conclusions.
- Added a persisted Dark/Light viewer theme toggle across the recording index, replay, dialogs, charts, and rules reference.
- Added a persistent collapse/expand control to the outcome comparison chart.

### Changed

- Replaced fresh-per-decision Claude/Codex calls with real per-agent subscription sessions. Claude resumes the same transcript and Codex appends turns to the same isolated App Server thread; spawned sub-agent workers receive a fresh session per assignment. Stateful prompts now send only new messages and order updates, and usage/cost accounting records per-turn values rather than cumulative session totals. Bumped the shared prompt version to v8.
- Made synchronized logical ticks the default: every agent decision and message/report cascade settles before all worlds advance one engine step. Added `--realtime` for the legacy wall-clock behavior and kept `--virtual` as a compatibility alias.
- Separated logical replay timestamps from actual model latency in schema v2, so synchronized runs remain tick-aligned while the inspector still reports provider/process wall time.
- Updated shared prompt v7 to describe discrete persistent-order ticks without falsely claiming that the world always advances while a model is responding.
- Reworked broadcast text into connected, human-readable incident commentary without coordinates, internal IDs, tick numbers, or simulation jargon.
- Moved replay commentary loading into the background so refreshing a replay does not repeatedly block on generation.
- Made local Claude/Haiku the default replay commentator, independently of the gameplay model.
- Documented that displayed subscription dollar figures are API-equivalent estimates rather than billed charges.
- Documented the scoring information agents receive and the requirements for a valid cross-run comparison.
- Made sub-agents task-lived by default: they retain one assignment, accumulated sightings, and order history until they report completion or blockage. The former eight-tick cutoff remains an opt-in setting.
- Added total/current/remaining tick information to every gameplay agent's system instructions and clarified the visibility, spread risk, and response priority of fire intensity.
- Replaced the narrow “missed joint” counter with uncovered intensity-3 fire-ticks, which includes ignored and singly assigned joint fires.
- Reworked the replay grid to size boards from available width instead of fixed panel-height estimates, and made statistic labels wrap into responsive three- or six-column layouts.
- Separated the comparison chart from the board grid and fixed every card section to shared responsive heights, preventing stale canvas dimensions from stretching one card or misaligning statistics across teams.
- Grouped mission outcomes into vertical civilian, fire, and house pairs, and exposed the saved commentator backend/model directly in each broadcast panel.
- Tightened task-lived sub-agents in prompt v6: every spawn now requires observable `done_when` criteria, workers must report immediately when those criteria are met, and explicitly open-ended watch/patrol assignments are rejected without imposing a timer.
- Increased the configurable default civilian survival window from 15 to 17 ticks and bumped the engine version to 0.3.0.
- Documented the distinction between oracle-style perfect information, local room broadcast, and mention-delivered real Band rooms.
- Fixed completed replay scrubbers extending past the final tick while in-flight model calls drained, and stopped agents from starting or submitting work after the last playable tick.
- Split replay outcome markers into labelled communication-scenario rows and made the inspector show in-flight model decisions instead of presenting an old completed decision as current.
- Fixed the civilian deadline symbol in the legend to use the same circular ring shape as the map overlay.
- Increased the map size when a single team is visible so laptop replays use the available width instead of leaving a small centered board.
- Simplified replay cards by removing the internal team key, repeated per-card role icons, and redundant miniature score charts; the labelled outcome chart remains the single time-series view.
- Updated the global legend to render the current role icons, restored the orchestrator's `HQ` label, and explained role-coloured and blocked order-target lines.
- Reflowed the score components into an aligned grid, removed the duplicate total and initial-score row, added a persisted score-breakdown switch to **Panels**, and made board-only layouts use the available viewport width.
- Added a presentation-first square-surface layout: every selected team stays in one horizontal row, combined cards place equal square maps and graphs side by side, selecting fewer teams enlarges both surfaces, and hidden feeds no longer reserve layout height.

### Fairness and security

- Every world inside a match shares one seed, scenario, event schedule, engine rules, and model configuration. Peer-agent communication teams also share the same base prompt and decision loop; the separately labelled sub-agent condition intentionally replaces the peer topology with its recorded orchestrator/worker lifecycle.
- Claude and Codex use one isolated provider conversation per logical game agent. Session identity and lifetime are the same across communication conditions; only the communication transport differs.
- Codex user configuration, stored conversations, AGENTS files, MCP servers, skills, plugins, apps, shell tools, web search, and native subagents are excluded from Firebreak decisions.
- The Codex backend verifies ChatGPT authentication and removes `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` from its subprocess.
- The Claude subscription backend removes `ANTHROPIC_API_KEY` from its subprocess.
- `.env` and Band credentials remain git-ignored, and recordings redact secret-looking configuration values.

### Verification

- Added offline protocol tests for Codex dynamic game-tool calls, per-turn token accounting, persistent per-agent threads, and shutdown.
- Verified one-tick subscription smoke recordings for both Codex/GPT-5.6-Luna and Claude/Haiku without API keys.
- Verified the generated recordings by replaying their recorded orders through the deterministic engine.

## 2026-09-27

### Initial implementation

- Added the deterministic wildfire engine, seeded scenario generation, agent observations, orders, scoring, and scripted bots.
- Added SQLite recording, deterministic verification, metrics, batch reports, replay/export support, and the multi-board viewer.
- Added the Claude API and Claude subscription backends.
- Added the no-communication, perfect-information, Band, and ephemeral sub-agent team conditions.
- Added curated recordings and initial tuning/showcase results.
