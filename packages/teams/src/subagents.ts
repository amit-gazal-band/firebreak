import {
  key,
  observe,
  renderMapText,
  type Observation,
  type Role,
  type WorldEvent,
  type WorldState,
} from "@firebreak/engine";
import {
  LlmAgent,
  MessageLog,
  RULES_TEXT,
  jsonSchema,
  orderToolsFor,
  systemPrompt,
  type TeamController,
  type TeamFactory,
  type ToolDef,
  type ToolResult,
  type WorldHandle,
} from "@firebreak/runtime";
import { z } from "zod";

export const ORCHESTRATOR = "orchestrator";

/** Diagnostic only: crossing this age never terminates or interrupts an assignment. */
const longAssignmentThreshold = (ticks: number) => Math.max(8, Math.ceil(ticks / 4));

const SUBAGENT_COMMS = (
  lifetime: number,
) => `You are a SUB-AGENT spawned by your team's orchestrator (the commander) to control this body for one task.
- You cannot talk to anyone. You cannot receive messages. Nobody can interrupt you.
- Own the assignment across as many decisions and ticks as it needs. Observe progress, adapt after completed or blocked orders, and keep working independently.
- Your assignment includes explicit DONE WHEN criteria. Re-check them after every observation and order result. The moment every criterion is verified, call finish(completed, report) immediately; do not add extra patrols, monitoring or improvements.
- Do NOT finish merely because you issued an order or reached an arbitrary number of ticks. Call finish(blocked, report) only after you determine that the criteria are impossible and you cannot recover with your role. Explain the concrete blocker.
- Everything you saw is attached to your report automatically. Only that final report wakes the orchestrator; after you end, it may spawn a fresh sub-agent with a new brief.${
  lifetime > 0
    ? `\n- This run opted into a hard safety limit of ${lifetime} ticks. Finish and report before then when possible.`
    : "\n- There is no fixed tick limit. You remain responsible for this assignment until you report completion or blockage."
}`;

const ORCHESTRATOR_PROMPT = (map: string, lifetime: number) => `${RULES_TEXT}

MATCH CLOCK: the match length and current tick are stated in every decision. Use the remaining ticks when assigning travel and deciding which objectives can still be completed.

${map}

YOU: the ORCHESTRATOR (commander) of the team. You have no body and you cannot see the map yourself.
You only know what your sub-agents report back.

YOUR TEAM (bodies): scout (moves 2/tick, sees 5 tiles, gets the wind forecast), ff1 and ff2 (firefighters: 3 water, refill at water; intensity-3 fires need BOTH in the same tick), engineer (clears debris, builds firebreaks), rescuer (roads only, 2/tick, evacuates civilians).

HOW YOU CONTROL THE TEAM
- spawn(body, brief, done_when) starts a sub-agent that controls that body. The brief says what to do; done_when gives concrete, observable acceptance criteria (e.g. brief "go to (8,16) and put out the fire; ff2 is coming too", done_when "the fire at (8,16) is visibly gone, or the route is proven unreachable").
- A sub-agent works on its own, cannot receive messages and cannot talk to other sub-agents. It owns the assignment until it reports verified completion or an unrecoverable blockage.${
  lifetime > 0
    ? ` This run opts into a hard ${lifetime}-tick safety limit.`
    : " There is no fixed tick limit."
}
- At most one sub-agent per body at a time. A body without a sub-agent keeps doing its last order and then waits.
- Every assignment must be bounded and finishable. Never assign "stay on watch", "patrol indefinitely", "keep fighting whatever appears", or work "until the match ends". Turn coverage into one finite sweep or checklist; after its report, spawn another task if more work remains.
- Use task deadlines only when the objective itself is time-sensitive. A deadline is an acceptance criterion, not an automatic worker lifetime cap.
- You are woken when reports arrive, and every few ticks. Idle bodies waste time: keep every body on useful finite work (e.g. send firefighters to one known cluster while the scout completes one named route). Give precise briefs with coordinates and observable done_when criteria.
- Act immediately: call your tools first. Write at most one short sentence, or nothing.`;

