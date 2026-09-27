import { hash53 } from "./rng";
import type { WorldState } from "./types";

/** Stable hash of a world state, used to verify replays (SPEC §8.5). */
export function stateHash(s: WorldState): string {
  const json = JSON.stringify(s);
  return hash53(json, 1).toString(16).padStart(14, "0") + hash53(json, 2).toString(16).padStart(14, "0");
}
