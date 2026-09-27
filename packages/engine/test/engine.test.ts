import { describe, expect, it } from "vitest";
import {
  ScriptedBot,
  createScenario,
  observe,
  observeUnion,
  roll,
  stateHash,
  step,
  validateOrder,
  type OrderBatch,
  type Scenario,
  type WorldState,
} from "../src";

function playBots(scn: Scenario, union: boolean): { hashes: string[]; state: WorldState } {
  let s = scn.initial;
  const bots = s.agents.map((a) => new ScriptedBot(scn, a.id, a.role));
  const hashes = [stateHash(s)];
  while (!s.ended) {
    const orders: OrderBatch = {};
    for (const b of bots) {
      const obs = union ? observeUnion(scn, s, b.id) : observe(scn, s, b.id);
      const o = b.decide(obs);
      if (o && validateOrder(s, b.id, o) === null) orders[b.id] = o;
    }
    s = step(scn, s, orders).state;
    hashes.push(stateHash(s));
  }
  return { hashes, state: s };
}

/** A tiny hand-built world for rule tests. */
function tinyWorld(): Scenario {
  const scn = createScenario(1);
  const s = scn.initial;
  s.tiles = s.tiles.map(() => "grass");
  s.fires = [];
  s.civilians = [];
  return { ...scn, schedule: [], config: { ...scn.config, fire: { ...scn.config.fire, base_spread: 0 } } };
}

describe("scenario", () => {
  it("is fully determined by the seed", () => {
    expect(JSON.stringify(createScenario(7))).toBe(JSON.stringify(createScenario(7)));
    expect(JSON.stringify(createScenario(7))).not.toBe(JSON.stringify(createScenario(8)));
  });

  it("has a station, a bridge, houses and a schedule", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const scn = createScenario(seed);
      const t = scn.initial.tiles;
      expect(t.filter((k) => k === "station")).toHaveLength(1);
      expect(t.filter((k) => k === "bridge")).toHaveLength(1);
      expect(t.filter((k) => k === "house").length).toBeGreaterThanOrEqual(8);
      expect(scn.initial.fires.length).toBeGreaterThanOrEqual(2);
      expect(scn.schedule.some((e) => e.type === "bridge_collapse")).toBe(true);
      expect(scn.schedule.filter((e) => e.type === "civilian").length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("determinism", () => {
  it("same seed and orders give identical hashes on every tick", () => {
    const a = playBots(createScenario(42), false);
    const b = playBots(createScenario(42), false);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.hashes.length).toBeGreaterThan(10);
  });

  it("rolls depend only on seed, tick, tile and purpose", () => {
    expect(roll(1, 5, 3, 4, "spread:1,0")).toBe(roll(1, 5, 3, 4, "spread:1,0"));
    expect(roll(1, 5, 3, 4, "spread:1,0")).not.toBe(roll(1, 6, 3, 4, "spread:1,0"));
  });

  it("diverged worlds still share the same luck on untouched tiles", () => {
    // Two worlds from the same scenario where one team does nothing: a fire nobody
    // touches spreads identically in both until the teams interfere with it.
    const scn = createScenario(3);
    const idle = step(scn, scn.initial, {}).state;
    const busy = step(scn, scn.initial, { ff1: { type: "move_to", x: scn.station[0], y: scn.station[1] + 1 } }).state;
    expect(idle.fires).toEqual(busy.fires);
  });
});

describe("rules", () => {
  it("one firefighter cannot reduce an intensity-3 fire; two together can", () => {
    const scn = tinyWorld();
    const s = scn.initial;
    s.fires = [{ pos: [10, 10], intensity: 3, since: 0, last_growth: 0, last_fought: -1, max_since: 0 }];
    s.agents.find((a) => a.id === "ff1")!.pos = [9, 10];
    s.agents.find((a) => a.id === "ff2")!.pos = [11, 10];

    const alone = step(scn, s, { ff1: { type: "extinguish", x: 10, y: 10 } });
    expect(alone.state.fires[0]!.intensity).toBe(3);
    expect(alone.events.some((e) => e.type === "joint_needed")).toBe(true);

    const both = step(scn, s, {
      ff1: { type: "extinguish", x: 10, y: 10 },
      ff2: { type: "extinguish", x: 10, y: 10 },
    });
    expect(both.state.fires[0]!.intensity).toBe(1);
  });

  it("extinguishing a fire scores a point and completes the order", () => {
    const scn = tinyWorld();
    const s = scn.initial;
    s.fires = [{ pos: [10, 10], intensity: 1, since: 0, last_growth: 0, last_fought: -1, max_since: -1 }];
    s.agents.find((a) => a.id === "ff1")!.pos = [9, 10];
    const r = step(scn, s, { ff1: { type: "extinguish", x: 10, y: 10 } });
    expect(r.state.fires).toHaveLength(0);
    expect(r.state.score.extinguished).toBe(1);
    expect(r.events).toContainEqual(expect.objectContaining({ type: "order_done", agent: "ff1" }));
  });

  it("orders on a target that is gone are blocked (stale actions)", () => {
    const scn = tinyWorld();
    const r = step(scn, scn.initial, { ff1: { type: "extinguish", x: 5, y: 5 } });
    expect(r.events).toContainEqual(expect.objectContaining({ type: "order_blocked", agent: "ff1", reason: "no_fire_at_target" }));
  });

  it("the rescuer can only drive on roads", () => {
    const scn = createScenario(5);
    const s = scn.initial;
    const grass = s.tiles.findIndex((k) => k === "grass");
    const err = validateOrder(s, "rescuer", { type: "move_to", x: grass % s.size, y: Math.floor(grass / s.size) });
    expect(err).toMatch(/roads/);
  });

  it("only the role's own orders are accepted", () => {
    const s = createScenario(5).initial;
    expect(validateOrder(s, "scout", { type: "refill" })).toMatch(/cannot/);
    expect(validateOrder(s, "ff1", { type: "refill" })).toBeNull();
  });

  it("only the scout gets the wind forecast, unless the view is the union", () => {
    const scn = createScenario(9);
    const shift = scn.schedule.find((e) => e.type === "wind")!;
    let s = scn.initial;
    while (s.tick < shift.tick - 2) s = step(scn, s).state;
    expect(observe(scn, s, "scout").forecast?.length).toBeGreaterThan(0);
    expect(observe(scn, s, "ff1").forecast).toBeUndefined();
    expect(observeUnion(scn, s, "ff1").forecast?.length).toBeGreaterThan(0);
  });
});

describe("scripted bots", () => {
  it("play a full match quickly", () => {
    const t0 = performance.now();
    for (let i = 0; i < 4; i++) playBots(createScenario(100 + i), i % 2 === 0);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("perfect-information bots beat isolated bots on average", () => {
    let none = 0;
    let perfect = 0;
    for (let seed = 1; seed <= 20; seed++) {
      none += playBots(createScenario(seed), false).state.score.total;
      perfect += playBots(createScenario(seed), true).state.score.total;
    }
    expect(perfect).toBeGreaterThan(none);
  });
});
