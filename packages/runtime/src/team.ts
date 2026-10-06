import type { Order, Scenario, StreamFrame, WorldEvent, WorldState } from "@firebreak/engine";
import type { Budget } from "./budget";
import type { MatchConfig } from "./config";
import type { LlmClient } from "./llm/types";

export type OrderResult =
  { ok: true; effective_tick: number; order: Order; note?: string } | { ok: false; error: string };

/** What a team controller gets to interact with its world. */
export interface WorldHandle {
  readonly worldId: string;
  readonly team: string;
  readonly scenario: Scenario;
  readonly config: MatchConfig;
  readonly budget: Budget;
  readonly signal: AbortSignal;
  /** Null when the team uses no LLM (scripted bots). */
  readonly llm: LlmClient | null;
  state(): WorldState;
  /** Match time in ms. */
  now(): number;
  /** Queue an order for the next tick (SPEC §4.3). Validated immediately (SPEC §6.4). */
  submitOrder(agentId: string, order: Order): OrderResult;
  /** Record a frame for this world (world_id is filled in). */
  emit(frame: DistributiveOmit<StreamFrame, "world_id">): void;
  /** Abort the whole match, e.g. on a usage limit. */
  abort(reason: string): void;
}

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface TeamController {
  /** Connect to external services (rooms, bots). Runs before the match clock starts. */
  setup(world: WorldHandle): Promise<void>;
  /** Called after every tick, including tick 0, with the events of that tick. */
  onTick(state: WorldState, events: WorldEvent[]): void;
  /** Resolves when no decision, delivery, report, or newly triggered cascade is in flight. */
  idle(): Promise<void>;
  /** Stop agents and clean up external resources. */
  teardown(): Promise<void>;
  /** Prompts and tool definitions this team uses, recorded with the match (SPEC §8.2). */
  describe(): { prompts: Record<string, string>; tools: Record<string, unknown> };
}

export interface TeamFactory {
  /** Short team type, e.g. "band". */
  readonly type: string;
  readonly label: string;
  readonly usesLlm: boolean;
  create(): TeamController;
}
