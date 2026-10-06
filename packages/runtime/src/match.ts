import {
  ENGINE_VERSION,
  createScenario,
  stateHash,
  step,
  normalizeOrder,
  validateOrder,
  type EndFrame,
  type MatchHeader,
  type Order,
  type Scenario,
  type StreamFrame,
  type WorldEvent,
  type WorldState,
} from "@firebreak/engine";
import type { ConfigSections, FrameSink } from "@firebreak/recorder";
import { Budget } from "./budget";
import { RealClock, VirtualClock, type Clock } from "./clock";
import { toGameConfig, type MatchConfig } from "./config";
import type { LlmClient } from "./llm/types";
import type { DistributiveOmit, TeamController, TeamFactory, WorldHandle } from "./team";
import { PROMPT_VERSION } from "./agent/prompts";

export interface MatchOptions {
  matchId: string;
  config: MatchConfig;
  teams: TeamFactory[];
  sinks: FrameSink[];
  /** Config sections recorded with the match (SPEC §8.2); prompts/tools are added by the runner. */
  configSections: ConfigSections;
  /** Called after the header is written, so sinks can record extra sections. */
  onConfigSection?(section: string, value: unknown): void;
  llm: LlmClient | null;
  /** @deprecated Compatibility override. Prefer config.clock.mode. */
  virtualTime?: boolean;
  log?(line: string): void;
}

interface World {
  id: string;
  factory: TeamFactory;
  controller: TeamController;
  state: WorldState;
  pending: Record<string, Order>;
}

export interface MatchResult {
  status: "completed" | "aborted";
  reason?: string;
  results: EndFrame["results"];
}

export function worldIdFor(index: number, team: string): string {
  return `w${index + 1}-${team}`;
}

/** Runs N worlds of one scenario on one clock, one team per world (SPEC §3, §4.4). */
export class MatchRunner {
  readonly scenario: Scenario;
  private clock: Clock;
  private ac = new AbortController();
  private abortReason: string | null = null;
  private worlds: World[] = [];
  private acceptingOrders = true;
  private readonly synchronizedTicks: boolean;
  readonly budget: Budget;

  constructor(private o: MatchOptions) {
    this.scenario = createScenario(o.config.seed, toGameConfig(o.config));
    this.synchronizedTicks = o.virtualTime ?? o.config.clock.mode === "synchronized";
    this.clock = this.synchronizedTicks ? new VirtualClock() : new RealClock();
    this.budget = new Budget(o.config.budget.usd, o.config.budget.tokens, (r) => this.abort(r));
  }

  abort(reason: string): void {
    if (this.ac.signal.aborted) return;
    this.abortReason = reason;
    this.o.log?.(`match aborted: ${reason}`);
    this.ac.abort();
  }

  private ended = false;

  private emit(frame: StreamFrame): void {
    if (this.ended) return;
    if (frame.kind === "end") this.ended = true;
    for (const s of this.o.sinks) s.write(frame);
  }

  header(): MatchHeader {
    return {
      match_id: this.o.matchId,
      created_at: new Date().toISOString(),
      seed: this.o.config.seed,
      tick_ms: this.o.config.tick_ms,
      ticks: this.o.config.ticks,
      teams: this.o.teams.map((t, i) => ({ world_id: worldIdFor(i, t.type), team: t.type, label: t.label })),
      scenario: this.scenario,
      config: {
        ...this.o.configSections,
        engine_version: ENGINE_VERSION,
        prompt_version: PROMPT_VERSION,
      },
    };
  }

  private handle(w: World): WorldHandle {
    const emit = (f: StreamFrame) => this.emit(f);
    const now = () => this.clock.now();
    const canAcceptOrders = () => this.acceptingOrders;
    return {
      worldId: w.id,
      team: w.factory.type,
      scenario: this.scenario,
      config: this.o.config,
      budget: this.budget,
      signal: this.ac.signal,
      llm: w.factory.usesLlm ? this.o.llm : null,
      state: () => w.state,
      now,
      submitOrder(agentId, order) {
        if (!canAcceptOrders() || w.state.ended) return { ok: false, error: "the match is over" };
        const norm = normalizeOrder(w.state, agentId, order);
        order = norm.order;
        const err = validateOrder(w.state, agentId, order);
        const base = {
          kind: "event" as const,
          world_id: w.id,
          tick: w.state.tick,
          t_ms: now(),
          agent_id: agentId,
        };
        if (err) {
          emit({ ...base, type: "order_rejected", payload: { order, error: err } });
          return { ok: false, error: err };
        }
        // Recorded orders are what `verify` replays (SPEC §8.5).
        emit({ ...base, type: "order_issued", payload: { order } });
        w.pending[agentId] = order;
        return {
          ok: true,
          effective_tick: w.state.tick + 1,
          order,
          ...(norm.note ? { note: norm.note } : {}),
        };
      },
      emit(frame: DistributiveOmit<StreamFrame, "world_id">) {
        emit({ ...frame, world_id: w.id } as StreamFrame);
      },
      abort: (reason) => this.abort(reason),
    };
  }

