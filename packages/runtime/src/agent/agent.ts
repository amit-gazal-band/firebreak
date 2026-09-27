import {
  formatOrder,
  key,
  type Observation,
  type Role,
  type WorldEvent,
  type WorldState,
} from "@firebreak/engine";
import type { LlmClient, ToolDef, ToolResult } from "../llm/types";
import type { WorldHandle } from "../team";
import type { DeliveredMessage, MessageLog } from "../transport";
import { ORDER_TOOL_NAMES, toOrder } from "./order-tools";
import { userPrompt, type PromptMessage } from "./prompts";

export interface AgentOptions {
  id: string;
  role: Role;
  world: WorldHandle;
  llm: LlmClient;
  system: string;
  tools: ToolDef[];
  observe(state: WorldState): Observation;
  /** Tools that are not orders (transport, spawn, finish...). */
  executeOther?(name: string, input: Record<string, unknown>): Promise<ToolResult>;
  /** Extra text appended to the user prompt (e.g. a sub-agent's brief). */
  extraPrompt?(): string | undefined;
  log?: MessageLog;
  /** Wake on the first tick even with nothing new (default true). */
  wakeAtStart?: boolean;
  heartbeatTicks?: number;
}

let callSeq = 0;

/**
 * The agent loop, identical for every LLM team (SPEC §6.1): wait for a wake trigger,
 * build the prompt, let the model call tools, repeat. At most one call in flight.
 */
export class LlmAgent {
  readonly id: string;
  readonly role: Role;
  private reasons = new Set<string>();
  private busy: Promise<void> | null = null;
  private stopped = false;
  private obs: Observation | null = null;
  private lastDecisionTick = -Infinity;
  private seen = {
    fires: new Set<string>(),
    civilians: new Set<string>(),
    debris: new Set<string>(),
    destroyed: new Set<string>(),
  };
  private lastWind: string | null = null;
  private forecasts = new Set<string>();
  private bridgeCollapsedSeen = false;
  private inbox: DeliveredMessage[] = [];
  private unread = 0;
  private orderLog: string[] = [];
  decisions = 0;
  private decisionsThisTick = 0;

  constructor(private o: AgentOptions) {
    this.id = o.id;
    this.role = o.role;
    if (o.wakeAtStart !== false) this.reasons.add("match started");
  }

  onTick(state: WorldState, events: WorldEvent[]): void {
    if (this.stopped) return;
    this.decisionsThisTick = 0;
    this.obs = this.o.observe(state);
    const obs = this.obs;
    for (const e of events) {
      if (e.type === "order_done" && e.agent === this.id) {
        this.reasons.add(`your order ${formatOrder(e.order)} is done`);
        this.logOrder(`t${state.tick} ${formatOrder(e.order)} → done`);
      }
      if (e.type === "order_blocked" && e.agent === this.id) {
        const why = e.detail ? `${e.reason}: ${e.detail}` : e.reason;
        this.reasons.add(`your order ${formatOrder(e.order)} is blocked (${why})`);
        this.logOrder(`t${state.tick} ${formatOrder(e.order)} → blocked: ${why}`);
      }
    }
    const v = obs.visible;
    const fresh = (set: Set<string>, k: string, label: string) => {
      if (!set.has(k)) {
        set.add(k);
        this.reasons.add(label);
      }
    };
    for (const f of v.fires) fresh(this.seen.fires, key(f.pos), `new fire seen at (${f.pos})`);
    for (const c of v.civilians) fresh(this.seen.civilians, c.id, `civilian ${c.id} seen at (${c.pos})`);
    for (const d of v.debris) fresh(this.seen.debris, key(d), `debris seen at (${d})`);
    for (const h of v.houses)
      if (h.state === "destroyed") fresh(this.seen.destroyed, key(h.pos), `house at (${h.pos}) destroyed`);
    if (v.bridge === "collapsed" && !this.bridgeCollapsedSeen) {
      this.bridgeCollapsedSeen = true;
      this.reasons.add("the bridge has collapsed");
    }
    if (this.lastWind !== null && obs.wind !== this.lastWind) this.reasons.add(`wind changed to ${obs.wind}`);
    this.lastWind = obs.wind;
    for (const f of obs.forecast ?? []) {
      const k = `${f.tick}:${f.wind}`;
      if (!this.forecasts.has(k)) {
        this.forecasts.add(k);
        this.reasons.add(`forecast: wind turns ${f.wind} at tick ${f.tick}`);
      }
    }
    // Forget sightings that are gone so they can trigger again if they reappear.
    const visibleFires = new Set(v.fires.map((f) => key(f.pos)));
    for (const k of [...this.seen.fires])
      if (!visibleFires.has(k) && this.withinSight(k)) this.seen.fires.delete(k);
    if (
      state.tick - this.lastDecisionTick >=
      (this.o.heartbeatTicks ?? this.o.world.config.agent.heartbeat_ticks)
    ) {
      this.reasons.add("heartbeat");
    }
    this.pump();
  }

