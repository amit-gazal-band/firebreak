import { ROLES } from "./config";
import { DIRS, FLAMMABLE, burningSet, canStandOn, cheb, eq, findPath, idx, inBounds, tileAt } from "./grid";
import { roll } from "./rng";
import type {
  AgentState,
  BlockReason,
  Fire,
  Order,
  Scenario,
  StepResult,
  TileKind,
  Vec,
  Wind,
  WorldEvent,
  WorldState,
} from "./types";

const FUEL: Partial<Record<TileKind, number>> = { forest: 1.5, grass: 1.0, house: 0.7 };
const INTENSITY_SPREAD = [0, 1, 1.5, 2] as const;
const WIND_VEC: Record<Wind, Vec> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0], none: [0, 0] };

export function windFactor(wind: Wind, d: Vec): number {
  const w = WIND_VEC[wind];
  if (wind === "none") return 1;
  if (w[0] === d[0] && w[1] === d[1]) return 3;
  if (w[0] === -d[0] && w[1] === -d[1]) return 0.3;
  return 1;
}

/** Orders submitted since the last tick, keyed by agent id. Applied at the start of the next tick. */
export type OrderBatch = Record<string, Order>;

export function cloneState(s: WorldState): WorldState {
  return structuredClone(s);
}

/** The target tile an order acts on, if any. */
export function orderTarget(o: Order): Vec | null {
  switch (o.type) {
    case "move_to":
    case "extinguish":
    case "clear_debris":
    case "build_firebreak":
      return [o.x, o.y];
    default:
      return null;
  }
}

/**
 * Advance one tick (SPEC §4.4). Pure: returns a new state and the events that happened.
 */
