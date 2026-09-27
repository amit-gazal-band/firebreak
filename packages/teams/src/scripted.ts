import { ScriptedBot, key, observe, observeUnion, type WorldEvent, type WorldState } from "@firebreak/engine";
import { MessageLog, type TeamController, type TeamFactory, type WorldHandle } from "@firebreak/runtime";

/**
 * Rule-based team, no LLM (PLAN M1-M3). `union` gives it the perfect-communication view.
 * With `announce`, bots post fake "I see a fire" messages so the viewer's message layer can be exercised.
 */
class ScriptedTeam implements TeamController {
  private world!: WorldHandle;
  private bots: ScriptedBot[] = [];
  private announced = new Set<string>();
  private log!: MessageLog;

  constructor(private opts: { union: boolean; announce: boolean }) {}

  async setup(world: WorldHandle): Promise<void> {
    this.world = world;
    this.log = new MessageLog(world);
    this.bots = world.state().agents.map((a) => new ScriptedBot(world.scenario, a.id, a.role));
  }

  onTick(state: WorldState, _events: WorldEvent[]): void {
    for (const b of this.bots) {
      const obs = this.opts.union ? observeUnion(this.world.scenario, state, b.id) : observe(this.world.scenario, state, b.id);
      const o = b.decide(obs);
      if (o) this.world.submitOrder(b.id, o);
      if (!this.opts.announce) continue;
      for (const f of observe(this.world.scenario, state, b.id).visible.fires) {
        const k = key(f.pos);
        if (this.announced.has(k)) continue;
        this.announced.add(k);
        const to = state.agents.filter((a) => a.role === "firefighter" && a.id !== b.id).map((a) => a.id);
        const { id } = this.log.sent(b.id, { to, channel: "team", text: `fire at (${f.pos}) intensity ${f.intensity}` });
        for (const r of to) {
          this.log.delivered(id, r);
          this.log.consumed(id, r);
        }
      }
    }
  }

  async idle(): Promise<void> {}
  async teardown(): Promise<void> {}
  describe() {
    return { prompts: {}, tools: {} };
  }
}

export const botsNone: TeamFactory = {
  type: "bots-none",
  label: "Bots · no comms",
  usesLlm: false,
  create: () => new ScriptedTeam({ union: false, announce: false }),
};

export const botsPerfect: TeamFactory = {
  type: "bots-perfect",
  label: "Bots · perfect info",
  usesLlm: false,
  create: () => new ScriptedTeam({ union: true, announce: true }),
};
