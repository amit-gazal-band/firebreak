# Firebreak

A live, replayable game that compares how well teams of AI agents coordinate when the only difference between them is how they communicate.

Teams of 5 AI firefighters defend identical copies of a town from spreading wildfires, side by side, on the same seed and the same clock. Every match is recorded to one SQLite file and can be replayed at any speed, verified, measured, and exported as a single HTML file.

| Team                        | How it communicates                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `band`                      | Real Band rooms through `@band-ai/sdk`: @mention exactly who needs to know, create rooms per task |
| `subagents`                 | An orchestrator with no body spawns one sub-agent per body; sub-agents only report back           |
| `none`                      | No communication (lower bound)                                                                    |
| `perfect`                   | Everyone sees everything any teammate sees, instantly (upper bound)                               |
| `bots-none`, `bots-perfect` | Scripted bots, no LLM (for development and tuning)                                                |

- [Specification](docs/SPEC.md) · [Implementation plan](docs/PLAN.md) · [Tuning notes](docs/TUNING.md)

## Setup

```bash
pnpm install
cp .env.example .env                 # only needed for llm.backend=api
cp band_agents.yaml.example band_agents.yaml   # only needed for the band team
```

Requires Node 22.13+ and pnpm. LLM teams run on your Claude subscription by default (`llm.backend: claude-code`, uses your local `claude` login); set `--set llm.backend=api` and `ANTHROPIC_API_KEY` to use the API instead.

## Run a match

```bash
# All four teams, 60 ticks × 5 s, with the live viewer at http://localhost:5173/?live
pnpm firebreak run --live

# Pick teams, seed and any config value
pnpm firebreak run --teams band,subagents --seed 7 --set ticks=30

# Scripted bots, instant (no LLM)
pnpm firebreak run --teams bots-none,bots-perfect --virtual
```

## Replay, verify, share

```bash
pnpm firebreak list                       # recordings in runs/
pnpm firebreak replay <match>             # viewer at 0.5×–10×, pause, seek, step, inspector
pnpm firebreak verify <match>             # re-run the engine from seed + recorded orders, compare every tick
pnpm firebreak export <match>             # one self-contained HTML file; opens offline
pnpm firebreak run --config-from <match>  # same configuration as an old match
```

Viewer keys: space play/pause, ←/→ step a tick, 1–5 speed, click an agent to inspect what it saw and decided.

## Recorded matches

`recordings/` has curated full matches you can replay right after cloning, e.g. `pnpm firebreak replay 20260927-184427-s13-mmr7.sqlite`. See [recordings/README.md](recordings/README.md). New matches go to `runs/` (git-ignored).

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