const OPEN_ENDED_ASSIGNMENT =
  /\b(until (?:the )?match ends?|for (?:the )?rest of (?:the )?match|stay on watch|keep (?:watching|patrolling|fighting)|patrol indefinitely|ongoing patrol)\b/i;

/** Guards the sub-agent topology against assignments that can never naturally report completion. */
export function validateSubagentAssignment(brief: string, doneWhen: string): string | null {
  if (brief.trim().length < 8) return "brief must state a concrete task";
  if (doneWhen.trim().length < 12) return "done_when must state observable completion criteria";
  if (OPEN_ENDED_ASSIGNMENT.test(`${brief} ${doneWhen}`))
    return "assignment is open-ended; replace it with one finite route, target, or checklist and observable done_when criteria";
  return null;
}

interface Sightings {
  fires: Map<string, { pos: [number, number]; intensity: number; tick: number }>;
  civilians: Map<string, { id: string; pos: [number, number]; deadline_tick: number; tick: number }>;
  debris: Map<string, { pos: [number, number]; tick: number }>;
  destroyed: Set<string>;
  bridge?: string;
  forecast?: { tick: number; wind: string }[];
}

interface Live {
  body: string;
  role: Role;
  agent: LlmAgent;
  brief: string;
  doneWhen: string;
  spawned: number;
  seen: Sightings;
  finished: boolean;
}

interface Report {
  id: string;
  from: string;
  tick: number;
  text: string;
  sent_ms: number;
}

/**
 * The sub-agent team (SPEC §7.4): an orchestrator with no body spawns one sub-agent per body.
 * Sub-agents get only their brief, cannot be messaged or interrupted, and report back when done.
 */
export class SubagentTeam implements TeamController {
  private world!: WorldHandle;
  private log!: MessageLog;
  private live = new Map<string, Live>();
  /** Finished workers whose final model call is still unwinding and being recorded. */
  private retiring = new Set<LlmAgent>();
  private reports: Report[] = [];
  private unread = 0;
  private reasons = new Set<string>(["match started: all bodies are idle at the fire station"]);
  private busy: Promise<void> | null = null;
  private stopped = false;
  private lastDecisionTick = -Infinity;
  private callSeq = 0;
  private decisionsThisTick = 0;
  private state!: WorldState;
  private orchestratorSystem = "";
  private subSystems: Record<string, string> = {};
  private orchestratorTools: ToolDef[] = [];

  async setup(world: WorldHandle): Promise<void> {
    if (!world.llm) throw new Error("subagents team needs an LLM backend");
    this.world = world;
    this.log = new MessageLog(world);
    this.state = world.state();
    const lifetime = world.config.subagents.max_lifetime_ticks;
    this.orchestratorSystem = ORCHESTRATOR_PROMPT(renderMapText(world.scenario), lifetime);
    for (const a of this.state.agents)
      this.subSystems[a.id] = systemPrompt(world.scenario, a.id, a.role, SUBAGENT_COMMS(lifetime));
    this.orchestratorTools = [
      {
        name: "spawn",
        description:
          "Start a sub-agent on one bounded task. The body must be free; open-ended patrol/watch assignments are rejected.",
        schema: {
          body: z.enum(["scout", "ff1", "ff2", "engineer", "rescuer"]),
          brief: z.string().min(8).describe("one finite task, with coordinates or a bounded route/checklist"),
          done_when: z
            .string()
            .min(12)
            .describe("concrete observable criteria that prove the task completed or became impossible"),
        },
      },
      { name: "wait", description: "Do nothing until the next report.", schema: {} },
    ];
  }

