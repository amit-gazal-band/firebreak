import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordingWriter, computeMetrics, loadBundle, openRecording, readConfig } from "@firebreak/recorder";
import {
  MatchRunner,
  MessageLog,
  redact,
  resolveConfig,
  setPath,
  type DecideRequest,
  type DecideResult,
  type DeliveredMessage,
  type LlmClient,
  type TeamFactory,
  type ToolResult,
  type Transport,
  type WorldHandle,
} from "@firebreak/runtime";
import {
  PeerTeam,
  SubagentTeam,
  botsNone,
  botsPerfect,
  chatBroadcast,
  chatMentions,
  validateSubagentAssignment,
} from "@firebreak/teams";
import { z } from "zod";
import { verifyRecording } from "../src/verify";
import { commentaryPath, ensureCommentary, loadReplayBundle, loadSavedCommentary } from "../src/commentary";

const tmp = () => mkdtempSync(join(tmpdir(), "firebreak-test-"));

/** Deterministic stand-in for a model: acts on the prompt with simple rules. */
class FakeLlm implements LlmClient {
  readonly backend = "api" as const;
  readonly model = "fake";
  readonly retainsSessionContext = false;
  calls = 0;
  systems: string[] = [];

  constructor(private finishSubagents = true) {}

  async decide(req: DecideRequest): Promise<DecideResult> {
    this.calls++;
    this.systems.push(req.system);
    const names = new Set(req.tools.map((t) => t.name));
    const tool_calls: DecideResult["tool_calls"] = [];
    const call = async (name: string, input: Record<string, unknown>) => {
      const r = await req.execute(name, input);
      tool_calls.push({ name, input, result: r.text });
    };
    const tick = Number(/TICK (\d+)/.exec(req.user)?.[1] ?? 0);
    if (names.has("publish_broadcast")) {
      const requested = /Publish exactly these checkpoint ticks: ([\d, ]+)/.exec(req.user)?.[1] ?? "0";
      const ticks = requested.split(",").map((x) => Number(x.trim()));
      await call("publish_broadcast", {
        segments: ticks.map((t) => ({
          tick: t,
          commentary:
            "Fire crews are confronting a growing front near several homes.\n\nThe team is concentrating its response and keeping rescue routes open.\n\nTheir priorities are sound, but the largest cluster needs immediate attention.",
        })),
      });
    } else if (names.has("spawn")) {
      for (const body of ["scout", "ff1"])
        if (
          !req.user.includes(`${body} (`) ||
          req.user.includes(`${body} (${body === "scout" ? "scout" : "firefighter"}): NO`)
        )
          await call("spawn", {
            body,
            brief: `explore the northern route from tick ${tick}`,
            done_when: "the northern route has been inspected once and all sightings are recorded",
          });
    } else if (names.has("finish") && tick >= 2 && this.finishSubagents) {
      await call("finish", { outcome: "completed", report: "done exploring" });
    } else {
      await call("move_to", { x: 10, y: 1 });
      if (names.has("send_message") && tick === 0) {
        const self = /YOU: ([^.]+)/.exec(req.system)?.[1] ?? "scout";
        await call("send_message", {
          to: "all",
          mentions: [self === "ff1" ? "ff2" : "ff1"],
          text: "heading north",
        });
      }
    }
    return {
      response: "",
      tool_calls,
      input_tokens: 100,
      output_tokens: 10,
      cache_read_tokens: 0,
      cost_usd: 0.001,
      cost_estimated: false,
    };
  }
}

class SlowFakeLlm extends FakeLlm {
  constructor(private delayMs: number) {
    super();
  }

  override async decide(req: DecideRequest): Promise<DecideResult> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return super.decide(req);
  }
}

/** In-memory broadcast transport, to exercise the send/deliver/consume path without a network. */
class FakeTransport implements Transport {
  readonly name = "fake";
  private log!: MessageLog;
  private world!: WorldHandle;
  private agents: string[] = [];
  private cbs = new Map<string, (m: DeliveredMessage) => void>();

