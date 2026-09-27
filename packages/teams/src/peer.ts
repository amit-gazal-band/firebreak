import { observe, observeUnion, type WorldEvent, type WorldState } from "@firebreak/engine";
import {
  LlmAgent,
  MessageLog,
  jsonSchema,
  orderToolsFor,
  systemPrompt,
  type TeamController,
  type ToolDef,
  type Transport,
  type WorldHandle,
} from "@firebreak/runtime";

const NONE_COMMS =
  "You have NO way to communicate with your teammates, and they cannot reach you. You only know what you see yourself. " +
  "Your teammates are playing too; use the map and common sense to guess where help is needed.";

const PERFECT_COMMS =
  "You have no messaging tools, and you do not need them: your observation already includes everything ANY teammate can see, " +
  "every teammate's position and current order, and the scout's wind forecast, updated instantly. Coordinate by choosing orders that complement your teammates' orders.";

/**
 * Five LLM agents running the same loop (SPEC §6.1), each with its own body.
 * The only thing that varies is the transport (or the absence of one) and the view.
 */
export class PeerTeam implements TeamController {
  private agents: LlmAgent[] = [];
  private prompts: Record<string, string> = {};
  private toolDefs: Record<string, ToolDef[]> = {};

  constructor(private opts: { transport: Transport | null; view: "self" | "union" }) {}

  async setup(world: WorldHandle): Promise<void> {
    if (!world.llm) throw new Error(`team ${world.team} needs an LLM backend`);
    const llm = world.llm;
    const ids = world.state().agents.map((a) => a.id);
    const t = this.opts.transport;
    const log = new MessageLog(world);
    if (t) await t.setup(world, ids);
    for (const a of world.state().agents) {
      const comms = t ? t.promptSection(a.id) : this.opts.view === "union" ? PERFECT_COMMS : NONE_COMMS;
      const system = systemPrompt(world.scenario, a.id, a.role, comms);
      const tools = [...orderToolsFor(a.role), ...(t ? t.tools(a.id) : [])];
      this.prompts[a.id] = system;
      this.toolDefs[a.id] = tools;
      const view = this.opts.view;
      const agent = new LlmAgent({
        id: a.id,
        role: a.role,
        world,
        llm,
        system,
        tools,
        observe: (s) =>
          view === "union" ? observeUnion(world.scenario, s, a.id) : observe(world.scenario, s, a.id),
        ...(t
          ? { executeOther: (name: string, input: Record<string, unknown>) => t.call(a.id, name, input) }
          : {}),
        log,
      });
      t?.onDeliver(a.id, (m) => agent.deliver(m));
      this.agents.push(agent);
    }
  }

  onTick(state: WorldState, events: WorldEvent[]): void {
    for (const a of this.agents) a.onTick(state, events);
  }

  async idle(): Promise<void> {
    await Promise.all(this.agents.map((a) => a.idle()));
  }

  async teardown(): Promise<void> {
    for (const a of this.agents) a.stop();
    await this.opts.transport?.teardown();
  }

  describe() {
    const tools: Record<string, unknown> = {};
    for (const [id, defs] of Object.entries(this.toolDefs)) {
      tools[id] = defs.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: jsonSchema(d),
      }));
    }
    return { prompts: this.prompts, tools };
  }
}
