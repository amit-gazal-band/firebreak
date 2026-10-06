import {
  formatOrder,
  type CommentaryFrame,
  type CommentarySegment,
  type DeliveryFrame,
  type EndFrame,
  type EventFrame,
  type LlmFrame,
  type MatchHeader,
  type MessageFrame,
  type StreamFrame,
  type Order,
  type TickFrame,
  type Vec,
  type WorldState,
} from "@firebreak/engine";

export interface MessageView extends MessageFrame {
  delivered: Map<string, number>;
  consumed: Map<string, number>;
}

/** Communication graph edges: "from>to" → messages (SPEC §9.1). */
export type Edges = Map<string, number>;

export const edgeKey = (from: string, to: string) => `${from}>${to}`;

export function splitEdge(key: string): [string, string] {
  const i = key.indexOf(">");
  return [key.slice(0, i), key.slice(i + 1)];
}

function addMessage(edges: Edges, m: MessageFrame): void {
  for (const r of m.to) {
    const k = edgeKey(m.from, r);
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
}

/** One line of the actions feed: a tool call, or an order outcome from the engine (SPEC §9.4). */
export interface ActionView {
  t_ms: number;
  tick: number;
  agent: string;
  kind: "call" | "done" | "blocked";
  /** The call written like code, e.g. `extinguish(5,7)`. */
  text: string;
  /** What came of it, e.g. `✓ takes effect on tick 24`, `✗ not adjacent`. Empty for scripted bots. */
  result: string;
  tone: "ok" | "error" | "dim";
  /** A communication tool whose call already shows as a message (so *All* skips it). */
  asMessage: boolean;
  /** Only in the *Actions* list: messaging calls, which *Actions* leaves to the message feed. */
  messaging: boolean;
  llm?: LlmFrame;
}

/** One change to the score, from exactly one engine event (SPEC §4.6, §9.5). */
export interface ScoreEntry {
  t_ms: number;
  tick: number;
  type: ScoreEventType;
  delta: number;
  /** Running total after this entry. */
  total: number;
  /** Agents credited (rescuer, firefighters); empty for the team's losses. */
  credit: string[];
  pos: Vec | null;
  /** e.g. `Civilian evacuated: c2 by rescuer`; starts with `SCORE_LABEL[type]`. */
  text: string;
}

export type ScoreEventType = "civilian_evacuated" | "civilian_lost" | "extinguished" | "house_destroyed";

export const SCORE_DELTA: Record<ScoreEventType, number> = {
  civilian_evacuated: 10,
  civilian_lost: -20,
  extinguished: 1,
  house_destroyed: -5,
};

/** What happened, as the board pop-ups and the score log name it (SPEC §9.5). */
export const SCORE_LABEL: Record<ScoreEventType, string> = {
  civilian_evacuated: "Civilian evacuated",
  civilian_lost: "Civilian lost",
  extinguished: "Fire put out",
  house_destroyed: "House destroyed",
};

export interface WorldTimeline {
  id: string;
  team: string;
  label: string;
  ticks: TickFrame[];
  events: EventFrame[];
  messages: MessageView[];
  llm: LlmFrame[];
  commentary: CommentaryFrame[];
  /** Tool calls and order outcomes, in time order. */
  actions: ActionView[];
  /** Bumped when an action lands before the end of the list, so feeds rebuild. */
  actionsRev: number;
  /** Every scoring event, in tick order, with running totals. */
  score: ScoreEntry[];
  /** The score at tick 0: standing houses count from the start (SPEC §4.6). */
  startScore: number;
  startHouses: number;
  /** Each agent's decisions, by `ended_ms`. */
  decisions: Map<string, LlmFrame[]>;
}

export type OutcomeMetric =
  "score" | "extinguished" | "active_fires" | "evacuated" | "lost" | "houses_standing" | "houses_destroyed";

export interface OutcomeSnapshot {
  tick: number;
  t_ms: number;
  score: number;
  extinguished: number;
  active_fires: number;
  evacuated: number;
  lost: number;
  houses_standing: number;
  houses_destroyed: number;
}

const ORDER_TOOLS = new Set([
  "move_to",
  "extinguish",
  "refill",
  "clear_debris",
  "build_firebreak",
  "rescue",
  "wait",
]);
/** Sub-agent lifecycle: messages (the brief, the report), but also actions (SPEC §9.4). */
const LIFECYCLE_TOOLS = new Set(["spawn", "finish"]);

/** A tool call written like code: `move_to(5,7)`, `rescue(c2)`, `spawn(scout)`. */
export function callText(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  if (ORDER_TOOLS.has(name)) {
    const f = formatOrder({ type: name, ...args } as Order);
    if (f && !f.includes("undefined")) return f;
  }
  if (name === "spawn") return `spawn(${String(args.body ?? "")})`;
  const short = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number")
    .map(String)
    .filter((v) => v.length <= 16)
    .slice(0, 2);
  return `${name}(${short.join(",")})`;
}

/** Turn a tool result into the short outcome shown after the call. */
export function resultText(call: string, result: string): { text: string; error: boolean } {
  if (result.startsWith("rejected")) return { text: `✗ ${result.replace(/^rejected:\s*/, "")}`, error: true };
  if (result.startsWith("accepted")) {
    let rest = result.replace(/^accepted:\s*/, "");
    if (rest.startsWith(`${call} `)) rest = rest.slice(call.length + 1);
    return { text: `✓ ${rest}`, error: false };
  }
  if (result === "ok") return { text: "✓", error: false };
  return { text: `→ ${result}`, error: false };
}

function insertSorted<T extends { t_ms: number }>(xs: T[], x: T): number {
  let i = xs.length;
  while (i > 0 && xs[i - 1]!.t_ms > x.t_ms) i--;
  xs.splice(i, 0, x);
  return i;
}

const STALE_REASONS = new Set([
  "no_fire_at_target",
  "civilian_gone",
  "no_debris_at_target",
  "not_buildable",
  "no_path",
]);

/**
 * All frames of a match, indexed for time queries. Live matches append frames as they arrive;
 * replays load them all at once. Same object either way (SPEC §8.4).
 */
export class Timeline {
  worlds = new Map<string, WorldTimeline>();
  end: EndFrame | null = null;
  lastMs = 0;
  private finalTickMs = 0;
  private messageIndex = new Map<string, MessageView>();
  private cumulative = new Map<string, { t: number; next: number; edges: Edges }>();
  version = 0;

  constructor(readonly header: MatchHeader) {
    for (const t of header.teams) {
      this.worlds.set(t.world_id, {
        id: t.world_id,
        team: t.team,
        label: t.label,
        ticks: [],
        events: [],
        messages: [],
        llm: [],
        commentary: [],
        actions: [],
        actionsRev: 0,
        score: [],
        startScore: header.scenario?.initial?.score?.total ?? 0,
        startHouses: header.scenario?.initial?.score?.houses_standing ?? 0,
        decisions: new Map(),
      });
    }
    for (const e of header.scenario?.schedule ?? [])
      if (e.type === "civilian") this.civilianPos.set(e.id, e.pos);
  }

  /** Where each civilian waits, for score pop-ups (civilian events carry only the id). */
  private civilianPos = new Map<string, Vec>();

  private addAction(w: WorldTimeline, a: ActionView): void {
    if (insertSorted(w.actions, a) < w.actions.length - 1) w.actionsRev++;
  }

  private addScore(w: WorldTimeline, f: EventFrame): void {
    const type = f.type as ScoreEventType;
    const p = f.payload;
    const by = Array.isArray(p.by) ? (p.by as string[]) : typeof p.by === "string" ? [p.by] : [];
    const pos = Array.isArray(p.pos)
      ? (p.pos as Vec)
      : typeof p.id === "string"
        ? (this.civilianPos.get(p.id) ?? null)
        : null;
    const where = pos ? ` at (${pos.join(",")})` : "";
    const detail =
      type === "civilian_evacuated"
        ? `: ${String(p.id)} by ${by.join(" + ")}`
        : type === "civilian_lost"
          ? `: ${String(p.id)} (${p.cause === "fire" ? "fire" : "deadline passed"})`
          : type === "extinguished"
            ? `${where} by ${by.join(" + ")}`
            : where;
    const text = SCORE_LABEL[type] + detail;
    const entry: ScoreEntry = {
      t_ms: f.t_ms,
      tick: f.tick,
      type,
      delta: SCORE_DELTA[type],
      total: 0,
      credit: type === "civilian_evacuated" || type === "extinguished" ? by : [],
      pos,
      text,
    };
    let i = w.score.length;
    while (i > 0 && w.score[i - 1]!.tick > entry.tick) i--;
    w.score.splice(i, 0, entry);
    for (let j = i; j < w.score.length; j++)
      w.score[j]!.total = (j ? w.score[j - 1]!.total : w.startScore) + w.score[j]!.delta;
  }

  private addEvent(w: WorldTimeline, f: EventFrame): void {
    const p = f.payload;
    if (f.type === "civilian_spawned" && typeof p.id === "string" && Array.isArray(p.pos))
      this.civilianPos.set(p.id, p.pos as Vec);
    if (f.type in SCORE_DELTA) this.addScore(w, f);
    const order = formatOrder((p.order as Order | undefined) ?? null);
    const agent = (f.agent_id ?? p.agent) as string | undefined;
    if (!agent || !order) return;
    const base = { t_ms: f.t_ms, tick: f.tick, agent, text: order, asMessage: false, messaging: false };
    if (f.type === "order_done") this.addAction(w, { ...base, kind: "done", result: "done", tone: "dim" });
    else if (f.type === "order_blocked") {
      const detail = p.detail ? `: ${String(p.detail)}` : "";
      this.addAction(w, {
        ...base,
        kind: "blocked",
        result: `⛔ ${String(p.reason)}${detail}`,
        tone: "error",
      });
    } else if (f.type === "order_issued" && w.team.startsWith("bots")) {
      // Scripted bots make no LLM calls: their orders are the actions, without results (SPEC §9.4).
      this.addAction(w, { ...base, kind: "call", result: "", tone: order === "wait()" ? "dim" : "ok" });
    }
  }

  private addLlm(w: WorldTimeline, f: LlmFrame): void {
    let list = w.decisions.get(f.agent_id);
    if (!list) w.decisions.set(f.agent_id, (list = []));
    let i = list.length;
    while (i > 0 && list[i - 1]!.ended_ms > f.ended_ms) i--;
    list.splice(i, 0, f);
    for (const c of f.tool_calls) {
      const text = callText(c.name, c.input);
      const r = resultText(text, c.result);
      const error = r.error || (c.name === "spawn" && !c.result.startsWith("spawned"));
      const order = ORDER_TOOLS.has(c.name);
      // Accepted communication calls are shown as their message; failed ones produced none.
      const asMessage = !order && !error;
      this.addAction(w, {
        t_ms: f.ended_ms,
        tick: Math.floor(f.ended_ms / this.tickMs),
        agent: f.agent_id,
        kind: "call",
        text,
        result: r.text,
        tone: error ? "error" : c.name === "wait" ? "dim" : "ok",
        asMessage,
        messaging: !order && !LIFECYCLE_TOOLS.has(c.name) && !error,
        llm: f,
      });
    }
  }

  get tickMs(): number {
    return Math.max(1, this.header.tick_ms);
  }

  add(f: StreamFrame): void {
    this.version++;
    if (f.kind === "end") {
      this.end = f;
      this.lastMs = Math.max(this.lastMs, f.t_ms);
      return;
    }
    const w = this.worlds.get(f.world_id);
    if (!w) return;
    switch (f.kind) {
      case "tick":
        w.ticks[f.tick] = f;
        this.lastMs = Math.max(this.lastMs, f.t_ms);
        this.finalTickMs = Math.max(this.finalTickMs, f.t_ms);
        break;
      case "event":
        w.events.push(f);
        this.addEvent(w, f);
        break;
      case "message": {
        const m: MessageView = { ...f, delivered: new Map(), consumed: new Map() };
        w.messages.push(m);
        this.messageIndex.set(f.id, m);
        break;
      }
      case "delivery": {
        const m = this.messageIndex.get((f as DeliveryFrame).message_id);
        if (m) (f.stage === "delivered" ? m.delivered : m.consumed).set(f.recipient, f.t_ms);
        break;
      }
      case "llm":
        w.llm.push(f);
        this.addLlm(w, f);
        break;
      case "commentary":
        w.commentary.push(f);
        break;
    }
  }

  /** Match time of the last frame (or the end frame). */
  get durationMs(): number {
    // Draining an already in-flight call after the last playable tick must not
    // create a motionless tail at the end of a completed replay.
    return this.end?.status === "completed"
      ? this.finalTickMs
      : this.end
        ? Math.max(this.end.t_ms, this.lastMs)
        : this.lastMs;
  }

  maxTick(w: WorldTimeline): number {
    return w.ticks.length - 1;
  }

  /** The tick shown at time t, plus the next one for interpolation. */
  frameAt(
    w: WorldTimeline,
    t: number,
  ): { cur: WorldState; next: WorldState | null; alpha: number; tick: number } | null {
    if (w.ticks.length === 0) return null;
    let lo = 0;
    let hi = w.ticks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const m = w.ticks[mid];
      if (m && m.t_ms <= t) lo = mid;
      else hi = mid - 1;
    }
    const cur = w.ticks[lo]!;
    const nxt = w.ticks[lo + 1];
    const alpha = nxt ? Math.min(1, Math.max(0, (t - cur.t_ms) / Math.max(1, nxt.t_ms - cur.t_ms))) : 0;
    return { cur: cur.state, next: nxt?.state ?? null, alpha, tick: lo };
  }

  tickTime(w: WorldTimeline, tick: number): number {
    const f = w.ticks[Math.max(0, Math.min(tick, w.ticks.length - 1))];
    return f ? f.t_ms : tick * this.tickMs;
  }

  /** Live counters under each board (SPEC §9), computed from frames up to time t. */
  counters(w: WorldTimeline, t: number, tick: number) {
    let cost = 0;
    let calls = 0;
    for (const c of w.llm)
      if (c.ended_ms <= t) {
        cost += c.cost_usd;
        calls++;
      }
    let stale = 0;
    for (const e of w.events) {
      if (e.t_ms > t) continue;
      if (e.type === "order_blocked" && STALE_REASONS.has(String(e.payload.reason))) stale++;
    }
    let messages = 0;
    for (const m of w.messages) if (m.t_ms <= t) messages++;
    let idle = 0;
    let joint = 0;
    for (let i = 1; i <= tick && i < w.ticks.length; i++) {
      const state = w.ticks[i]!.state;
      for (const a of state.agents) if (a.order_status !== "active") idle++;
      for (const fire of state.fires) {
        if (fire.intensity !== 3) continue;
        const assigned = state.agents.filter(
          (agent) =>
            agent.role === "firefighter" &&
            agent.order_status === "active" &&
            agent.order?.type === "extinguish" &&
            agent.order.x === fire.pos[0] &&
            agent.order.y === fire.pos[1],
        ).length;
        if (assigned < 2) joint++;
      }
    }
    return { cost, calls, stale, joint, messages, idle };
  }

  /** Mission outcomes at a replay position, read from recorded world state. */
  outcomesAt(w: WorldTimeline, t: number): OutcomeSnapshot | null {
    const frame = this.frameAt(w, t);
    if (!frame) return null;
    const { score, fires } = frame.cur;
    return {
      tick: frame.tick,
      t_ms: this.tickTime(w, frame.tick),
      score: score.total,
      extinguished: score.extinguished,
      active_fires: fires.length,
      evacuated: score.evacuated,
      lost: score.lost,
      houses_standing: score.houses_standing,
      houses_destroyed: score.houses_destroyed,
    };
  }

  /** One point per recorded tick for the multi-metric comparison chart. */
  outcomeSeries(w: WorldTimeline, metric: OutcomeMetric): { tick: number; t_ms: number; value: number }[] {
    return w.ticks.flatMap((frame) =>
      frame
        ? [
            {
              tick: frame.tick,
              t_ms: frame.t_ms,
              value:
                metric === "active_fires"
                  ? frame.state.fires.length
                  : metric === "score"
                    ? frame.state.score.total
                    : frame.state.score[metric],
            },
          ]
        : [],
    );
  }

  /** Messages to draw at time t: sent within the window, not older than `holdMs` after delivery. */
  activeMessages(w: WorldTimeline, t: number, holdMs: number): MessageView[] {
    const out: MessageView[] = [];
    for (let i = w.messages.length - 1; i >= 0; i--) {
      const m = w.messages[i]!;
      if (m.t_ms > t) continue;
      if (t - m.t_ms > holdMs * 6) break;
      const lastDelivery = Math.max(m.t_ms, ...m.delivered.values());
      if (t <= lastDelivery + holdMs) out.push(m);
    }
    return out;
  }

  /**
   * Communication graph edges at time t: messages sent up to t, one count per recipient (SPEC §9.1).
   * With `windowMs`, only messages sent in (t − windowMs, t]. The cumulative counts advance
   * incrementally while t grows and are rebuilt when t goes back (a seek).
   */
  edgesAt(w: WorldTimeline, t: number, windowMs?: number): Edges {
    if (windowMs !== undefined) {
      const edges: Edges = new Map();
      for (let i = w.messages.length - 1; i >= 0; i--) {
        const m = w.messages[i]!;
        if (m.t_ms > t) continue;
        if (m.t_ms <= t - windowMs) break;
        addMessage(edges, m);
      }
      return edges;
    }
    let c = this.cumulative.get(w.id);
    if (!c || t < c.t) {
      c = { t, next: 0, edges: new Map() };
      this.cumulative.set(w.id, c);
    }
    while (c.next < w.messages.length && w.messages[c.next]!.t_ms <= t)
      addMessage(c.edges, w.messages[c.next++]!);
    c.t = t;
    return c.edges;
  }

  /** The agent's decisions in time order (SPEC §9.4: the inspector steps through them). */
  decisionsOf(w: WorldTimeline, agent: string): LlmFrame[] {
    return w.decisions.get(agent) ?? [];
  }

  /** Index of the agent's latest decision that ended by t, or -1. */
  decisionIndexAt(w: WorldTimeline, agent: string, t: number): number {
    const xs = this.decisionsOf(w, agent);
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid]!.ended_ms <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  lastLlmCall(w: WorldTimeline, agent: string, t: number): LlmFrame | null {
    return this.decisionsOf(w, agent)[this.decisionIndexAt(w, agent, t)] ?? null;
  }

  inFlightLlmCall(w: WorldTimeline, agent: string, t: number): LlmFrame | null {
    return w.llm.find((call) => call.agent_id === agent && call.started_ms <= t && call.ended_ms > t) ?? null;
  }

  commentaryAt(w: WorldTimeline, t: number): CommentarySegment | null {
    let best: CommentarySegment | null = null;
    for (const call of w.commentary) {
      for (const segment of call.segments) {
        if (segment.t_ms <= t && (!best || segment.t_ms >= best.t_ms)) best = segment;
      }
    }
    return best;
  }

  commentaryThrough(w: WorldTimeline, t: number): CommentarySegment[] {
    return w.commentary
      .flatMap((call) => call.segments)
      .filter((segment) => segment.t_ms <= t)
      .sort((a, b) => b.t_ms - a.t_ms);
  }

  /** Scoring events up to time t. */
  scoreLogAt(w: WorldTimeline, t: number): ScoreEntry[] {
    let n = w.score.length;
    while (n > 0 && w.score[n - 1]!.t_ms > t) n--;
    return w.score.slice(0, n);
  }

  /** Points credited to each agent up to t (evacuations, extinguishes), and the team's losses (SPEC §9.5). */
  pointsAt(w: WorldTimeline, t: number) {
    const agents = new Map<string, { points: number; evacuated: number; extinguished: number }>();
    let lostCivilians = 0;
    let lostHouses = 0;
    for (const e of this.scoreLogAt(w, t)) {
      if (e.type === "civilian_lost") lostCivilians++;
      if (e.type === "house_destroyed") lostHouses++;
      for (const a of e.credit) {
        const x = agents.get(a) ?? { points: 0, evacuated: 0, extinguished: 0 };
        x.points += e.delta;
        if (e.type === "civilian_evacuated") x.evacuated++;
        else x.extinguished++;
        agents.set(a, x);
      }
    }
    return { agents, lostCivilians, lostHouses };
  }

  /** Markers retain their world so the shared scrubber can render one lane per visible team. */
  markers(): { t: number; type: string; world_id: string; global: boolean }[] {
    const notable = new Set([
      "civilian_lost",
      "civilian_evacuated",
      "house_destroyed",
      "wind_changed",
      "bridge_collapsed",
    ]);
    const out: { t: number; type: string; world_id: string; global: boolean }[] = [];
    const seenGlobal = new Set<string>();
    for (const w of this.worlds.values()) {
      for (const e of w.events) {
        if (!notable.has(e.type)) continue;
        const global = e.type === "wind_changed" || e.type === "bridge_collapsed";
        const k = `${e.type}@${e.tick}`;
        if (global && seenGlobal.has(k)) continue;
        seenGlobal.add(k);
        out.push({ t: e.t_ms, type: e.type, world_id: w.id, global });
      }
    }
    return out;
  }
}
