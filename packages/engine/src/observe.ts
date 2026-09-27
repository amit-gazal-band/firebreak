import { ROLES } from "./config";
import { cheb, idx, tileAt } from "./grid";
import type { AgentState, Order, OrderStatus, Role, Scenario, Vec, Wind, WorldState } from "./types";

export interface Observation {
  tick: number;
  ticks_left: number;
  self: {
    id: string;
    role: Role;
    pos: Vec;
    water?: number;
    order: string | null;
    order_status: OrderStatus;
    block_reason?: string;
  };
  wind: Wind;
  forecast?: { tick: number; wind: Wind }[];
  visible: {
    fires: { pos: Vec; intensity: number }[];
    civilians: { id: string; pos: Vec; deadline_tick: number }[];
    debris: Vec[];
    houses: { pos: Vec; state: "ok" | "burning" | "destroyed" }[];
    bridge?: "ok" | "collapsed";
    teammates: { id: string; role: Role; pos: Vec; order?: string | null }[];
  };
}

export function formatOrder(o: Order | null): string | null {
  if (!o) return null;
  switch (o.type) {
    case "refill":
    case "wait":
      return `${o.type}()`;
    case "rescue":
      return `rescue(${o.civilian_id})`;
    default:
      return `${o.type}(${o.x},${o.y})`;
  }
}

/** Tile keys (idx) visible to an agent. */
export function visibleTiles(s: WorldState, a: AgentState): Set<number> {
  const r = ROLES[a.role].vision;
  const out = new Set<number>();
  for (let y = a.pos[1] - r; y <= a.pos[1] + r; y++) {
    for (let x = a.pos[0] - r; x <= a.pos[0] + r; x++) {
      if (x >= 0 && y >= 0 && x < s.size && y < s.size) out.add(y * s.size + x);
    }
  }
  return out;
}

export function forecastFor(scn: Scenario, tick: number): { tick: number; wind: Wind }[] {
  return scn.schedule
    .filter((e) => e.type === "wind" && e.tick > tick && e.tick - tick <= scn.config.forecast_lead)
    .map((e) => ({ tick: e.tick, wind: (e as { wind: Wind }).wind }));
}

function buildObservation(
  scn: Scenario,
  s: WorldState,
  self: AgentState,
  visible: Set<number>,
  opts: { forecast: boolean; teammateOrders: boolean; allTeammates: boolean },
): Observation {
  const S = s.size;
  const seen = (p: Vec) => visible.has(idx(S, p));
  const initialHouses: Vec[] = [];
  for (let i = 0; i < scn.initial.tiles.length; i++) {
    if (scn.initial.tiles[i] === "house") initialHouses.push([i % S, Math.floor(i / S)]);
  }
  const burningKeys = new Set(s.fires.map((f) => idx(S, f.pos)));
  const debris: Vec[] = [];
  for (const k of visible) if (s.tiles[k] === "debris") debris.push([k % S, Math.floor(k / S)]);
  debris.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  const obs: Observation = {
    tick: s.tick,
    ticks_left: scn.config.ticks - s.tick,
    self: {
      id: self.id,
      role: self.role,
      pos: self.pos,
      ...(self.role === "firefighter" ? { water: self.water } : {}),
      order: formatOrder(self.order),
      order_status: self.order_status,
      ...(self.block_reason ? { block_reason: self.block_reason } : {}),
    },
    wind: s.wind,
    visible: {
      fires: s.fires.filter((f) => seen(f.pos)).map((f) => ({ pos: f.pos, intensity: f.intensity })),
      civilians: s.civilians
        .filter((c) => c.status === "waiting" && seen(c.pos))
        .map((c) => ({ id: c.id, pos: c.pos, deadline_tick: c.deadline })),
      debris,
      houses: initialHouses
        .filter(seen)
        .map((p) => ({
          pos: p,
          state: tileAt(s, p) !== "house" ? "destroyed" : burningKeys.has(idx(S, p)) ? "burning" : "ok",
        })),
      teammates: s.agents
        .filter((a) => a.id !== self.id && (opts.allTeammates || seen(a.pos)))
        .map((a) => ({
          id: a.id,
          role: a.role,
          pos: a.pos,
          ...(opts.teammateOrders ? { order: formatOrder(a.order_status === "active" ? a.order : null) } : {}),
        })),
    },
  };
  if (seen(scn.bridge)) obs.visible.bridge = s.bridge_collapsed ? "collapsed" : "ok";
  if (opts.forecast) obs.forecast = forecastFor(scn, s.tick);
  return obs;
}

/** What one agent can see on its own (SPEC §4.7). */
export function observe(scn: Scenario, s: WorldState, agentId: string): Observation {
  const self = s.agents.find((a) => a.id === agentId);
  if (!self) throw new Error(`unknown agent ${agentId}`);
  return buildObservation(scn, s, self, visibleTiles(s, self), {
    forecast: self.role === "scout",
    teammateOrders: false,
    allTeammates: false,
  });
}

/** The `perfect` team's view: the union of all teammates' vision, all orders, the forecast (SPEC §7.2). */
export function observeUnion(scn: Scenario, s: WorldState, agentId: string): Observation {
  const self = s.agents.find((a) => a.id === agentId);
  if (!self) throw new Error(`unknown agent ${agentId}`);
  const union = new Set<number>();
  for (const a of s.agents) for (const k of visibleTiles(s, a)) union.add(k);
  return buildObservation(scn, s, self, union, { forecast: true, teammateOrders: true, allTeammates: true });
}

/** The combined vision of a team, used by the viewer to draw fog of war. */
export function teamVision(s: WorldState): Set<number> {
  const union = new Set<number>();
  for (const a of s.agents) for (const k of visibleTiles(s, a)) union.add(k);
  return union;
}

/** Static map as text, one row per line, for prompts. */
export function renderMapText(scn: Scenario): string {
  const glyph: Record<string, string> = {
    grass: ".",
    forest: "T",
    house: "H",
    road: "=",
    water: "~",
    bridge: "B",
    debris: "=",
    firebreak: "#",
    ash: "_",
    station: "S",
  };
  const S = scn.config.size;
  const header = "    " + Array.from({ length: S }, (_, x) => String(x % 10)).join("");
  const rows = [header];
  for (let y = 0; y < S; y++) {
    let row = String(y).padStart(3, " ") + " ";
    for (let x = 0; x < S; x++) row += glyph[scn.initial.tiles[y * S + x]!] ?? "?";
    rows.push(row);
  }
  return rows.join("\n");
}