  onTick(state: WorldState, events: WorldEvent[]): void {
    this.state = state;
    this.decisionsThisTick = 0;
    if (this.stopped) return;
    const lifetime = this.world.config.subagents.max_lifetime_ticks;
    for (const l of [...this.live.values()]) {
      if (l.finished) continue;
      this.recordSightings(l, observe(this.world.scenario, state, l.body));
      l.agent.onTick(state, events);
      if (lifetime > 0 && state.tick - l.spawned >= lifetime)
        this.finish(l, "blocked", `Hard ${lifetime}-tick safety limit reached before task completion.`);
    }
    const idle = state.agents.filter((a) => !this.live.has(a.id)).map((a) => a.id);
    if (state.tick - this.lastDecisionTick >= this.world.config.agent.heartbeat_ticks && idle.length) {
      this.reasons.add(`heartbeat; bodies without a sub-agent: ${idle.join(", ")}`);
    }
    this.pump();
  }

  private recordSightings(l: Live, obs: Observation) {
    const t = obs.tick;
    for (const f of obs.visible.fires)
      l.seen.fires.set(key(f.pos), { pos: f.pos, intensity: f.intensity, tick: t });
    for (const c of obs.visible.civilians) l.seen.civilians.set(c.id, { ...c, tick: t });
    for (const d of obs.visible.debris) l.seen.debris.set(key(d), { pos: d, tick: t });
    for (const h of obs.visible.houses) if (h.state === "destroyed") l.seen.destroyed.add(key(h.pos));
    if (obs.visible.bridge) l.seen.bridge = obs.visible.bridge;
    if (obs.forecast?.length) l.seen.forecast = obs.forecast;
  }

  private sightingsText(s: Sightings): string {
    const parts: string[] = [];
    if (s.fires.size)
      parts.push(
        `fires: ${[...s.fires.values()].map((f) => `(${f.pos}) i${f.intensity}@t${f.tick}`).join(" ")}`,
      );
    if (s.civilians.size)
      parts.push(
        `civilians: ${[...s.civilians.values()].map((c) => `${c.id} (${c.pos}) deadline t${c.deadline_tick}`).join(" ")}`,
      );
    if (s.debris.size) parts.push(`debris: ${[...s.debris.values()].map((d) => `(${d.pos})`).join(" ")}`);
    if (s.destroyed.size) parts.push(`destroyed houses: ${[...s.destroyed].map((k) => `(${k})`).join(" ")}`);
    if (s.bridge) parts.push(`bridge: ${s.bridge}`);
    if (s.forecast?.length)
      parts.push(`wind forecast: ${s.forecast.map((f) => `${f.wind} at t${f.tick}`).join(", ")}`);
    return parts.join("; ") || "nothing notable";
  }

  private finish(l: Live, outcome: "completed" | "blocked", text: string) {
    if (l.finished) return;
    l.finished = true;
    l.agent.stop();
    this.live.delete(l.body);
    this.retiring.add(l.agent);
    void l.agent.idle().finally(() => this.retiring.delete(l.agent));
    const ageTicks = Math.max(0, this.state.tick - l.spawned);
    const longThreshold = longAssignmentThreshold(this.world.config.ticks);
    const longRunning = ageTicks >= longThreshold;
    const full = `${outcome.toUpperCase()}: ${text.trim()} | ASSIGNMENT AGE: ${ageTicks} ticks${longRunning ? " (LONG-RUNNING)" : ""} | SEEN: ${this.sightingsText(l.seen)}`;
    const { id, t_ms } = this.log.sent(l.body, { to: [ORCHESTRATOR], channel: "report", text: full });
    this.log.delivered(id, ORCHESTRATOR);
    this.reports.push({ id, from: l.body, tick: this.state.tick, text: full, sent_ms: t_ms });
    this.unread += 1;
    this.world.emit({
      kind: "event",
      tick: this.state.tick,
      t_ms,
      type: "report",
      agent_id: l.body,
      payload: {
        text: full,
        outcome,
        spawned_tick: l.spawned,
        age_ticks: ageTicks,
        long_threshold_ticks: longThreshold,
        long_running: longRunning,
      },
    });
    this.reasons.add(`report from ${l.body}`);
    this.pump();
  }

