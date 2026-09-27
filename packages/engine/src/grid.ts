import type { Role, TileKind, Vec, WorldState } from "./types";

export const idx = (size: number, [x, y]: Vec): number => y * size + x;
export const inBounds = (size: number, [x, y]: Vec): boolean => x >= 0 && y >= 0 && x < size && y < size;
export const eq = (a: Vec, b: Vec): boolean => a[0] === b[0] && a[1] === b[1];
/** Chebyshev distance: 8-neighbour reach, used for vision and abilities. */
export const cheb = (a: Vec, b: Vec): number => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
export const key = ([x, y]: Vec): string => `${x},${y}`;

/** 4-neighbour steps, in a fixed order so pathfinding is deterministic. */
export const DIRS: readonly Vec[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const FLAMMABLE: ReadonlySet<TileKind> = new Set<TileKind>(["grass", "forest", "house"]);

const WALKABLE: ReadonlySet<TileKind> = new Set<TileKind>([
  "grass",
  "forest",
  "road",
  "bridge",
  "firebreak",
  "ash",
  "station",
]);
/** The rescuer drives the evacuation vehicle: roads only. */
const ROAD: ReadonlySet<TileKind> = new Set<TileKind>(["road", "bridge", "station"]);

export function tileAt(state: WorldState, p: Vec): TileKind {
  return state.tiles[idx(state.size, p)]!;
}

export function canStandOn(role: Role, kind: TileKind): boolean {
  return role === "rescuer" ? ROAD.has(kind) : WALKABLE.has(kind);
}

export function burningSet(state: WorldState): Set<number> {
  return new Set(state.fires.map((f) => idx(state.size, f.pos)));
}

/**
 * BFS from `from` to the nearest tile satisfying `isGoal`, over tiles `role` can stand on
 * and that are not burning. Returns the path excluding `from`, [] if already at a goal,
 * or null if unreachable.
 */
export function findPath(
  state: WorldState,
  role: Role,
  from: Vec,
  isGoal: (p: Vec) => boolean,
  burning: Set<number> = burningSet(state),
): Vec[] | null {
  if (isGoal(from)) return [];
  const size = state.size;
  const prev = new Int32Array(size * size).fill(-1);
  const start = idx(size, from);
  prev[start] = start;
  const queue: number[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    const cx = cur % size;
    const cy = (cur - cx) / size;
    for (const [dx, dy] of DIRS) {
      const n: Vec = [cx + dx, cy + dy];
      if (!inBounds(size, n)) continue;
      const ni = idx(size, n);
      if (prev[ni] !== -1) continue;
      if (!canStandOn(role, state.tiles[ni]!) || burning.has(ni)) continue;
      prev[ni] = cur;
      if (isGoal(n)) {
        const path: Vec[] = [];
        for (let at = ni; at !== start; at = prev[at]!) path.push([at % size, Math.floor(at / size)]);
        return path.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

export function tilesWithin(size: number, center: Vec, radius: number): Vec[] {
  const out: Vec[] = [];
  for (let y = center[1] - radius; y <= center[1] + radius; y++) {
    for (let x = center[0] - radius; x <= center[0] + radius; x++) {
      if (inBounds(size, [x, y])) out.push([x, y]);
    }
  }
  return out;
}
