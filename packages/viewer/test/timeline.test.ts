import { createScenario, type MatchHeader, type WorldState } from "@firebreak/engine";
import { describe, expect, it } from "vitest";
import { Timeline } from "../src/timeline";

function fixture() {
  const scenario = createScenario(42);
  const header: MatchHeader = {
    match_id: "chart-test",
    created_at: "2026-09-28T00:00:00.000Z",
    seed: 42,
    tick_ms: 5_000,
    ticks: 60,
    teams: [{ world_id: "w0-none", team: "none", label: "No communication" }],
    scenario,
    config: {},
  };
  const timeline = new Timeline(header);
  const addTick = (tick: number, state: WorldState) =>
    timeline.add({ kind: "tick", world_id: "w0-none", tick, t_ms: tick * 5_000, state, hash: String(tick) });
  return { scenario, timeline, addTick };
}

describe("viewer outcome timeline", () => {
  it("identifies in-flight decisions at the selected replay time", () => {
    const { timeline } = fixture();
    const world = timeline.worlds.get("w0-none")!;
    timeline.add({
      kind: "llm",
      world_id: world.id,
      id: "slow-call",
      agent_id: "rescuer",
      started_ms: 5_000,
      ended_ms: 25_000,
      input_tokens: 10,
      output_tokens: 2,
      cache_read_tokens: 0,
      cost_usd: 0,
      cost_estimated: true,
      response: "",
      tool_calls: [],
    });

    expect(timeline.inFlightLlmCall(world, "rescuer", 15_000)?.id).toBe("slow-call");
    expect(timeline.inFlightLlmCall(world, "rescuer", 25_000)).toBeNull();
    expect(timeline.lastLlmCall(world, "rescuer", 25_000)?.id).toBe("slow-call");
  });

  it("keeps each outcome marker associated with its communication world", () => {
    const { timeline } = fixture();
    timeline.add({
      kind: "event",
      world_id: "w0-none",
      tick: 3,
      t_ms: 15_000,
      type: "civilian_lost",
      payload: { id: "c1" },
    });

    expect(timeline.markers()).toEqual([
      { t: 15_000, type: "civilian_lost", world_id: "w0-none", global: false },
    ]);
  });

  it("ends completed replays at the final simulation tick, not the LLM drain timestamp", () => {
    const { scenario, timeline, addTick } = fixture();
    addTick(0, structuredClone(scenario.initial));
    const final = structuredClone(scenario.initial);
    final.tick = 1;
    addTick(1, final);
    timeline.add({
      kind: "end",
      t_ms: 35_000,
      status: "completed",
      results: [{ world_id: "w0-none", team: "none", score: 0, cost_usd: 0 }],
    });

    expect(timeline.durationMs).toBe(5_000);
  });

  it("reads mission outcomes at the selected replay tick", () => {
    const { scenario, timeline, addTick } = fixture();
    const initial = structuredClone(scenario.initial);
    const later = structuredClone(initial);
    later.tick = 1;
    later.score = {
      evacuated: 1,
      lost: 1,
      extinguished: 2,
      houses_standing: 10,
      houses_destroyed: 1,
      total: 42,
    };
    later.fires = later.fires.slice(0, 1);
    addTick(0, initial);
    addTick(1, later);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.outcomesAt(world, 4_999)).toMatchObject({ tick: 0, evacuated: 0, lost: 0 });
    expect(timeline.outcomesAt(world, 5_000)).toEqual({
      tick: 1,
      t_ms: 5_000,
      score: 42,
      extinguished: 2,
      active_fires: 1,
      evacuated: 1,
      lost: 1,
      houses_standing: 10,
      houses_destroyed: 1,
    });
  });

  it("builds chart series from every recorded tick", () => {
    const { scenario, timeline, addTick } = fixture();
    const initial = structuredClone(scenario.initial);
    const later = structuredClone(initial);
    later.tick = 1;
    later.score.extinguished = 3;
    later.fires = [];
    addTick(0, initial);
    addTick(1, later);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.outcomeSeries(world, "extinguished").map((point) => point.value)).toEqual([0, 3]);
    expect(timeline.outcomeSeries(world, "active_fires").map((point) => point.value)).toEqual([
      initial.fires.length,
      0,
    ]);
  });

  it("counts intensity-3 fire-ticks without two assigned firefighters", () => {
    const { scenario, timeline, addTick } = fixture();
    const uncovered = structuredClone(scenario.initial);
    uncovered.tick = 1;
    uncovered.fires = [{ ...uncovered.fires[0]!, intensity: 3 }];
    const covered = structuredClone(uncovered);
    covered.tick = 2;
    for (const firefighter of covered.agents.filter((agent) => agent.role === "firefighter")) {
      firefighter.order_status = "active";
      firefighter.order = {
        type: "extinguish",
        x: covered.fires[0]!.pos[0],
        y: covered.fires[0]!.pos[1],
      };
    }
    addTick(0, structuredClone(scenario.initial));
    addTick(1, uncovered);
    addTick(2, covered);

    const world = timeline.worlds.get("w0-none")!;
    expect(timeline.counters(world, 5_000, 1).joint).toBe(1);
    expect(timeline.counters(world, 10_000, 2).joint).toBe(1);
  });
});
