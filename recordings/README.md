# Recordings

Curated full matches (60 ticks × 5 s, all four teams, `claude-haiku-4-5-20251001` on the `claude-code` backend). Each file is one self-contained match: world state every tick, every order, message and LLM call (prompt and response), and the full configuration it ran with.

```bash
pnpm firebreak replay 20260927-184427-s13-mmr7.sqlite   # viewer
pnpm firebreak verify 20260927-184427-s13-mmr7.sqlite   # re-run the engine, compare every tick
pnpm firebreak report recordings/*.sqlite               # metrics across these matches
```

| File                              | Seed | Prompt | none | perfect | band | subagents |
| --------------------------------- | ---- | ------ | ---- | ------- | ---- | --------- |
| `20260927-174220-s5-5f1i.sqlite`  | 5    | v1     | −52  | −54     | −54  | 7         |
| `20260927-175122-s11-atsg.sqlite` | 11   | v2     | −80  | 17      | 12   | −50       |
| `20260927-175629-s12-xs6p.sqlite` | 12   | v2     | −1   | 49      | −34  | −9        |
| `20260927-180139-s13-tgqy.sqlite` | 13   | v2     | −52  | 7       | −47  | −50       |
| `20260927-183409-s11-319n.sqlite` | 11   | v3     | 10   | 14      | 43   | −20       |
| `20260927-183918-s12-uwwr.sqlite` | 12   | v3     | −41  | −5      | −4   | −5        |
| `20260927-184427-s13-mmr7.sqlite` | 13   | v3     | 5    | −24     | 40   | −60       |

Prompt versions differ between rows (v1 before the agent-competence fixes, v3 is current), so compare within a prompt version. See docs/TUNING.md for what changed and why. Seven matches are not enough to call a winner; larger batches go to GitHub Releases rather than this folder.

Recordings contain the full prompts and model responses, Band room and agent IDs, and OS/Node versions. No credentials: the config is redacted before it is written.