export function step(scn: Scenario, prev: WorldState, orders: OrderBatch = {}): StepResult {
  const s = cloneState(prev);
  const cfg = scn.config;
  const events: WorldEvent[] = [];
  if (s.ended) return { state: s, events };
  s.tick += 1;
  const t = s.tick;
  const S = s.size;

  // 1. New orders replace current ones.
  for (const a of s.agents) {
    const o = orders[a.id];
    if (!o) continue;
    a.order = o;
    a.order_status = "active";
    a.order_issued_tick = t;
    a.block_reason = null;
    a.progress = 0;
  }

  const fireAt = (p: Vec): Fire | undefined => s.fires.find((f) => eq(f.pos, p));
  const block = (a: AgentState, reason: BlockReason) => {
    a.order_status = "blocked";
    a.block_reason = reason;
    events.push({ type: "order_blocked", agent: a.id, order: a.order!, reason });
  };
  const done = (a: AgentState) => {
    a.order_status = "done";
    events.push({ type: "order_done", agent: a.id, order: a.order! });
  };

  // 2. Movement: each active order moves its agent toward where it needs to be.
  const burning = burningSet(s);
  for (const a of s.agents) {
    if (a.order_status !== "active" || !a.order) continue;
    const goal = goalFor(s, a, a.order);
    if (goal === "invalid") continue; // handled in the ability phase
    const path = findPath(s, a.role, a.pos, goal, burning);
    if (path === null) {
      block(a, "no_path");
      continue;
    }
    if (path.length === 0) continue;
    const from: Vec = [a.pos[0], a.pos[1]];
    const stepTo = path[Math.min(ROLES[a.role].speed, path.length) - 1]!;
    a.pos = [stepTo[0], stepTo[1]];
    events.push({ type: "moved", agent: a.id, from, to: a.pos });
    if (a.order.type === "move_to" && eq(a.pos, [a.order.x, a.order.y])) done(a);
  }

  // 3. Abilities (only for agents that are in position).
  const extinguishers = new Map<number, AgentState[]>();
  for (const a of s.agents) {
    if (a.order_status !== "active" || !a.order) continue;
    const o = a.order;
    switch (o.type) {
      case "move_to":
        if (eq(a.pos, [o.x, o.y])) done(a);
        break;
      case "extinguish": {
        const f = fireAt([o.x, o.y]);
        if (!f) {
          block(a, "no_fire_at_target");
          break;
        }
        if (a.water <= 0) {
          block(a, "no_water");
          break;
        }
        if (cheb(a.pos, f.pos) <= 1) {
          const k = idx(S, f.pos);
          extinguishers.set(k, [...(extinguishers.get(k) ?? []), a]);
        }
        break;
      }
      case "refill":
        if (nextToWater(s, a.pos)) {
          a.water = cfg.water_capacity;
          events.push({ type: "refilled", agent: a.id });
          done(a);
        }
        break;
      case "clear_debris":
        if (tileAt(s, [o.x, o.y]) !== "debris") {
          block(a, "no_debris_at_target");
        } else if (cheb(a.pos, [o.x, o.y]) <= 1) {
          a.progress += 1;
          if (a.progress >= cfg.clear_debris_ticks) {
            s.tiles[idx(S, [o.x, o.y])] = "road";
            events.push({ type: "debris_cleared", pos: [o.x, o.y], by: a.id });
            done(a);
          }
        }
        break;
      case "build_firebreak": {
        const k = tileAt(s, [o.x, o.y]);
        if ((k !== "grass" && k !== "forest") || fireAt([o.x, o.y])) {
          block(a, "not_buildable");
        } else if (cheb(a.pos, [o.x, o.y]) <= 1) {
          s.tiles[idx(S, [o.x, o.y])] = "firebreak";
          events.push({ type: "firebreak_built", pos: [o.x, o.y], by: a.id });
          done(a);
        }
        break;
      }
      case "rescue": {
        const c = s.civilians.find((c) => c.id === o.civilian_id);
        if (!c || c.status !== "waiting") {
          block(a, "civilian_gone");
        } else if (cheb(a.pos, c.pos) <= 1) {
          c.status = "evacuated";
          s.score.evacuated += 1;
          events.push({ type: "civilian_evacuated", id: c.id, by: a.id });
          done(a);
        }
        break;
      }
      case "wait":
        break;
    }
  }

  // 3b. Extinguishing, with the joint rule for intensity-3 fires.
  const extinguishedNow: Vec[] = [];
  for (const [k, crew] of [...extinguishers.entries()].sort((a, b) => a[0] - b[0])) {
    const f = s.fires.find((f) => idx(S, f.pos) === k)!;
    if (f.intensity === 3 && crew.length < 2) {
      events.push({ type: "joint_needed", pos: f.pos, by: crew[0]!.id });
      continue;
    }
    const by = crew.map((a) => a.id);
    for (const a of crew) a.water -= 1;
    const reduction = f.intensity === 3 ? 2 : crew.length;
    const left = f.intensity - reduction;
    f.last_fought = t;
    if (left <= 0) {
      extinguishedNow.push(f.pos);
      events.push({ type: "extinguished", pos: f.pos, by });
      s.score.extinguished += 1;
      for (const a of crew) done(a);
    } else {
      f.intensity = left as 1 | 2;
      f.max_since = -1;
      events.push({ type: "fire_reduced", pos: f.pos, intensity: left, by });
    }
  }
  s.fires = s.fires.filter((f) => !extinguishedNow.some((p) => eq(p, f.pos)));
  // Agents whose water ran out on a surviving fire.
  for (const a of s.agents) {
    if (a.order_status === "active" && a.order?.type === "extinguish" && a.water <= 0) block(a, "no_water");
  }

  // 4. Fire growth.
  for (const f of s.fires) {
    if (f.intensity < 3 && t - Math.max(f.last_growth, f.last_fought) >= cfg.fire.growth_every) {
      f.intensity = (f.intensity + 1) as 2 | 3;
      f.last_growth = t;
      if (f.intensity === 3) f.max_since = t;
      events.push({ type: "fire_grew", pos: f.pos, intensity: f.intensity });
    }
  }

  // 5. Fire spread, decided with per-tile shared rolls.
  const occupied = burningSet(s);
  const newFires: Fire[] = [];
  for (const f of s.fires) {
    for (const d of DIRS) {
      const n: Vec = [f.pos[0] + d[0], f.pos[1] + d[1]];
      if (!inBounds(S, n)) continue;
      const ni = idx(S, n);
      const kind = s.tiles[ni]!;
      if (!FLAMMABLE.has(kind) || occupied.has(ni)) continue;
      const p = cfg.fire.base_spread * (FUEL[kind] ?? 0) * windFactor(s.wind, d) * INTENSITY_SPREAD[f.intensity];
      if (roll(scn.seed, t, n[0], n[1], `spread:${d[0]},${d[1]}`) < p) {
        occupied.add(ni);
        newFires.push({ pos: n, intensity: 1, since: t, last_growth: t, last_fought: -1, max_since: -1 });
        events.push({ type: "fire_started", pos: n, cause: "spread" });
      }
    }
  }
  s.fires.push(...newFires);

  // 6. Burn-out and house destruction.
  s.fires = s.fires.filter((f) => {
    const k = idx(S, f.pos);
    const isHouse = s.tiles[k] === "house";
    if (isHouse && f.max_since >= 0 && t - f.max_since >= cfg.fire.house_destroy_ticks) {
      s.tiles[k] = "ash";
      s.score.houses_destroyed += 1;
      events.push({ type: "house_destroyed", pos: f.pos });
      return false;
    }
    if (t - f.since >= cfg.fire.burnout_ticks) {
      if (isHouse) {
        s.score.houses_destroyed += 1;
        events.push({ type: "house_destroyed", pos: f.pos });
      } else {
        events.push({ type: "burned_out", pos: f.pos });
      }
      s.tiles[k] = "ash";
      return false;
    }
    return true;
  });

  // 7. Civilians.
  const burningNow = burningSet(s);
  for (const c of s.civilians) {
    if (c.status !== "waiting") continue;
    const cause = burningNow.has(idx(S, c.pos)) ? "fire" : t > c.deadline ? "deadline" : null;
    if (cause) {
      c.status = "lost";
      s.score.lost += 1;
      events.push({ type: "civilian_lost", id: c.id, cause });
    }
  }

  // 8. Scheduled events.
  for (const e of scn.schedule) {
    if (e.tick !== t) continue;
    switch (e.type) {
      case "fire":
        if (FLAMMABLE.has(tileAt(s, e.pos)) && !burningNow.has(idx(S, e.pos))) {
          s.fires.push({ pos: e.pos, intensity: 2, since: t, last_growth: t, last_fought: -1, max_since: -1 });
          burningNow.add(idx(S, e.pos));
          events.push({ type: "fire_started", pos: e.pos, cause: "scheduled" });
        }
        break;
      case "wind":
        s.wind = e.wind;
        events.push({ type: "wind_changed", wind: e.wind });
        break;
      case "civilian":
        s.civilians.push({ id: e.id, pos: e.pos, appeared: t, deadline: t + cfg.civilian_deadline, status: "waiting" });
        events.push({ type: "civilian_spawned", id: e.id, pos: e.pos });
        break;
      case "bridge_collapse":
        s.tiles[idx(S, scn.bridge)] = "water";
        s.bridge_collapsed = true;
        events.push({ type: "bridge_collapsed", pos: scn.bridge });
        break;
    }
  }

  // Agents standing on a tile that just became impassable (collapsed bridge) are moved to safety.
  for (const a of s.agents) {
    if (!canStandOn(a.role, tileAt(s, a.pos))) {
      const path = findPath(s, "scout", a.pos, (p) => canStandOn(a.role, tileAt(s, p)), new Set());
      const dest = path?.[path.length - 1];
      if (dest) a.pos = dest;
    }
  }

  // 9. Score and end.
  s.score.houses_standing = s.tiles.filter((k) => k === "house").length;
  s.score.total = 10 * s.score.evacuated - 20 * s.score.lost + s.score.extinguished + 5 * s.score.houses_standing;
  const pending = scn.schedule.some((e) => e.tick > t && (e.type === "fire" || e.type === "civilian"));
  const waiting = s.civilians.some((c) => c.status === "waiting");
  if (t >= cfg.ticks) {
    s.ended = true;
    events.push({ type: "match_ended", reason: "time" });
  } else if (s.fires.length === 0 && !waiting && !pending) {
    s.ended = true;
    events.push({ type: "match_ended", reason: "cleared" });
  }
  return { state: s, events };
}

