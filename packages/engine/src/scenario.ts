import { agentIds, mergeGameConfig } from "./config";
import { DIRS, cheb, idx, inBounds } from "./grid";
import { Rng } from "./rng";
import type {
  AgentState,
  Fire,
  GameConfig,
  Scenario,
  ScheduledEvent,
  TileKind,
  Vec,
  Wind,
  WorldState,
} from "./types";

const WINDS: Wind[] = ["N", "E", "S", "W"];

/** Build the map, the initial state and the event schedule. Depends only on seed and config. */
export function createScenario(seed: number, config: GameConfig = mergeGameConfig()): Scenario {
  const S = config.size;
  const rng = new Rng(seed, "map");
  const tiles: TileKind[] = new Array(S * S).fill("grass");
  const at = (p: Vec) => tiles[idx(S, p)]!;
  const set = (p: Vec, k: TileKind) => {
    if (inBounds(S, p)) tiles[idx(S, p)] = k;
  };

  // Forest blobs.
  const target = Math.floor(S * S * config.forest_share);
  let forest = 0;
  for (let guard = 0; forest < target && guard < 500; guard++) {
    const c: Vec = [rng.int(0, S - 1), rng.int(0, S - 1)];
    const r = rng.int(1, 3);
    for (let y = c[1] - r; y <= c[1] + r; y++) {
      for (let x = c[0] - r; x <= c[0] + r; x++) {
        if (!inBounds(S, [x, y]) || (x - c[0]) ** 2 + (y - c[1]) ** 2 > r * r + 0.5) continue;
        if (at([x, y]) !== "forest" && rng.next() < 0.85) {
          set([x, y], "forest");
          forest++;
        }
      }
    }
  }

  // River, meandering north to south, east of centre.
  const x0 = rng.int(Math.floor(S * 0.55), Math.floor(S * 0.62));
  const riverX: number[] = [];
  let rx = x0;
  for (let y = 0; y < S; y++) {
    rx = Math.max(x0 - 1, Math.min(x0 + 1, rx + rng.int(-1, 1)));
    riverX.push(rx);
    set([rx, y], "water");
  }
  const riverMin = Math.min(...riverX);
  const riverMax = Math.max(...riverX);

  // Main east-west road across the bridge.
  const by = rng.int(6, S - 7);
  for (let x = 1; x < S - 1; x++) set([x, by], at([x, by]) === "water" ? "bridge" : "road");
  const bridge: Vec = [riverX[by]!, by];

  // North-south roads: two west of the river, one east.
  const westA = rng.int(2, 4);
  const westB = rng.int(westA + 3, riverMin - 2);
  const east = rng.int(riverMax + 2, S - 3);
  for (const vx of [westA, westB, east]) {
    for (let y = 2; y < S - 2; y++) if (at([vx, y]) !== "water") set([vx, y], "road");
  }

  // Lake on the west side, off the roads.
  const lakeC: Vec = [rng.int(westA + 1, westB - 1), by + (rng.next() < 0.5 ? -3 : 3)];
  for (let y = lakeC[1] - 1; y <= lakeC[1] + 1; y++) {
    for (let x = lakeC[0] - 1; x <= lakeC[0] + 1; x++) {
      if (inBounds(S, [x, y]) && at([x, y]) !== "road") set([x, y], "water");
    }
  }

  const station: Vec = [westA, by];
  set(station, "station");

  // Houses along roads, on both sides of the river.
  const nearRoad = (p: Vec) =>
    DIRS.some(([dx, dy]) => {
      const n: Vec = [p[0] + dx, p[1] + dy];
      return inBounds(S, n) && (at(n) === "road" || at(n) === "bridge");
    });
  const houseCandidates: Vec[] = [];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p: Vec = [x, y];
      if ((at(p) === "grass" || at(p) === "forest") && nearRoad(p) && cheb(p, station) >= 3)
        houseCandidates.push(p);
    }
  }
  rng.shuffle(houseCandidates);
  const nHouses = rng.range(config.houses);
  const eastSide = (p: Vec) => p[0] > riverX[p[1]]!;
  const houses: Vec[] = [];
  const minEast = Math.min(3, Math.floor(nHouses / 3));
  for (const p of houseCandidates.filter(eastSide)) {
    if (houses.length >= minEast) break;
    if (houses.every((h) => cheb(h, p) >= 2)) houses.push(p);
  }
  for (const p of houseCandidates) {
    if (houses.length >= nHouses) break;
    if (houses.every((h) => cheb(h, p) >= 2)) houses.push(p);
  }
  for (const h of houses) set(h, "house");

  // Debris on roads (not the station, the bridge, or next to the station).
  const roadTiles: Vec[] = [];
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      if (at([x, y]) === "road" && cheb([x, y], station) >= 3) roadTiles.push([x, y]);
  rng.shuffle(roadTiles);
  const debris: Vec[] = [];
  for (const p of roadTiles) {
    if (debris.length >= config.debris) break;
    if (debris.every((d) => cheb(d, p) >= 4)) debris.push(p);
  }
  for (const d of debris) set(d, "debris");

  // Schedule.
  const srng = new Rng(seed, "schedule");
  const schedule: ScheduledEvent[] = [];
  const flammable = (p: Vec) => at(p) === "forest" || at(p) === "grass";
  const allTiles: Vec[] = [];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) allTiles.push([x, y]);
  const fireSpots = allTiles.filter((p) => flammable(p) && cheb(p, station) >= 5);
  const forestSpots = fireSpots.filter((p) => at(p) === "forest");

  const initialFires: Vec[] = [];
  const nInitial = srng.range(config.initial_fires);
  while (initialFires.length < nInitial) {
    const p = srng.pick(forestSpots.length ? forestSpots : fireSpots);
    if (initialFires.every((f) => cheb(f, p) >= 4)) initialFires.push(p);
  }

  const nExtra = srng.range(config.extra_fires);
  const lastFireTick = Math.max(6, config.ticks - 15);
  for (let i = 0; i < nExtra; i++) {
    const spots = i === 0 ? fireSpots.filter(eastSide) : fireSpots;
    schedule.push({
      tick: srng.int(5, lastFireTick),
      type: "fire",
      pos: srng.pick(spots.length ? spots : fireSpots),
    });
  }

  let wind = srng.pick(WINDS);
  const initialWind = wind;
  const nShifts = srng.range(config.wind_shifts);
  const shiftTicks = new Set<number>();
  while (shiftTicks.size < nShifts) shiftTicks.add(srng.int(config.forecast_lead + 2, config.ticks - 8));
  for (const t of [...shiftTicks].sort((a, b) => a - b)) {
    wind = srng.pick(WINDS.filter((w) => w !== wind));
    schedule.push({ tick: t, type: "wind", wind });
  }

  const roadAdjacent = (p: Vec) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n: Vec = [p[0] + dx, p[1] + dy];
        if (inBounds(S, n) && (at(n) === "road" || at(n) === "bridge")) return true;
      }
    }
    return false;
  };
  const civSpots = allTiles.filter((p) => flammable(p) && roadAdjacent(p) && cheb(p, station) >= 4);
  const nCiv = srng.range(config.civilians);
  for (let i = 0; i < nCiv; i++) {
    schedule.push({
      tick: srng.int(3, Math.max(4, config.ticks - config.civilian_deadline - 2)),
      type: "civilian",
      id: `c${i + 1}`,
      pos: srng.pick(civSpots),
    });
  }

  schedule.push({ tick: srng.int(Math.floor(config.ticks / 2), config.ticks - 10), type: "bridge_collapse" });
  schedule.sort((a, b) => a.tick - b.tick || a.type.localeCompare(b.type));

  const ids = agentIds(config.team);
  const agents: AgentState[] = config.team.map((role, i) => ({
    id: ids[i]!,
    role,
    pos: [station[0], station[1]],
    water: role === "firefighter" ? config.water_capacity : 0,
    order: null,
    order_status: "none",
    order_issued_tick: 0,
    block_reason: null,
    progress: 0,
  }));

  const fires: Fire[] = initialFires.map((pos) => ({
    pos,
    intensity: 2,
    since: 0,
    last_growth: 0,
    last_fought: -1,
    max_since: -1,
  }));

  const initial: WorldState = {
    tick: 0,
    size: S,
    tiles,
    fires,
    civilians: [],
    agents,
    wind: initialWind,
    bridge_collapsed: false,
    score: {
      evacuated: 0,
      lost: 0,
      extinguished: 0,
      houses_standing: houses.length,
      houses_destroyed: 0,
      total: houses.length * 5,
    },
    ended: false,
  };

  return { seed, config, initial, schedule, station, bridge };
}
