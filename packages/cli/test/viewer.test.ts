import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBundle } from "@firebreak/recorder";
import { stackLabels } from "../../viewer/src/render";
import { SCORE_LABEL, Timeline, callText, resultText } from "../../viewer/src/timeline";

const DIR = join(import.meta.dirname, "../../../recordings");
const recordings = readdirSync(DIR).filter((f) => f.endsWith(".sqlite"));

function timelineOf(file: string): Timeline {
  const b = loadBundle(join(DIR, file));
  const tl = new Timeline(b.header);
  for (const f of b.frames) tl.add(f);
  return tl;
}

describe("score log (SPEC §9.5)", () => {
  it.each(recordings)("running total equals the recorded score on every tick: %s", (file) => {
    const tl = timelineOf(file);
    for (const w of tl.worlds.values()) {
      expect(w.startScore).toBe(w.ticks[0]!.state.score.total);
      let i = 0;
      let total = w.startScore;
      for (const tf of w.ticks) {
        while (i < w.score.length && w.score[i]!.tick <= tf.tick) total = w.score[i++]!.total;
        expect(total, `${w.id} tick ${tf.tick}`).toBe(tf.state.score.total);
        // The log shown at a tick's time is the one that explains that tick's score.
        const shown = tl.scoreLogAt(w, tf.t_ms);
        expect(shown.at(-1)?.total ?? w.startScore, `${w.id} t=${tf.t_ms}`).toBe(tf.state.score.total);
      }
    }
  });

  it("credits evacuations to the rescuer and each extinguish to every firefighter in `by`", () => {
    const tl = timelineOf(recordings[0]!);
    for (const w of tl.worlds.values()) {
      const end = tl.durationMs;
      const p = tl.pointsAt(w, end);
      const s = w.ticks.at(-1)!.state.score;
      const credited = [...p.agents.values()];
      expect(credited.reduce((a, x) => a + x.evacuated, 0)).toBe(s.evacuated);
      expect(p.lostCivilians).toBe(s.lost);
      expect(p.lostHouses).toBe(s.houses_destroyed);
      // A joint extinguish credits both firefighters, so credits ≥ tiles extinguished.
      expect(credited.reduce((a, x) => a + x.extinguished, 0)).toBeGreaterThanOrEqual(s.extinguished);
    }
  });
});

describe("score pop-ups (SPEC §9.5)", () => {
  it("name the event, in the same words as the score log", () => {
    const tl = timelineOf(recordings[0]!);
    const entries = [...tl.worlds.values()].flatMap((w) => w.score);
    expect(new Set(entries.map((e) => e.type)).size).toBeGreaterThan(1);
    for (const e of entries) expect(e.text.startsWith(SCORE_LABEL[e.type])).toBe(true);
  });

  it("stack when they would overlap, and stay put when they don't", () => {
    const lineH = 12;
    // Two labels on one tile, one beside it that overlaps horizontally, one far away.
    const ys = stackLabels(
      [
        { x: 100, half: 40, y: 50 },
        { x: 100, half: 40, y: 50 },
        { x: 130, half: 40, y: 45 },
        { x: 300, half: 40, y: 50 },
      ],
      lineH,
    );
    expect(ys).toEqual([50, 38, 26, 50]);
  });
});

describe("actions feed (SPEC §9.4)", () => {
  const tl = timelineOf("20260927-175122-s11-atsg.sqlite");

  it("has one line per tool call, at the decision's end, plus every order outcome", () => {
    for (const w of tl.worlds.values()) {
      const calls = w.llm.reduce((n, c) => n + c.tool_calls.length, 0);
      expect(w.actions.filter((a) => a.kind === "call")).toHaveLength(calls);
      for (const a of w.actions.filter((x) => x.kind === "call")) expect(a.t_ms).toBe(a.llm!.ended_ms);
      const outcomes = w.events.filter((e) => e.type === "order_done" || e.type === "order_blocked").length;
      expect(w.actions.filter((a) => a.kind !== "call")).toHaveLength(outcomes);
      for (let i = 1; i < w.actions.length; i++)
        expect(w.actions[i]!.t_ms).toBeGreaterThanOrEqual(w.actions[i - 1]!.t_ms);
    }
  });

  it("marks validation errors, and leaves accepted messaging calls to the message feed", () => {
    const w = tl.worlds.get("w3-band")!;
    const sends = w.actions.filter((a) => a.text.startsWith("send_message"));
    expect(sends.length).toBeGreaterThan(0);
    for (const a of sends) expect(a.asMessage && a.messaging).toBe(true);
    const errors = [...tl.worlds.values()].flatMap((x) =>
      x.actions.filter((a) => a.tone === "error" && a.kind === "call"),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const a of errors) expect(a.result.startsWith("✗") || a.result.startsWith("→")).toBe(true);
    // Spawns: actions of the orchestrator, but shown once (as the brief) in All.
    const spawns = tl.worlds.get("w4-subagents")!.actions.filter((a) => a.text.startsWith("spawn("));
    expect(spawns.some((a) => a.asMessage && !a.messaging)).toBe(true);
  });

  it("indexes each agent's decisions for the inspector", () => {
    const w = tl.worlds.get("w3-band")!;
    const ds = tl.decisionsOf(w, "scout");
    expect(ds.length).toBeGreaterThan(3);
    const mid = ds[2]!;
    expect(tl.lastLlmCall(w, "scout", mid.ended_ms)?.id).toBe(mid.id);
    expect(tl.decisionIndexAt(w, "scout", mid.ended_ms - 1)).toBe(1);
    expect(tl.decisionIndexAt(w, "scout", -1)).toBe(-1);
  });

  it("writes calls like code and shortens their results", () => {
    expect(callText("extinguish", { x: 5, y: 7 })).toBe("extinguish(5,7)");
    expect(callText("rescue", { civilian_id: "c2" })).toBe("rescue(c2)");
    expect(callText("spawn", { body: "scout", brief: "long text ".repeat(9) })).toBe("spawn(scout)");
    expect(resultText("move_to(5,3)", "accepted: move_to(5,3) takes effect on tick 2")).toEqual({
      text: "✓ takes effect on tick 2",
      error: false,
    });
    expect(resultText("extinguish(1,1)", "rejected: no water left; refill first")).toEqual({
      text: "✗ no water left; refill first",
      error: true,
    });
  });
});