function nextToWater(s: WorldState, p: Vec): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n: Vec = [p[0] + dx, p[1] + dy];
      if (inBounds(s.size, n) && tileAt(s, n) === "water") return true;
    }
  }
  return false;
}

/** Where an order needs its agent to stand, as a goal predicate. */
function goalFor(s: WorldState, a: AgentState, o: Order): ((p: Vec) => boolean) | "invalid" {
  switch (o.type) {
    case "move_to":
      return (p) => eq(p, [o.x, o.y]);
    case "extinguish":
    case "clear_debris":
    case "build_firebreak":
      return (p) => cheb(p, [o.x, o.y]) <= 1;
    case "refill":
      return (p) => nextToWater(s, p);
    case "rescue": {
      const c = s.civilians.find((c) => c.id === o.civilian_id);
      if (!c || c.status !== "waiting") return "invalid";
      return (p) => cheb(p, c.pos) <= 1;
    }
    case "wait":
      return "invalid";
  }
}

/**
 * Validate an order at submission time (the tool result, SPEC §6.4).
 * Returns null if accepted, or a human-readable error.
 */
export function validateOrder(s: WorldState, agentId: string, o: Order): string | null {
  const a = s.agents.find((a) => a.id === agentId);
  if (!a) return `unknown agent ${agentId}`;
  if (!ROLES[a.role].orders.includes(o.type)) return `a ${a.role} cannot ${o.type}`;
  const target = orderTarget(o);
  if (target) {
    if (!Number.isInteger(target[0]) || !Number.isInteger(target[1]) || !inBounds(s.size, target)) {
      return `(${target[0]},${target[1]}) is outside the map (0..${s.size - 1})`;
    }
  }
  if (o.type === "move_to" && !canStandOn(a.role, tileAt(s, target!))) {
    return a.role === "rescuer"
      ? `the rescuer can only drive on roads and the bridge; (${o.x},${o.y}) is ${tileAt(s, target!)}`
      : `cannot stand on (${o.x},${o.y}): it is ${tileAt(s, target!)}`;
  }
  if (o.type === "extinguish" && a.water <= 0) return "no water left; refill first";
  if (o.type === "rescue" && !s.civilians.some((c) => c.id === o.civilian_id)) return `unknown civilian ${o.civilian_id}`;
  return null;
}