  async setup(world: WorldHandle, agents: string[]) {
    this.world = world;
    this.agents = agents;
    this.log = new MessageLog(world);
  }
  tools() {
    return [{ name: "send_message", description: "broadcast", schema: { to: z.string(), text: z.string() } }];
  }
  async call(agent: string, _tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    const to = this.agents.filter((a) => a !== agent);
    const { id, t_ms } = this.log.sent(agent, { to, channel: "#team", text: String(input.text) });
    for (const r of to) {
      const d = this.log.delivered(id, r);
      this.cbs.get(r)?.({
        id,
        from: agent,
        channel: "#team",
        text: String(input.text),
        sent_ms: t_ms,
        delivered_ms: d,
        addressed: true,
      });
    }
    return { text: "sent", isError: false };
  }
  onDeliver(agent: string, cb: (m: DeliveredMessage) => void) {
    this.cbs.set(agent, cb);
  }
  promptSection() {
    return "fake comms";
  }
  async teardown() {}
}

async function record(
  teams: TeamFactory[],
  ticks: number,
  llm: LlmClient | null,
  extraOverrides: Record<string, unknown> = {},
) {
  const dir = tmp();
  const { config } = resolveConfig({
    overrides: {
      seed: 11,
      ticks,
      tick_ms: 1000,
      teams: teams.map((t) => t.type),
      llm: { backend: "api" },
      ...extraOverrides,
    },
  });
  const file = join(dir, "m.sqlite");
  const writer = new RecordingWriter(file);
  const sections = { resolved: redact({ ...config, secret_token: "abc" }), code: { git_commit: "test" } };
  const runner = new MatchRunner({
    matchId: "test",
    config,
    teams,
    sinks: [writer],
    configSections: sections,
    onConfigSection: (s, v) => writer.setConfig(s, v),
    llm,
  });
  writer.begin(runner.header(), sections);
  const result = await runner.run();
  writer.close();
  return { file, result };
}

describe("config", () => {
  it("merges file, base and CLI overrides", () => {
    const o: Record<string, unknown> = {};
    setPath(o, "llm.backend", "api");
    setPath(o, "fire.base_spread", "0.1");
    const { config } = resolveConfig({ sourceText: "ticks: 30\nteams: [none]\n", overrides: o });
    expect(config.ticks).toBe(30);
    expect(config.teams).toEqual(["none"]);
    expect(config.llm.backend).toBe("api");
    expect(config.llm.model).toMatch(/haiku/);
    expect(config.fire.base_spread).toBe(0.1);
    expect(config.fire.growth_every).toBe(5);
    expect(config.commentator.backend).toBe("claude-code");
    expect(config.commentator.model).toMatch(/haiku/);
    expect(config.subagents.max_lifetime_ticks).toBe(0);
    expect(config.clock.mode).toBe("synchronized");
  });

  it("redacts secret-looking keys", () => {
    expect(redact({ a: 1, api_key: "x", nested: { token: "y", ok: "z" } })).toEqual({
      a: 1,
      api_key: "<redacted>",
      nested: { token: "<redacted>", ok: "z" },
    });
  });
});

describe("recording and replay", () => {
  it("records a scripted match that verifies and replays", async () => {
    const { file, result } = await record([botsNone, botsPerfect], 30, null);
    expect(result.status).toBe("completed");
    expect(verifyRecording(file).ok).toBe(true);
    const b = loadBundle(file);
    const initialHashes = b.frames
      .filter((f) => f.kind === "tick" && f.tick === 0)
      .map((f) => (f.kind === "tick" ? f.hash : ""));
    expect(new Set(initialHashes)).toEqual(new Set([initialHashes[0]]));
    expect(b.frames.filter((f) => f.kind === "tick")).toHaveLength(62);
    expect(b.frames.at(-1)?.kind).toBe("end");
    expect(b.header.config.prompt_version).toBe("8");
    const db = openRecording(file);
    const cfg = readConfig(db);
    db.close();
    expect((cfg.resolved as Record<string, unknown>).secret_token).toBe("<redacted>");
    expect(cfg.code).toEqual({ git_commit: "test" });
    expect(cfg.prompts).toBeDefined();
  });
});

