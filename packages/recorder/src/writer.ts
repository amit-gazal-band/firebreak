import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EndFrame, MatchHeader, StreamFrame } from "@firebreak/engine";
import { SCHEMA, SCHEMA_VERSION } from "./schema";
import { DatabaseSync, type Database } from "./sqlite";

/** Anything that consumes the frame stream of a running match. */
export interface FrameSink {
  write(frame: StreamFrame): void;
}

/** Config sections stored with every recording (SPEC §8.2). */
export type ConfigSections = Record<string, unknown>;

/** Writes one match to one SQLite file as the frames arrive. */
export class RecordingWriter implements FrameSink {
  private db: Database;
  private header: MatchHeader | null = null;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  begin(header: MatchHeader, config: ConfigSections): void {
    this.header = header;
    this.db
      .prepare("INSERT INTO match (id, created_at, seed, header_json) VALUES (?, ?, ?, ?)")
      .run(header.match_id, header.created_at, header.seed, JSON.stringify(header));
    const cfg = this.db.prepare("INSERT OR REPLACE INTO match_config (section, value_json) VALUES (?, ?)");
    for (const [section, value] of Object.entries(config)) cfg.run(section, JSON.stringify(value ?? null));
    const w = this.db.prepare("INSERT INTO world (world_id, team, label) VALUES (?, ?, ?)");
    for (const t of header.teams) w.run(t.world_id, t.team, t.label);
  }

  /** Add or replace a config section after the match started (e.g. prompts built lazily). */
  setConfig(section: string, value: unknown): void {
    this.db
      .prepare("INSERT OR REPLACE INTO match_config (section, value_json) VALUES (?, ?)")
      .run(section, JSON.stringify(value));
  }

  write(f: StreamFrame): void {
    if (!this.header) throw new Error("RecordingWriter.begin() must be called first");
    const log = (kind: string, ref: string) =>
      this.db.prepare("INSERT INTO frame_log (kind, ref) VALUES (?, ?)").run(kind, ref);
    switch (f.kind) {
      case "tick":
        this.db
          .prepare(
            "INSERT OR REPLACE INTO tick_state (world_id, tick, t_ms, state_json, hash) VALUES (?, ?, ?, ?, ?)",
          )
          .run(f.world_id, f.tick, Math.round(f.t_ms), JSON.stringify(f.state), f.hash);
        log("tick", `${f.world_id}|${f.tick}`);
        break;
      case "event": {
        const r = this.db
          .prepare(
            "INSERT INTO event (world_id, t_ms, tick, type, agent_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(f.world_id, Math.round(f.t_ms), f.tick, f.type, f.agent_id ?? null, JSON.stringify(f.payload));
        log("event", String(r.lastInsertRowid));
        break;
      }
      case "message":
        this.db
          .prepare(
            "INSERT INTO message (id, world_id, t_ms, sender, recipients_json, channel, text, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            f.id,
            f.world_id,
            Math.round(f.t_ms),
            f.from,
            JSON.stringify(f.to),
            f.channel,
            f.text,
            f.meta ? JSON.stringify(f.meta) : null,
          );
        log("message", f.id);
        break;
      case "delivery":
        this.db
          .prepare(
            "INSERT OR IGNORE INTO delivery (message_id, world_id, recipient, stage, t_ms) VALUES (?, ?, ?, ?, ?)",
          )
          .run(f.message_id, f.world_id, f.recipient, f.stage, Math.round(f.t_ms));
        log("delivery", `${f.message_id}|${f.recipient}|${f.stage}`);
        break;
      case "llm":
        this.db
          .prepare(
            `INSERT INTO llm_call (id, world_id, agent_id, started_ms, ended_ms, input_tokens, output_tokens, cache_read_tokens,
             cost_usd, cost_estimated, prompt, response, tool_calls_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            f.id,
            f.world_id,
            f.agent_id,
            Math.round(f.started_ms),
            Math.round(f.ended_ms),
            f.input_tokens,
            f.output_tokens,
            f.cache_read_tokens,
            f.cost_usd,
            f.cost_estimated ? 1 : 0,
            f.prompt ?? null,
            f.response,
            JSON.stringify(f.tool_calls),
            f.error ?? null,
          );
        log("llm", f.id);
        break;
      case "end":
        this.finish(f);
        break;
    }
  }

  private finish(f: EndFrame): void {
    this.db
      .prepare("UPDATE match SET status = ?, abort_reason = ?, results_json = ? WHERE id = ?")
      .run(
        f.status,
        f.reason ?? null,
        JSON.stringify({ t_ms: f.t_ms, results: f.results }),
        this.header!.match_id,
      );
    const w = this.db.prepare("UPDATE world SET final_score = ?, cost_usd = ? WHERE world_id = ?");
    for (const r of f.results) w.run(r.score, r.cost_usd, r.world_id);
    this.db.prepare("INSERT INTO frame_log (kind, ref) VALUES ('end', '')").run();
  }

  close(): void {
    this.db.close();
  }
}
