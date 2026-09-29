import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MatchHeader, MessageFrame } from "@firebreak/engine";
import {
  RecordingWriter,
  commConcentration,
  communicationMatrix,
  computeMetrics,
  loadBundle,
  openRecording,
  type CommEdge,
} from "@firebreak/recorder";
import { Timeline, splitEdge, type Edges } from "../../viewer/src/timeline";

const asEdges = (e: Edges): CommEdge[] =>
  [...e].map(([k, count]) => {
    const [from, to] = splitEdge(k);
    return { from, to, count };
  });
const sorted = (xs: CommEdge[]) =>
  [...xs].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

const msg = (id: string, t_ms: number, from: string, to: string[], channel = "#team"): MessageFrame => ({
  kind: "message",
  world_id: "w1-x",
  id,
  t_ms,
  from,
  to,
  channel,
  text: id,
});

/** A hand-made recording: HQ briefs two agents, they report back, and one agent messages another. */
function fixture() {
  const header = {
    match_id: "fixture",
    created_at: "2026-09-29T00:00:00Z",
    seed: 1,
    tick_ms: 1000,
    ticks: 10,
    teams: [{ world_id: "w1-x", team: "subagents", label: "X" }],
    scenario: {},
    config: {},
  } as unknown as MatchHeader;
  const messages = [
    msg("m1", 0, "orchestrator", ["scout"], "spawn"),
    msg("m2", 500, "orchestrator", ["ff1"], "spawn"),
    msg("m3", 2000, "scout", ["orchestrator"], "report"),
    msg("m4", 3000, "scout", ["ff1", "ff2"]),
    msg("m5", 4000, "ff1", ["orchestrator"], "report"),
    msg("m6", 6000, "scout", ["ff1"]),
  ];
  const file = join(mkdtempSync(join(tmpdir(), "firebreak-comm-")), "fixture.sqlite");
  const w = new RecordingWriter(file);
  w.begin(header, {});
  for (const m of messages) w.write(m);
  w.close();
  return { file, header, messages };
}

describe("communication matrix (SPEC §9.1, §10)", () => {
  it("counts one edge per recipient, up to a time", () => {
    const { file } = fixture();
    const db = openRecording(file);
    const all = communicationMatrix(db, "w1-x");
    const early = communicationMatrix(db, "w1-x", 3000);
    db.close();
    expect(sorted(all)).toEqual(
      sorted([
        { from: "orchestrator", to: "scout", count: 1 },
        { from: "orchestrator", to: "ff1", count: 1 },
        { from: "scout", to: "orchestrator", count: 1 },
        { from: "scout", to: "ff1", count: 2 },
        { from: "scout", to: "ff2", count: 1 },
        { from: "ff1", to: "orchestrator", count: 1 },
      ]),
    );
    expect(early.reduce((a, e) => a + e.count, 0)).toBe(5);
    // Busiest node: scout touches 1 + 1 + 2 + 1 = 5 of 7 edge counts.
    expect(commConcentration(all)).toBeCloseTo(5 / 7);
    expect(commConcentration([])).toBeNull();
    expect(
      commConcentration([
        { from: "a", to: "hq", count: 3 },
        { from: "hq", to: "b", count: 1 },
      ]),
    ).toBe(1);
  });

  it("the viewer's graph counts match the SQL query, and shrink when scrubbing back", () => {
    const { file, header, messages } = fixture();
    const tl = new Timeline(header);
    for (const m of messages) tl.add(m);
    const w = tl.worlds.get("w1-x")!;
    const db = openRecording(file);
    for (const t of [6000, 3000, 0, 4500, 10_000, 1000]) {
      expect(sorted(asEdges(tl.edgesAt(w, t)))).toEqual(sorted(communicationMatrix(db, "w1-x", t)));
    }
    db.close();
    // Recent window: only (t − window, t].
    expect(asEdges(tl.edgesAt(w, 6000, 3000))).toEqual(
      expect.arrayContaining([
        { from: "ff1", to: "orchestrator", count: 1 },
        { from: "scout", to: "ff1", count: 1 },
      ]),
    );
    expect(tl.edgesAt(w, 6000, 3000).size).toBe(2);
  });

  it("on the seed-11 recording: sub-agents form a star, band does not, and the graph matches SQL", () => {
    const file = join(import.meta.dirname, "../../../recordings/20260927-175122-s11-atsg.sqlite");
    const bundle = loadBundle(file);
    const tl = new Timeline(bundle.header);
    for (const f of bundle.frames) tl.add(f);
    const db = openRecording(file);
    for (const w of tl.worlds.values()) {
      for (const t of [tl.durationMs, tl.durationMs / 3, tl.durationMs]) {
        expect(sorted(asEdges(tl.edgesAt(w, t)))).toEqual(sorted(communicationMatrix(db, w.id, t)));
      }
    }
    db.close();
    const m = computeMetrics(file);
    const sub = m.worlds.find((w) => w.team === "subagents")!;
    const band = m.worlds.find((w) => w.team === "band")!;
    expect(sub.comm_concentration).toBe(1);
    expect(sub.comm_matrix.every((e) => e.from === "orchestrator" || e.to === "orchestrator")).toBe(true);
    expect(band.comm_concentration!).toBeLessThan(0.6);
    expect(m.worlds.find((w) => w.team === "none")!.comm_concentration).toBeNull();
  });
});
