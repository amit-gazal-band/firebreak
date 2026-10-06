import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  DeliveryFrame,
  EndFrame,
  EventFrame,
  LlmFrame,
  MatchHeader,
  MessageFrame,
  RecordingBundle,
  StreamFrame,
  TickFrame,
} from "@firebreak/engine";
import { DatabaseSync, type Database } from "./sqlite";

type Row = Record<string, unknown>;

export interface RecordingSummary {
  file: string;
  match_id: string;
  created_at: string;
  seed: number;
  status: string;
  abort_reason: string | null;
  teams: { world_id: string; team: string; label: string; score: number | null; cost_usd: number | null }[];
}

export function openRecording(path: string): Database {
  if (!existsSync(path)) throw new Error(`recording not found: ${path}`);
  return new DatabaseSync(path, { readOnly: true });
}

export function readHeader(db: Database): MatchHeader {
  const row = db.prepare("SELECT header_json FROM match LIMIT 1").get() as Row | undefined;
  if (!row) throw new Error("recording has no match row");
  return JSON.parse(row.header_json as string) as MatchHeader;
}

export function readConfig(db: Database): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of db.prepare("SELECT section, value_json FROM match_config").all() as Row[]) {
    out[r.section as string] = JSON.parse(r.value_json as string);
  }
  return out;
}

export function summarize(path: string): RecordingSummary {
  const db = openRecording(path);
  try {
    const m = db.prepare("SELECT * FROM match LIMIT 1").get() as Row;
    const worlds = db.prepare("SELECT * FROM world ORDER BY rowid").all() as Row[];
    return {
      file: basename(path),
      match_id: m.id as string,
      created_at: m.created_at as string,
      seed: Number(m.seed),
      status: m.status as string,
      abort_reason: (m.abort_reason as string | null) ?? null,
      teams: worlds.map((w) => ({
        world_id: w.world_id as string,
        team: w.team as string,
        label: w.label as string,
        score: w.final_score === null ? null : Number(w.final_score),
        cost_usd: w.cost_usd === null ? null : Number(w.cost_usd),
      })),
    };
  } finally {
    db.close();
  }
}

export function listRecordings(dir: string): RecordingSummary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .flatMap((p) => {
      try {
        return [summarize(p)];
      } catch {
        return [];
      }
    });
}

/** Load a whole recording as the frame stream it was written as (SPEC §8.4). */
export function loadBundle(path: string, opts: { prompts?: boolean } = {}): RecordingBundle {
  const db = openRecording(path);
  try {
    const header = readHeader(db);
    const ticks = new Map<string, TickFrame>();
    for (const r of db.prepare("SELECT * FROM tick_state").all() as Row[]) {
      ticks.set(`${r.world_id}|${r.tick}`, {
        kind: "tick",
        world_id: r.world_id as string,
        tick: Number(r.tick),
        t_ms: Number(r.t_ms),
        state: JSON.parse(r.state_json as string),
        hash: r.hash as string,
      });
    }
    const events = new Map<string, EventFrame>();
    for (const r of db.prepare("SELECT * FROM event").all() as Row[]) {
      events.set(String(r.seq), {
        kind: "event",
        world_id: r.world_id as string,
        tick: Number(r.tick),
        t_ms: Number(r.t_ms),
        type: r.type as EventFrame["type"],
        ...(r.agent_id ? { agent_id: r.agent_id as string } : {}),
        payload: JSON.parse(r.payload_json as string),
      });
    }
    const messages = new Map<string, MessageFrame>();
    for (const r of db.prepare("SELECT * FROM message").all() as Row[]) {
      messages.set(r.id as string, {
        kind: "message",
        world_id: r.world_id as string,
        id: r.id as string,
        t_ms: Number(r.t_ms),
        from: r.sender as string,
        to: JSON.parse(r.recipients_json as string),
        channel: r.channel as string,
        text: r.text as string,
        ...(r.meta_json ? { meta: JSON.parse(r.meta_json as string) } : {}),
      });
    }
    const deliveries = new Map<string, DeliveryFrame>();
    for (const r of db.prepare("SELECT * FROM delivery").all() as Row[]) {
      deliveries.set(`${r.message_id}|${r.recipient}|${r.stage}`, {
        kind: "delivery",
        world_id: r.world_id as string,
        message_id: r.message_id as string,
        recipient: r.recipient as string,
        stage: r.stage as DeliveryFrame["stage"],
        t_ms: Number(r.t_ms),
      });
    }
    const llm = new Map<string, LlmFrame>();
    for (const r of db.prepare("SELECT * FROM llm_call").all() as Row[]) {
      llm.set(r.id as string, {
        kind: "llm",
        world_id: r.world_id as string,
        id: r.id as string,
        agent_id: r.agent_id as string,
        started_ms: Number(r.started_ms),
        ended_ms: Number(r.ended_ms),
        ...(r.latency_ms === null || r.latency_ms === undefined ? {} : { latency_ms: Number(r.latency_ms) }),
        input_tokens: Number(r.input_tokens),
        output_tokens: Number(r.output_tokens),
        cache_read_tokens: Number(r.cache_read_tokens),
        cost_usd: Number(r.cost_usd),
        cost_estimated: Number(r.cost_estimated) === 1,
        ...(opts.prompts && r.prompt ? { prompt: r.prompt as string } : {}),
        response: r.response as string,
        tool_calls: JSON.parse(r.tool_calls_json as string),
        ...(r.error ? { error: r.error as string } : {}),
      });
    }
    const m = db.prepare("SELECT * FROM match LIMIT 1").get() as Row;
    const frames: StreamFrame[] = [];
    for (const r of db.prepare("SELECT kind, ref FROM frame_log ORDER BY seq").all() as Row[]) {
      const ref = r.ref as string;
      const f =
        r.kind === "tick"
          ? ticks.get(ref)
          : r.kind === "event"
            ? events.get(ref)
            : r.kind === "message"
              ? messages.get(ref)
              : r.kind === "delivery"
                ? deliveries.get(ref)
                : r.kind === "llm"
                  ? llm.get(ref)
                  : r.kind === "end" && m.results_json
                    ? ({
                        kind: "end",
                        status: m.status as EndFrame["status"],
                        ...(m.abort_reason ? { reason: m.abort_reason as string } : {}),
                        ...JSON.parse(m.results_json as string),
                      } as EndFrame)
                    : undefined;
      if (f) frames.push(f);
    }
    return { header, frames };
  } finally {
    db.close();
  }
}

export function readPrompt(path: string, llmCallId: string): string | null {
  const db = openRecording(path);
  try {
    const r = db.prepare("SELECT prompt FROM llm_call WHERE id = ?").get(llmCallId) as Row | undefined;
    return (r?.prompt as string | null) ?? null;
  } finally {
    db.close();
  }
}