  private spawn(body: string, brief: string, doneWhen: string): ToolResult {
    const a = this.state.agents.find((x) => x.id === body);
    if (!a) return { text: `unknown body ${body}`, isError: true };
    if (this.live.has(body))
      return {
        text: `${body} already has a live sub-agent (spawned t${this.live.get(body)!.spawned})`,
        isError: true,
      };
    const invalid = validateSubagentAssignment(brief, doneWhen);
    if (invalid) return { text: invalid, isError: true };
    const assignment = `TASK: ${brief}\nDONE WHEN: ${doneWhen}`;
    const { id } = this.log.sent(ORCHESTRATOR, { to: [body], channel: "spawn", text: assignment });
    this.log.delivered(id, body);
    const seen: Sightings = {
      fires: new Map(),
      civilians: new Map(),
      debris: new Map(),
      destroyed: new Set(),
    };
    const world = this.world;
    let consumed = false;
    const live: Live = {
      body,
      role: a.role,
      brief,
      doneWhen,
      spawned: this.state.tick,
      seen,
      finished: false,
      agent: new LlmAgent({
        id: body,
        role: a.role,
        world,
        llm: world.llm!,
        sessionId: `${world.worldId}:${body}:assignment:${id}`,
        system: this.subSystems[body]!,
        tools: [
          ...orderToolsFor(a.role),
          {
            name: "finish",
            description:
              "End this sub-agent and send its only report. Call completed immediately when DONE WHEN is verified; call blocked only when a concrete obstacle makes it impossible.",
            schema: {
              outcome: z.enum(["completed", "blocked"]),
              report: z.string().describe("what was achieved or why it is impossible, plus useful findings"),
            },
          },
        ],
        observe: (s) => observe(world.scenario, s, body),
        extraPrompt: () => {
          if (!consumed) {
            consumed = true;
            this.log.consumed(id, body);
          }
          return [
            `YOUR ASSIGNMENT from the orchestrator (spawned at tick ${live.spawned}): ${brief}`,
            `DONE WHEN (verify these acceptance criteria): ${live.doneWhen}`,
            `ACCUMULATED SIGHTINGS during this assignment: ${this.sightingsText(live.seen)}`,
            "Re-check DONE WHEN now. If it is satisfied, call finish(completed, report) immediately. Otherwise keep ownership and make the next action that directly advances it. Call finish(blocked, report) only for a concrete unrecoverable obstacle.",
          ].join("\n");
        },
        executeOther: async (name, input) => {
          if (name !== "finish") return { text: `unknown tool ${name}`, isError: true };
          const outcome = input.outcome === "blocked" ? "blocked" : "completed";
          queueMicrotask(() => this.finish(live, outcome, String(input.report ?? "")));
          return { text: "report sent; this sub-agent ends now", isError: false };
        },
      }),
    };
    this.live.set(body, live);
    this.world.emit({
      kind: "event",
      tick: this.state.tick,
      t_ms: this.world.now(),
      type: "spawn",
      agent_id: body,
      payload: { brief, done_when: doneWhen },
    });
    this.recordSightings(live, observe(world.scenario, this.state, body));
    live.agent.onTick(this.state, []);
    return { text: `spawned a sub-agent for ${body}`, isError: false };
  }

  private pump(): void {
    if (this.busy || this.stopped || this.reasons.size === 0 || this.world.signal.aborted) return;
    if (this.decisionsThisTick >= this.world.config.agent.max_decisions_per_tick) return;
    this.decisionsThisTick++;
    this.busy = this.decide().finally(() => {
      this.busy = null;
      if (!this.stopped) queueMicrotask(() => this.pump());
    });
  }