  private frameEvents(w: World, tick: number, t_ms: number, events: WorldEvent[]) {
    for (const e of events) {
      if (e.type === "moved") continue; // positions are in the tick state
      const { type, ...payload } = e;
      const agent = "agent" in e ? e.agent : "by" in e && typeof e.by === "string" ? e.by : undefined;
      this.emit({
        kind: "event",
        world_id: w.id,
        tick,
        t_ms,
        type,
        ...(agent ? { agent_id: agent } : {}),
        payload,
      });
    }
  }

  async run(): Promise<MatchResult> {
    const cfg = this.o.config;
    this.worlds = this.o.teams.map((f, i) => ({
      id: worldIdFor(i, f.type),
      factory: f,
      controller: f.create(),
      state: this.scenario.initial,
      pending: {},
    }));

    // Setup happens before the clock starts (Band rooms, bots...).
    for (const w of this.worlds) {
      this.o.log?.(`setting up ${w.id}`);
      await w.controller.setup(this.handle(w));
    }
    const prompts: Record<string, unknown> = {};
    const tools: Record<string, unknown> = {};
    for (const w of this.worlds) {
      const d = w.controller.describe();
      prompts[w.id] = d.prompts;
      tools[w.id] = d.tools;
    }
    this.o.onConfigSection?.("prompts", prompts);
    this.o.onConfigSection?.("tools", tools);

    this.clock = this.synchronizedTicks ? new VirtualClock() : new RealClock();
    for (const w of this.worlds) {
      this.emit({ kind: "tick", world_id: w.id, tick: 0, t_ms: 0, state: w.state, hash: stateHash(w.state) });
    }
    for (const w of this.worlds) w.controller.onTick(w.state, []);

    const tickMs = cfg.tick_ms;
    for (let tick = 1; tick <= cfg.ticks && !this.ac.signal.aborted; tick++) {
      if (this.synchronizedTicks) await this.waitForDecisionBarrier();
      await this.clock.until(tick * tickMs, this.ac.signal);
      if (this.ac.signal.aborted) break;
      const t_ms = this.synchronizedTicks ? tick * tickMs : this.clock.now();
      const stepped: [World, WorldEvent[]][] = [];
      for (const w of this.worlds) {
        if (w.state.ended) continue;
        const orders = w.pending;
        w.pending = {};
        const r = step(this.scenario, w.state, orders);
        w.state = r.state;
        this.emit({ kind: "tick", world_id: w.id, tick, t_ms, state: w.state, hash: stateHash(w.state) });
        this.frameEvents(w, tick, t_ms, r.events);
        stepped.push([w, r.events]);
      }
      if (tick % 10 === 0) {
        this.o.log?.(
          `tick ${tick}: ` +
            this.worlds.map((w) => `${w.factory.type} ${w.state.score.total}`).join(" | ") +
            ` · $${this.budget.usd.toFixed(3)}`,
        );
      }
      const finished = tick >= cfg.ticks || this.worlds.every((w) => w.state.ended);
      if (finished) {
        this.acceptingOrders = false;
        break;
      }
      for (const [w, events] of stepped) w.controller.onTick(w.state, events);
    }

    this.acceptingOrders = false;

    // Stop new decisions, let in-flight ones finish so they are recorded, then clean up.
    for (const w of this.worlds) {
      try {
        await w.controller.teardown();
      } catch (e) {
        this.o.log?.(`teardown ${w.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    await Promise.race([
      Promise.all(this.worlds.map((w) => w.controller.idle())),
      new Promise((r) => setTimeout(r, 30_000)),
    ]);
    const aborted = this.ac.signal.aborted;
    const results = this.worlds.map((w) => ({
      world_id: w.id,
      team: w.factory.type,
      score: w.state.score.total,
      cost_usd: this.budget.world(w.id).usd,
    }));
    if (aborted) {
      this.emit({
        kind: "event",
        world_id: this.worlds[0]?.id ?? "",
        tick: this.worlds[0]?.state.tick ?? 0,
        t_ms: this.clock.now(),
        type: "match_aborted",
        payload: { reason: this.abortReason },
      });
    }
    const end: EndFrame = {
      kind: "end",
      t_ms: this.clock.now(),
      status: aborted ? "aborted" : "completed",
      ...(aborted && this.abortReason ? { reason: this.abortReason } : {}),
      results,
    };
    this.emit(end);
    return { status: end.status, ...(end.reason ? { reason: end.reason } : {}), results };
  }

  /**
   * A synchronized tick closes only after every decision and any message/report work it
   * triggered has settled. Controllers own the transport-specific cascade draining.
   */
  private async waitForDecisionBarrier(): Promise<void> {
    await Promise.all(this.worlds.map((w) => w.controller.idle()));
  }
}
