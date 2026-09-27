import { mkdtempSync } from "node:fs";
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
import { PeerTeam, SubagentTeam, botsNone, botsPerfect } from "@firebreak/teams";
import { z } from "zod";
import { verifyRecording } from "../src/verify";

const tmp = () => mkdtempSync(join(tmpdir(), "firebreak-test-"));

/** Deterministic stand-in for a model: acts on the prompt with simple rules. */
class FakeLlm implements LlmClient {
  readonly backend = "api" as const;
  readonly model = "fake";
  calls = 0;

  async decide(req: DecideRequest): Promise<DecideResult> {
    this.calls++;
    const names = new Set(req.tools.map((t) => t.name));
    const tool_calls: DecideResult["tool_calls"] = [];
    const call = async (name: string, input: Record<string, unknown>) => {
      const r = await req.execute(name, input);
      tool_calls.push({ name, input, result: r.text });
    };
    const tick = Number(/TICK (\d+)/.exec(req.user)?.[1] ?? 0);
    if (names.has("spawn")) {
      for (const body of ["scout", "ff1"])
        if (
          !req.user.includes(`${body} (`) ||
          req.user.includes(`${body} (${body === "scout" ? "scout" : "firefighter"}): NO`)
        )
          await call("spawn", { body, brief: `explore from tick ${tick}` });
    } else if (names.has("finish") && tick >= 2) {
      await call("finish", { report: "done exploring" });
    } else {
      await call("move_to", { x: 10, y: 1 });
      if (names.has("send_message") && tick === 0)
        await call("send_message", { to: "all", text: "heading north" });
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

async function record(teams: TeamFactory[], ticks: number, llm: LlmClient | null) {
  const dir = tmp();
  const { config } = resolveConfig({
    overrides: { seed: 11, ticks, tick_ms: 1000, teams: teams.map((t) => t.type), llm: { backend: "api" } },
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
    virtualTime: true,
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
    expect(b.frames.filter((f) => f.kind === "tick")).toHaveLength(62);
    expect(b.frames.at(-1)?.kind).toBe("end");
    const db = openRecording(file);
    const cfg = readConfig(db);
    db.close();
    expect((cfg.resolved as Record<string, unknown>).secret_token).toBe("<redacted>");
    expect(cfg.code).toEqual({ git_commit: "test" });
    expect(cfg.prompts).toBeDefined();
    const m = computeMetrics(file);
    expect(m.worlds.find((w) => w.team === "bots-perfect")!.relative_score).toBe(1);
  });
});

describe("LLM teams (fake model)", () => {
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
    expect(frames.some((f) => f.kind === "event" && f.type === "order_issued")).toBe(true);
    const msgs = frames.filter((f) => f.kind === "message");
    expect(msgs.length).toBeGreaterThanOrEqual(5); // every message wakes the others, who may send again (capped per tick)
    const consumed = frames.filter((f) => f.kind === "delivery" && f.stage === "consumed");
    expect(consumed.length).toBeGreaterThan(0);
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
    expect(spawns.length).toBeGreaterThanOrEqual(2);
    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0]!.kind === "message" && reports[0]!.text).toMatch(/SEEN:/);
    const m = computeMetrics(file);
    expect(m.worlds[0]!.orchestrator_queue_median_ms).not.toBeNull();
  });
});
