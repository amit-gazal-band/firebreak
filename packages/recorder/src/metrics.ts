import type { MatchHeader, Order } from "@firebreak/engine";
import { openRecording, readHeader } from "./reader";
import type { Database } from "./sqlite";

type Row = Record<string, unknown>;

/** Per-world metrics (SPEC §10). Every number is derived from the recording alone. */
export interface WorldMetrics {
  world_id: string;
  team: string;
  label: string;
  score: number;
  /** (team − none) / (perfect − none), when both reference teams are in the match. */
  relative_score: number | null;
  cost_usd: number;
  cost_estimated: boolean;
  tokens: number;
  llm_calls: number;
  ticks_played: number;
  cleared_at_tick: number | null;
  evacuated: number;
  civilians_lost: number;
  houses_standing: number;
  extinguished: number;
  messages: number;
  latency_median_ms: number | null;
  latency_p90_ms: number | null;
  idle_agent_ticks: number;
  stale_actions: number;
  missed_joint: number;
  duplicate_work: number;
  noise_ratio: number | null;
  context_avg_tokens: number | null;
  context_max_tokens: number | null;
  orchestrator_queue_median_ms: number | null;
  forecast_shared_lead_ticks: number | null;
  rate_limited: number;
  transport_errors: number;
}

export interface MatchMetrics {
  match_id: string;
  seed: number;
  status: string;
  abort_reason: string | null;
  llm: string;
  worlds: WorldMetrics[];
}

const STALE = ["no_fire_at_target", "civilian_gone", "no_debris_at_target", "not_buildable", "no_path"];

function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (i - lo));
}

function num(db: Database, sql: string, ...params: (string | number)[]): number {
  const r = db.prepare(sql).get(...params) as Row | undefined;
  return Number(r ? (Object.values(r)[0] ?? 0) : 0);
}

