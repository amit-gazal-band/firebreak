import type { GameConfig, Role } from "./types";

export const DEFAULT_TEAM: Role[] = ["scout", "firefighter", "firefighter", "engineer", "rescuer"];

export const DEFAULT_GAME_CONFIG: GameConfig = {
  size: 20,
  ticks: 60,
  houses: [8, 12],
  civilians: [4, 6],
  wind_shifts: [2, 3],
  initial_fires: [2, 3],
  extra_fires: [2, 4],
  debris: 3,
  forest_share: 0.35,
  fire: {
    base_spread: 0.05,
    growth_every: 5,
    burnout_ticks: 10,
    house_destroy_ticks: 3,
  },
  civilian_deadline: 17,
  forecast_lead: 6,
  water_capacity: 3,
  clear_debris_ticks: 2,
  team: DEFAULT_TEAM,
};

export interface RoleSpec {
  speed: number;
  vision: number;
  orders: readonly string[];
}

export const ROLES: Record<Role, RoleSpec> = {
  scout: { speed: 2, vision: 5, orders: ["move_to", "wait"] },
  firefighter: { speed: 1, vision: 2, orders: ["move_to", "extinguish", "refill", "wait"] },
  engineer: { speed: 1, vision: 2, orders: ["move_to", "clear_debris", "build_firebreak", "wait"] },
  rescuer: { speed: 2, vision: 2, orders: ["move_to", "rescue", "wait"] },
};

/** Agent ids by role, e.g. scout, ff1, ff2, engineer, rescuer. */
export function agentIds(team: readonly Role[]): string[] {
  const counts: Partial<Record<Role, number>> = {};
  const totals: Partial<Record<Role, number>> = {};
  for (const r of team) totals[r] = (totals[r] ?? 0) + 1;
  return team.map((r) => {
    counts[r] = (counts[r] ?? 0) + 1;
    const base = r === "firefighter" ? "ff" : r;
    return (totals[r] ?? 0) > 1 || r === "firefighter" ? `${base}${counts[r]}` : base;
  });
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K];
};

export function mergeGameConfig(overrides: DeepPartial<GameConfig> = {}): GameConfig {
  return {
    ...DEFAULT_GAME_CONFIG,
    ...overrides,
    fire: { ...DEFAULT_GAME_CONFIG.fire, ...(overrides.fire ?? {}) },
  } as GameConfig;
}