  private withinSight(k: string): boolean {
    if (!this.obs) return false;
    const [x, y] = k.split(",").map(Number) as [number, number];
    const r = this.role === "scout" ? 5 : 2;
    return Math.max(Math.abs(x - this.obs.self.pos[0]), Math.abs(y - this.obs.self.pos[1])) <= r;
  }

  deliver(m: DeliveredMessage): void {
    if (this.stopped) return;
    this.inbox.push(m);
    this.unread += 1;
    this.reasons.add(`message from ${m.from}`);
    this.pump();
  }

  private logOrder(line: string) {
    this.orderLog.push(line);
    const max = this.o.world.config.agent.order_log * 2;
    if (this.orderLog.length > max) this.orderLog.splice(0, this.orderLog.length - max);
  }

  private pump(): void {
    if (this.busy || this.stopped || this.reasons.size === 0 || !this.obs || this.o.world.signal.aborted)
      return;
    // Guards against runaway loops (e.g. message ping-pong in virtual time); never reached at real LLM latency.
    if (this.decisionsThisTick >= this.o.world.config.agent.max_decisions_per_tick) return;
    this.decisionsThisTick++;
    this.busy = this.decide().finally(() => {
      this.busy = null;
      if (!this.stopped) queueMicrotask(() => this.pump());
    });
  }

  /** Resolves when no decision is in flight. */
  async idle(): Promise<void> {
    while (this.busy) await this.busy;
  }

  stop(): void {
    this.stopped = true;
  }

  private async decide(): Promise<void> {
    const w = this.o.world;
    const obs = this.obs!;
    const reasons = [...this.reasons];
    this.reasons.clear();
    this.lastDecisionTick = obs.tick;
    this.decisions += 1;

    const window = w.config.agent.message_window;
    const msgs = this.inbox.slice(-window);
    const newCount = Math.min(this.unread, msgs.length);
    for (const m of msgs.slice(msgs.length - newCount)) this.o.log?.consumed(m.id, this.id);
    this.unread = 0;
    const tickOf = (ms: number) => Math.floor(ms / Math.max(1, w.config.tick_ms));
    const promptMsgs: PromptMessage[] = msgs.map((m) => ({
      from: m.from,
      channel: m.channel,
      text: m.text,
      tick: tickOf(m.sent_ms),
      addressed: m.addressed,
    }));
    const extra = this.o.extraPrompt?.();
    const user = userPrompt({
      obs,
      reasons,
      messages: promptMsgs,
      newMessageCount: newCount,
      orderLog: this.orderLog.slice(-w.config.agent.order_log),
      ...(extra ? { extra } : {}),
    });

    w.emit({
      kind: "event",
      tick: obs.tick,
      t_ms: w.now(),
      type: "wake",
      agent_id: this.id,
      payload: { reasons },
    });
    const started = w.now();
    const id = `${w.worldId}-${this.id}-c${++callSeq}`;
    const res = await this.o.llm.decide({
      system: this.o.system,
      user,
      tools: this.o.tools,
      maxTurns: w.config.llm.max_turns_per_decision,
      signal: w.signal,
      execute: (name, input) => this.execute(name, input),
    });
    if (this.stopped && w.signal.aborted) return;
    w.budget.add(w.worldId, res.input_tokens + res.output_tokens, res.cost_usd);
    w.emit({
      kind: "llm",
      id,
      agent_id: this.id,
      started_ms: started,
      ended_ms: w.now(),
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      cache_read_tokens: res.cache_read_tokens,
      cost_usd: res.cost_usd,
      cost_estimated: res.cost_estimated,
      ...(w.config.record.prompts ? { prompt: user } : {}),
      response: res.response,
      tool_calls: res.tool_calls,
      ...(res.error ? { error: res.error } : {}),
    });
    if (res.fatal) w.abort(res.fatal === "usage_limit" ? "usage_limit" : "llm_auth_failed");
  }

  private async execute(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const w = this.o.world;
    if (ORDER_TOOL_NAMES.has(name)) {
      let order;
      try {
        order = toOrder(name, input);
      } catch (e) {
        return { text: String(e), isError: true };
      }
      const r = w.submitOrder(this.id, order);
      const t = w.state().tick;
      if (r.ok) {
        this.logOrder(`t${t} ${formatOrder(r.order)} → accepted`);
        const note = r.note ? ` (${r.note})` : "";
        return {
          text: `accepted: ${formatOrder(r.order)} takes effect on tick ${r.effective_tick}${note}`,
          isError: false,
        };
      }
      return { text: `rejected: ${r.error}`, isError: true };
    }
    if (this.o.executeOther) return this.o.executeOther(name, input);
    return { text: `unknown tool ${name}`, isError: true };
  }
}