function worldMetrics(db: Database, h: MatchHeader, t: MatchHeader["teams"][number]): WorldMetrics {
  const w = t.world_id;
  const last = db
    .prepare("SELECT tick, state_json FROM tick_state WHERE world_id = ? ORDER BY tick DESC LIMIT 1")
    .get(w) as Row | undefined;
  const state = last
    ? (JSON.parse(last.state_json as string) as {
        score: Record<string, number>;
        ended: boolean;
        fires: unknown[];
      })
    : null;
  const cleared = db
    .prepare(
      "SELECT tick FROM event WHERE world_id = ? AND type = 'match_ended' AND json_extract(payload_json, '$.reason') = 'cleared'",
    )
    .get(w) as Row | undefined;

  const llm = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) usd, COALESCE(SUM(input_tokens+output_tokens),0) tok, MAX(cost_estimated) est,
       AVG(input_tokens) avg_in, MAX(input_tokens) max_in FROM llm_call WHERE world_id = ?`,
    )
    .get(w) as Row;

  const lat = (
    db
      .prepare(
        `SELECT d.t_ms - m.t_ms AS l FROM delivery d JOIN message m ON m.id = d.message_id
         WHERE d.world_id = ? AND d.stage = 'consumed' AND m.channel != 'spawn'`,
      )
      .all(w) as Row[]
  ).map((r) => Number(r.l));

  // Noise: deliveries to recipients the sender did not address (only for transports that record addressing).
  const deliveries = db
    .prepare(
      `SELECT d.recipient, m.meta_json FROM delivery d JOIN message m ON m.id = d.message_id
       WHERE d.world_id = ? AND d.stage = 'delivered' AND m.meta_json IS NOT NULL`,
    )
    .all(w) as Row[];
  let addressedKnown = 0;
  let noise = 0;
  for (const d of deliveries) {
    const meta = JSON.parse(d.meta_json as string) as { addressed_to?: string[] };
    if (!meta.addressed_to) continue;
    addressedKnown++;
    if (!meta.addressed_to.includes(d.recipient as string)) noise++;
  }

  // Duplicate work: agent-ticks where two agents hold the same non-extinguish order target.
  let duplicate = 0;
  for (const r of db
    .prepare("SELECT state_json FROM tick_state WHERE world_id = ? AND tick > 0")
    .all(w) as Row[]) {
    const s = JSON.parse(r.state_json as string) as {
      agents: { order: Order | null; order_status: string }[];
    };
    const seen = new Map<string, number>();
    for (const a of s.agents) {
      if (
        a.order_status !== "active" ||
        !a.order ||
        a.order.type === "extinguish" ||
        a.order.type === "move_to" ||
        a.order.type === "wait"
      )
        continue;
      const k = JSON.stringify(a.order);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const n of seen.values()) if (n > 1) duplicate += n - 1;
  }

  const queue = (
    db
      .prepare(
        `SELECT c.t_ms - d.t_ms AS q FROM delivery d JOIN delivery c ON c.message_id = d.message_id AND c.recipient = d.recipient
         JOIN message m ON m.id = d.message_id
         WHERE d.world_id = ? AND m.channel = 'report' AND d.stage = 'delivered' AND c.stage = 'consumed'`,
      )
      .all(w) as Row[]
  ).map((r) => Number(r.q));

  // Forecast shared lead: for each wind shift, how many ticks before it a non-scout agent had read about it.
  const lead = h.scenario.config.forecast_lead;
  const shifts = h.scenario.schedule.filter((e) => e.type === "wind") as { tick: number; wind: string }[];
  const leads: number[] = [];
  if (t.team === "perfect" || t.team === "bots-perfect") {
    for (const _ of shifts) leads.push(lead);
  } else if (!t.team.startsWith("none") && t.team !== "bots-none") {
    const tickMs = Math.max(1, h.tick_ms);
    const reads = db
      .prepare(
        `SELECT c.t_ms, m.text FROM delivery c JOIN message m ON m.id = c.message_id
         WHERE c.world_id = ? AND c.stage = 'consumed' AND c.recipient != 'scout' AND c.recipient != 'orchestrator'`,
      )
      .all(w) as Row[];
    for (const sft of shifts) {
      const dir = { N: "north", E: "east", S: "south", W: "west" }[sft.wind] ?? sft.wind;
      const re = new RegExp(`wind[^.]*\\b(${sft.wind}|${dir})\\b`, "i");
      const first = reads
        .filter((r) => re.test(r.text as string))
        .map((r) => Math.floor(Number(r.t_ms) / tickMs))
        .filter((tk) => tk >= sft.tick - lead && tk <= sft.tick)
        .sort((a, b) => a - b)[0];
      leads.push(first === undefined ? 0 : sft.tick - first);
    }
  }

  return {
    world_id: w,
    team: t.team,
    label: t.label,
    score: state?.score.total ?? 0,
    relative_score: null,
    cost_usd: Number(llm.usd),
    cost_estimated: Number(llm.est ?? 0) === 1,
    tokens: Number(llm.tok),
    llm_calls: Number(llm.n),
    ticks_played: Number(last?.tick ?? 0),
    cleared_at_tick: cleared ? Number(cleared.tick) : null,
    evacuated: state?.score.evacuated ?? 0,
    civilians_lost: state?.score.lost ?? 0,
    houses_standing: state?.score.houses_standing ?? 0,
    extinguished: state?.score.extinguished ?? 0,
    messages: num(db, "SELECT COUNT(*) FROM message WHERE world_id = ? AND channel != 'spawn'", w),
    latency_median_ms: quantile(lat, 0.5),
    latency_p90_ms: quantile(lat, 0.9),
    idle_agent_ticks: num(
      db,
      `SELECT COUNT(*) FROM tick_state t, json_each(t.state_json, '$.agents') a
       WHERE t.world_id = ? AND t.tick > 0 AND json_extract(a.value, '$.order_status') != 'active'`,
      w,
    ),
    stale_actions: num(
      db,
      `SELECT COUNT(*) FROM event WHERE world_id = ? AND type = 'order_blocked' AND json_extract(payload_json, '$.reason') IN (${STALE.map(() => "?").join(",")})`,
      w,
      ...STALE,
    ),
    missed_joint: num(db, "SELECT COUNT(*) FROM event WHERE world_id = ? AND type = 'joint_needed'", w),
    duplicate_work: duplicate,
    noise_ratio: addressedKnown ? noise / addressedKnown : null,
    context_avg_tokens: llm.avg_in === null ? null : Math.round(Number(llm.avg_in)),
    context_max_tokens: llm.max_in === null ? null : Number(llm.max_in),
    orchestrator_queue_median_ms: quantile(queue, 0.5),
    forecast_shared_lead_ticks: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    rate_limited: num(db, "SELECT COUNT(*) FROM event WHERE world_id = ? AND type = 'rate_limited'", w),
    transport_errors: num(
      db,
      "SELECT COUNT(*) FROM event WHERE world_id = ? AND type = 'transport_error'",
      w,
    ),
  };
}

export function computeMetrics(path: string): MatchMetrics {
  const db = openRecording(path);
  try {
    const h = readHeader(db);
    const m = db.prepare("SELECT status, abort_reason FROM match LIMIT 1").get() as Row;
    const llmRow = db.prepare("SELECT value_json FROM match_config WHERE section = 'llm'").get() as
      Row | undefined;
    const llm = llmRow
      ? (JSON.parse(llmRow.value_json as string) as { backend?: string; model?: string })
      : {};
    const worlds = h.teams.map((t) => worldMetrics(db, h, t));
    const none = worlds.find((x) => x.team === "none" || x.team === "bots-none");
    const perfect = worlds.find((x) => x.team === "perfect" || x.team === "bots-perfect");
    if (none && perfect && perfect.score !== none.score) {
      for (const x of worlds) x.relative_score = (x.score - none.score) / (perfect.score - none.score);
    }
    return {
      match_id: h.match_id,
      seed: h.seed,
      status: m.status as string,
      abort_reason: (m.abort_reason as string | null) ?? null,
      llm: llm.backend === "none" || !llm.backend ? "none" : `${llm.backend}/${llm.model}`,
      worlds,
    };
  } finally {
    db.close();
  }
}