  private async decide(): Promise<void> {
    const w = this.world;
    const reasons = [...this.reasons];
    this.reasons.clear();
    const s = this.state;
    this.lastDecisionTick = s.tick;
    const window = w.config.agent.message_window;
    const recent = w.llm!.retainsSessionContext
      ? this.reports.slice(Math.max(0, this.reports.length - this.unread))
      : this.reports.slice(-window);
    const newCount = Math.min(this.unread, recent.length);
    for (const r of recent.slice(recent.length - newCount)) this.log.consumed(r.id, ORCHESTRATOR);
    this.unread = 0;
    const bodies = s.agents.map((a) => {
      const l = this.live.get(a.id);
      const age = l ? s.tick - l.spawned : 0;
      const longThreshold = longAssignmentThreshold(w.config.ticks);
      return l
        ? `- ${a.id} (${a.role}): sub-agent running since t${l.spawned} (${age} ticks old${age >= longThreshold ? "; LONG-RUNNING diagnostic—do not interrupt it" : ""}), brief: "${l.brief}", done when: "${l.doneWhen}"`
        : `- ${a.id} (${a.role}): NO sub-agent (idle or finishing its last order)`;
    });
    const user = [
      `TICK ${s.tick} (${w.config.ticks - s.tick} ticks left). Woken because: ${reasons.join("; ")}.`,
      `Current wind (everyone can feel it): ${s.wind}.`,
      "",
      "BODIES:",
      ...bodies,
      "",
      recent.length ? `REPORTS (oldest first; the last ${newCount} are new):` : "No reports yet.",
      ...recent.map((r) => `[t${r.tick}] ${r.from}: ${r.text}`),
      "",
      "Decide now.",
    ].join("\n");
    w.emit({
      kind: "event",
      tick: s.tick,
      t_ms: w.now(),
      type: "wake",
      agent_id: ORCHESTRATOR,
      payload: { reasons },
    });
    const started = w.now();
    const wallStarted = performance.now();
    const decisionSystem = this.orchestratorSystem;
    const res = await w.llm!.decide({
      session_id: `${w.worldId}:${ORCHESTRATOR}`,
      system: decisionSystem,
      user,
      tools: this.orchestratorTools,
      maxTurns: w.config.llm.max_turns_per_decision,
      signal: w.signal,
      execute: async (name, input) =>
        name === "spawn"
          ? this.spawn(String(input.body), String(input.brief ?? ""), String(input.done_when ?? ""))
          : name === "wait"
            ? { text: "ok", isError: false }
            : { text: `unknown tool ${name}`, isError: true },
    });
    w.budget.add(w.worldId, res.input_tokens + res.output_tokens, res.cost_usd);
    w.emit({
      kind: "llm",
      id: `${w.worldId}-${ORCHESTRATOR}-c${++this.callSeq}`,
      agent_id: ORCHESTRATOR,
      started_ms: started,
      ended_ms: w.now(),
      latency_ms: performance.now() - wallStarted,
      input_tokens: res.input_tokens,
      output_tokens: res.output_tokens,
      cache_read_tokens: res.cache_read_tokens,
      cost_usd: res.cost_usd,
      cost_estimated: res.cost_estimated,
      ...(w.config.record.prompts ? { prompt: `SYSTEM\n${decisionSystem}\n\nUSER\n${user}` } : {}),
      response: res.response,
      tool_calls: res.tool_calls,
      ...(res.error ? { error: res.error } : {}),
    });
    if (res.fatal) w.abort(res.fatal === "usage_limit" ? "usage_limit" : "llm_auth_failed");
  }

  async idle(): Promise<void> {
    for (;;) {
      while (this.busy) await this.busy;
      await Promise.all([
        ...[...this.live.values()].map((l) => l.agent.idle()),
        ...[...this.retiring].map((agent) => agent.idle()),
      ]);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      if (
        !this.busy &&
        [...this.live.values()].every((l) => l.agent.isIdle()) &&
        [...this.retiring].every((agent) => agent.isIdle())
      )
        return;
    }
  }

  async teardown(): Promise<void> {
    this.stopped = true;
    for (const l of this.live.values()) l.agent.stop();
    for (const agent of this.retiring) agent.stop();
  }

  describe() {
    return {
      prompts: { [ORCHESTRATOR]: this.orchestratorSystem, ...this.subSystems },
      tools: {
        [ORCHESTRATOR]: this.orchestratorTools.map((d) => ({
          name: d.name,
          description: d.description,
          input_schema: jsonSchema(d),
        })),
      },
    };
  }
}

export const subagents: TeamFactory = {
  type: "subagents",
  label: "Sub-agents",
  usesLlm: true,
  create: () => new SubagentTeam(),
};
