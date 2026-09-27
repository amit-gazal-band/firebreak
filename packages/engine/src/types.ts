export type Vec = [x: number, y: number];

export type TileKind =
  "grass" | "forest" | "house" | "road" | "water" | "bridge" | "debris" | "firebreak" | "ash" | "station";

export type Wind = "N" | "E" | "S" | "W" | "none";

export type Role = "scout" | "firefighter" | "engineer" | "rescuer";

export type Order =
  | { type: "move_to"; x: number; y: number }
  | { type: "extinguish"; x: number; y: number }
  | { type: "refill" }
  | { type: "clear_debris"; x: number; y: number }
  | { type: "build_firebreak"; x: number; y: number }
  | { type: "rescue"; civilian_id: string }
  | { type: "wait" };

export type OrderType = Order["type"];

export type OrderStatus = "none" | "active" | "done" | "blocked";

export type BlockReason =
  | "no_path"
  | "no_water"
  | "no_fire_at_target"
  | "no_debris_at_target"
  | "not_buildable"
  | "civilian_gone"
  | "not_near_water";

export interface AgentState {
  id: string;
  role: Role;
  pos: Vec;
  water: number;
  order: Order | null;
  order_status: OrderStatus;
  order_issued_tick: number;
  block_reason: BlockReason | null;
  /** Ticks of work already spent on a multi-tick order (e.g. clear_debris). */
  progress: number;
}

export interface Fire {
  pos: Vec;
  intensity: 1 | 2 | 3;
  since: number;
  last_growth: number;
  last_fought: number;
  /** Tick at which intensity reached 3, or -1. */
  max_since: number;
}

export type CivilianStatus = "waiting" | "evacuated" | "lost";

export interface Civilian {
  id: string;
  pos: Vec;
  appeared: number;
  deadline: number;
  status: CivilianStatus;
}

export interface Score {
  evacuated: number;
  lost: number;
  extinguished: number;
  houses_standing: number;
  houses_destroyed: number;
  total: number;
}

export interface WorldState {
  tick: number;
  size: number;
  /** Row-major, index = y * size + x. */
  tiles: TileKind[];
  fires: Fire[];
  civilians: Civilian[];
  agents: AgentState[];
  wind: Wind;
  bridge_collapsed: boolean;
  score: Score;
  ended: boolean;
}

export type ScheduledEvent =
  | { tick: number; type: "fire"; pos: Vec }
  | { tick: number; type: "wind"; wind: Wind }
  | { tick: number; type: "civilian"; id: string; pos: Vec }
  | { tick: number; type: "bridge_collapse" };

/** Everything that is fixed by the seed and identical in every world. */
export interface Scenario {
  seed: number;
  config: GameConfig;
  initial: WorldState;
  schedule: ScheduledEvent[];
  station: Vec;
  bridge: Vec;
}

export interface GameConfig {
  size: number;
  ticks: number;
  houses: [number, number];
  civilians: [number, number];
  wind_shifts: [number, number];
  initial_fires: [number, number];
  extra_fires: [number, number];
  debris: number;
  forest_share: number;
  fire: {
    base_spread: number;
    growth_every: number;
    burnout_ticks: number;
    house_destroy_ticks: number;
  };
  civilian_deadline: number;
  forecast_lead: number;
  water_capacity: number;
  clear_debris_ticks: number;
  team: Role[];
}

export type WorldEvent =
  | { type: "order_done"; agent: string; order: Order }
  | { type: "order_blocked"; agent: string; order: Order; reason: BlockReason }
  | { type: "moved"; agent: string; from: Vec; to: Vec }
  | { type: "extinguished"; pos: Vec; by: string[] }
  | { type: "fire_reduced"; pos: Vec; intensity: number; by: string[] }
  | { type: "joint_needed"; pos: Vec; by: string }
  | { type: "refilled"; agent: string }
  | { type: "debris_cleared"; pos: Vec; by: string }
  | { type: "firebreak_built"; pos: Vec; by: string }
  | { type: "civilian_evacuated"; id: string; by: string }
  | { type: "civilian_lost"; id: string; cause: "fire" | "deadline" }
  | { type: "civilian_spawned"; id: string; pos: Vec }
  | { type: "fire_started"; pos: Vec; cause: "scheduled" | "spread" }
  | { type: "fire_grew"; pos: Vec; intensity: number }
  | { type: "burned_out"; pos: Vec }
  | { type: "house_destroyed"; pos: Vec }
  | { type: "wind_changed"; wind: Wind }
  | { type: "bridge_collapsed"; pos: Vec }
  | { type: "match_ended"; reason: "time" | "cleared" };

export interface StepResult {
  state: WorldState;
  events: WorldEvent[];
}
