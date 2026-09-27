import { canStandOn, cheb, eq, key } from "./grid";
import type { Observation } from "./observe";
import type { Order, Role, Scenario, Vec } from "./types";

/**
 * Rule-based players for tests, viewer development and cheap tuning (PLAN M1).
 * They see only what their observation gives them, so a bot fed the union
 * observation plays like a "perfect communication" team.
 */
export class ScriptedBot {
  private fires = new Map<string, { pos: Vec; intensity: number }>();
  private debris = new Map<string, Vec>();
  private civilians = new Map<string, { id: string; pos: Vec; deadline_tick: number }>();
  private waypoints: Vec[];

  constructor(
    private scn: Scenario,
    readonly id: string,
    readonly role: Role,
  ) {
    this.waypoints = patrolPoints(scn, role, id);
  }

  decide(obs: Observation): Order | null {
    this.remember(obs);
    const me = obs.self;
    const current = me.order_status === "active" ? me.order : null;
    const want = this.choose(obs);
    if (!want) return null;
    const formatted = formatSimple(want);
    return formatted === current ? null : want;
  }

  private remember(obs: Observation) {
    const seenFires = new Set(obs.visible.fires.map((f) => key(f.pos)));
    const r = this.role === "scout" ? 5 : 2;
    for (const [k, f] of this.fires) {
      if (cheb(f.pos, obs.self.pos) <= r && !seenFires.has(k)) this.fires.delete(k);
    }
    for (const f of obs.visible.fires) this.fires.set(key(f.pos), f);
    const seenDebris = new Set(obs.visible.debris.map(key));
    for (const [k, d] of this.debris)
      if (cheb(d, obs.self.pos) <= r && !seenDebris.has(k)) this.debris.delete(k);
    for (const d of obs.visible.debris) this.debris.set(key(d), d);
    const seenCiv = new Set(obs.visible.civilians.map((c) => c.id));
    for (const [id, c] of this.civilians) {
      if ((cheb(c.pos, obs.self.pos) <= r && !seenCiv.has(id)) || c.deadline_tick < obs.tick)
        this.civilians.delete(id);
    }
    for (const c of obs.visible.civilians) this.civilians.set(c.id, c);
  }

  private nearest<T>(items: T[], pos: (t: T) => Vec, from: Vec): T | undefined {
    return [...items].sort(
      (a, b) => cheb(pos(a), from) - cheb(pos(b), from) || key(pos(a)).localeCompare(key(pos(b))),
    )[0];
  }

  private choose(obs: Observation): Order | null {
    const me = obs.self;
    switch (this.role) {
      case "firefighter": {
        if ((me.water ?? 0) <= 0) return { type: "refill" };
        const f = this.nearest([...this.fires.values()], (f) => f.pos, me.pos);
        if (f) return { type: "extinguish", x: f.pos[0], y: f.pos[1] };
        break;
      }
      case "engineer": {
        const d = this.nearest([...this.debris.values()], (d) => d, me.pos);
        if (d) return { type: "clear_debris", x: d[0], y: d[1] };
        break;
      }
      case "rescuer": {
        const c = this.nearest([...this.civilians.values()], (c) => c.pos, me.pos);
        if (c) return { type: "rescue", civilian_id: c.id };
        break;
      }
      case "scout":
        break;
    }
    return this.patrol(obs);
  }

  private patrol(obs: Observation): Order | null {
    if (this.waypoints.length === 0) return { type: "wait" };
    const me = obs.self;
    const cur = me.order?.startsWith("move_to") && me.order_status === "active";
    if (cur) return null;
    const i = Math.floor(obs.tick / 6 + this.waypoints.length / 2) % this.waypoints.length;
    let wp = this.waypoints[i]!;
    if (eq(wp, me.pos)) wp = this.waypoints[(i + 1) % this.waypoints.length]!;
    return { type: "move_to", x: wp[0], y: wp[1] };
  }
}

function formatSimple(o: Order): string {
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

function patrolPoints(scn: Scenario, role: Role, id: string): Vec[] {
  const S = scn.config.size;
  const want: Vec[] = [
    [3, 3],
    [S - 4, 3],
    [S - 4, S - 4],
    [3, S - 4],
    [Math.floor(S / 2), Math.floor(S / 2)],
  ];
  const shift = id.endsWith("2") ? 2 : 0;
  const pts = want.map((w) => nearestStandable(scn, role, w)).filter((p): p is Vec => p !== null);
  return [...pts.slice(shift), ...pts.slice(0, shift)];
}

function nearestStandable(scn: Scenario, role: Role, target: Vec): Vec | null {
  const S = scn.config.size;
  let best: Vec | null = null;
  let bestD = Infinity;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!canStandOn(role, scn.initial.tiles[y * S + x]!)) continue;
      const d = Math.abs(x - target[0]) + Math.abs(y - target[1]);
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best;
}