describe("LLM teams (fake model)", () => {
  it("waits for decisions before advancing synchronized ticks and preserves realtime as an option", async () => {
    const fake: TeamFactory = {
      type: "slow-peer",
      label: "Slow",
      usesLlm: true,
      create: () => new PeerTeam({ transport: null, view: "self" }),
    };
    const synchronized = await record([fake], 1, new SlowFakeLlm(15), { tick_ms: 1 });
    const synchronizedFrames = loadBundle(synchronized.file).frames;
    expect(
      synchronizedFrames.filter((frame) => frame.kind === "event" && frame.type === "order_issued"),
    ).toHaveLength(5);
    const calls = synchronizedFrames.filter((frame) => frame.kind === "llm");
    expect(calls).toHaveLength(5);
    expect(
      calls.every(
        (frame) =>
          frame.kind === "llm" &&
          frame.started_ms === 0 &&
          frame.ended_ms === 0 &&
          (frame.latency_ms ?? 0) >= 10,
      ),
    ).toBe(true);

    const realtime = await record([fake], 1, new SlowFakeLlm(15), {
      tick_ms: 1,
      clock: { mode: "realtime" },
    });
    expect(
      loadBundle(realtime.file).frames.filter(
        (frame) => frame.kind === "event" && frame.type === "order_issued",
      ),
    ).toHaveLength(0);
  });

  it("requires bounded sub-agent assignments with observable completion criteria", () => {
    expect(
      validateSubagentAssignment(
        "inspect the east road from the bridge to the final house",
        "the route has been inspected once and all sightings are recorded",
      ),
    ).toBeNull();
    expect(
      validateSubagentAssignment(
        "stay on watch near the east road until the match ends",
        "keep reporting anything that appears",
      ),
    ).toMatch(/open-ended/);
    expect(validateSubagentAssignment("inspect", "done")).toMatch(/brief/);
  });

  it("peer agents give orders and their messages are delivered and consumed", async () => {
    const llm = new FakeLlm();
    const fake: TeamFactory = {
      type: "fake-peer",
      label: "Fake",
      usesLlm: true,
      create: () => new PeerTeam({ transport: new FakeTransport(), view: "self" }),
    };
    const { file, result } = await record([fake], 6, llm);
    expect(result.status).toBe("completed");
    expect(llm.calls).toBeGreaterThanOrEqual(5);
    const frames = loadBundle(file).frames;
    expect(
      frames
        .filter((frame) => frame.kind === "llm")
        .every((frame) => frame.kind === "llm" && frame.started_ms < 6 * 5_000),
    ).toBe(true);
    expect(frames.some((f) => f.kind === "event" && f.type === "order_issued")).toBe(true);
    expect(llm.systems[0]).toContain("MATCH CLOCK:");
    expect(llm.systems[0]).toContain("Every visible fire is reported with a numeric intensity");
    const msgs = frames.filter((f) => f.kind === "message");
    expect(msgs.length).toBeGreaterThanOrEqual(5); // every message wakes the others, who may send again (capped per tick)
    const consumed = frames.filter((f) => f.kind === "delivery" && f.stage === "consumed");
    expect(consumed.length).toBeGreaterThan(0);
    expect(verifyRecording(file).ok).toBe(true);
  });

  it("local chat changes only who receives each room message", async () => {
    const llm = new FakeLlm();
    const { file } = await record([chatMentions, chatBroadcast], 2, llm);
    const messages = loadBundle(file).frames.filter((f) => f.kind === "message");
    const targeted = messages.filter((m) => m.world_id === "w1-chat-mentions");
    const broadcast = messages.filter((m) => m.world_id === "w2-chat-broadcast");
    expect(targeted.length).toBeGreaterThan(0);
    expect(broadcast.length).toBeGreaterThan(0);
    expect(targeted.every((m) => m.to.length === 1)).toBe(true);
    expect(broadcast.every((m) => m.to.length === 4)).toBe(true);
    expect(broadcast.every((m) => (m.meta?.addressed_to as string[]).length === 1)).toBe(true);
    expect(verifyRecording(file).ok).toBe(true);
  });

  it("generates, saves, and reuses omniscient commentary without modifying the recording", async () => {
    const gameplay = new FakeLlm();
    const fake: TeamFactory = {
      type: "fake-peer",
      label: "Fake",
      usesLlm: true,
      create: () => new PeerTeam({ transport: new FakeTransport(), view: "self" }),
    };
    const { file } = await record([fake], 2, gameplay);
    const before = readFileSync(file);
    const cacheDir = join(tmp(), "commentary");
    const commentator = new FakeLlm();
    const generated = await ensureCommentary(file, { llm: commentator, cacheDir });
    expect(generated).toHaveLength(1);
    expect(generated[0]!.segments.map((s) => s.tick)).toEqual([0, 2]);
    expect(generated[0]!.prompt).toContain("full_map_rows");
    expect(generated[0]!.prompt).toContain("heading north");
    expect(existsSync(commentaryPath(loadBundle(file).header, cacheDir))).toBe(true);
    expect(readFileSync(file).equals(before)).toBe(true);

    const calls = commentator.calls;
    const reused = await ensureCommentary(file, { llm: commentator, cacheDir });
    expect(commentator.calls).toBe(calls);
    expect(reused).toEqual(generated);
    expect(loadSavedCommentary(file, loadBundle(file), cacheDir)).toEqual(generated);
    expect(loadReplayBundle(file, { cacheDir }).frames.filter((f) => f.kind === "commentary")).toEqual(
      generated,
    );
    expect(verifyRecording(file).ok).toBe(true);
  });

  it("the orchestrator spawns sub-agents, which report back", async () => {
    const llm = new FakeLlm();
    const sub: TeamFactory = {
      type: "subagents",
      label: "Sub-agents",
      usesLlm: true,
      create: () => new SubagentTeam(),
    };
    const { file } = await record([sub], 8, llm);
    const frames = loadBundle(file).frames;
    const spawns = frames.filter((f) => f.kind === "event" && f.type === "spawn");
    const reports = frames.filter((f) => f.kind === "message" && f.channel === "report");
    const reportEvents = frames.filter((f) => f.kind === "event" && f.type === "report");
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(spawns.every((f) => f.kind === "event" && typeof f.payload.done_when === "string")).toBe(true);
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0]!.kind === "message" && reports[0]!.text).toMatch(/SEEN:/);
    expect(reportEvents[0]!.kind === "event" && reportEvents[0]!.payload).toMatchObject({
      outcome: "completed",
      age_ticks: expect.any(Number),
      long_threshold_ticks: 8,
      long_running: false,
    });
    const m = computeMetrics(file);
    expect(m.worlds[0]!.orchestrator_queue_median_ms).not.toBeNull();
    expect(
      llm.systems.some((system) => system.includes("Every assignment must be bounded and finishable")),
    ).toBe(true);
    expect(llm.systems.some((system) => system.includes("The moment every criterion is verified"))).toBe(
      true,
    );
  });

  it("keeps sub-agents alive until they report unless a hard lifetime is explicitly enabled", async () => {
    const sub: TeamFactory = {
      type: "subagents",
      label: "Sub-agents",
      usesLlm: true,
      create: () => new SubagentTeam(),
    };
    const taskDriven = await record([sub], 10, new FakeLlm(false));
    const taskDrivenReports = loadBundle(taskDriven.file).frames.filter(
      (frame) => frame.kind === "message" && frame.channel === "report",
    );
    expect(taskDrivenReports).toHaveLength(0);

    const capped = await record([sub], 10, new FakeLlm(false), {
      subagents: { max_lifetime_ticks: 8 },
    });
    const cappedReports = loadBundle(capped.file).frames.filter(
      (frame) => frame.kind === "message" && frame.channel === "report",
    );
    expect(cappedReports.length).toBeGreaterThan(0);
    expect(cappedReports[0]!.kind === "message" && cappedReports[0]!.text).toContain(
      "Hard 8-tick safety limit",
    );
  });
});
