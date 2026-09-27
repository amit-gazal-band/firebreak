import { createScenario, stateHash, step, type EventFrame, type Order, type TickFrame } from "@firebreak/engine";
import { loadBundle } from "@firebreak/recorder";

export interface VerifyResult {
  ok: boolean;
  worlds: { world_id: string; ticks: number; mismatch_tick: number | null }[];
  scenario_ok: boolean;
}

/**
 * Re-run the engine from the seed and the recorded orders and compare every tick hash (SPEC §8.5).
 * Orders are applied on the tick after they were issued: an order_issued event at tick t
 * (recorded while the world was at t) takes effect in step t -> t+1. The last one per agent wins.
 */
export function verifyRecording(path: string): VerifyResult {
  const { header, frames } = loadBundle(path);
  const scn = createScenario(header.seed, header.scenario.config);
  const scenario_ok = JSON.stringify(scn) === JSON.stringify(header.scenario);
  const out: VerifyResult = { ok: scenario_ok, worlds: [], scenario_ok };
  for (const t of header.teams) {
    const ticks = frames.filter((f): f is TickFrame => f.kind === "tick" && f.world_id === t.world_id).sort((a, b) => a.tick - b.tick);
    const orders = new Map<number, Record<string, Order>>();
    for (const f of frames) {
      if (f.kind !== "event" || f.world_id !== t.world_id || f.type !== "order_issued") continue;
      const e = f as EventFrame;
      const batch = orders.get(e.tick) ?? {};
      batch[e.agent_id!] = e.payload.order as Order;
      orders.set(e.tick, batch);
    }
    let s = scn.initial;
    let mismatch: number | null = stateHash(s) === ticks[0]?.hash ? null : 0;
    for (let i = 1; i < ticks.length && mismatch === null; i++) {
      s = step(scn, s, orders.get(ticks[i]!.tick - 1) ?? {}).state;
      if (stateHash(s) !== ticks[i]!.hash) mismatch = ticks[i]!.tick;
    }
    if (mismatch !== null) out.ok = false;
    out.worlds.push({ world_id: t.world_id, ticks: ticks.length, mismatch_tick: mismatch });
  }
  return out;
}
