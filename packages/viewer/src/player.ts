import { formatOrder, type LlmFrame } from "@firebreak/engine";
import { HQ_ID, drawBoard, type HitTarget } from "./render";
import type { Timeline, WorldTimeline } from "./timeline";

const SPEEDS = [0.5, 1, 2, 4, 10];

interface Card {
  world: WorldTimeline;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  score: HTMLElement;
  counters: HTMLElement;
  ticker: HTMLElement;
  results: HTMLElement;
  hits: HitTarget[];
  visible: boolean;
}

export interface PlayerOptions {
  mode: "live" | "replay";
  /** Loads a prompt that is not embedded in the bundle. */
  fetchPrompt?(llmId: string): Promise<string | null>;
  recordingName?: string;
  /** Start position in match seconds, and whether to start paused (URL ?t=…&paused). */
  startAt?: number;
  paused?: boolean;
  speed?: number;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Plays a Timeline: replays on a virtual clock, or follows a live match (SPEC §8.3, §9). */
export class Player {
  private t = 0;
  private speed = 1;
  private playing = true;
  private followLive: boolean;
  private liveOffset: number | null = null;
  private lastVersion = -1;
  private cards: Card[] = [];
  private boardsEl!: HTMLElement;
  private scrub!: HTMLInputElement;
  private scrubMarks!: HTMLCanvasElement;
  private clockEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private inspector!: HTMLElement;
  private selected: { world: string; agent: string } | null = null;
  private inspectorKey = "";
  private lastFrame = performance.now();
  private badge!: HTMLElement;

  constructor(
    private root: HTMLElement,
    private tl: Timeline,
    private o: PlayerOptions,
  ) {
    this.followLive = o.mode === "live";
    if (o.startAt !== undefined) this.t = o.startAt * 1000;
    if (o.paused) this.playing = false;
    this.build();
    if (o.speed) this.setSpeed(o.speed);
    window.addEventListener("resize", () => this.layout());
    window.addEventListener("keydown", (e) => this.onKey(e));
    requestAnimationFrame((n) => this.frame(n));
  }

  /** Called by the live source whenever frames arrive. */
  onFrames(): void {
    if (this.o.mode === "live") this.liveOffset = performance.now() - this.tl.lastMs;
  }

  private build() {
    const h = this.tl.header;
    const shell = el("div", "shell");
    const top = el("div", "topbar");
    const brand = el("div", "brand");
    brand.innerHTML = "FIRE<span>BREAK</span>";
    this.badge = el("span", `badge ${this.o.mode}`, this.o.mode === "live" ? "LIVE" : "REPLAY");
    const meta = el(
      "div",
      "meta",
      `seed ${h.seed} · ${h.ticks} ticks × ${h.tick_ms / 1000}s · ${h.match_id}`,
    );
    const toggles = el("div", "toggles");
    top.append(brand, this.badge, meta, el("div", "spacer"), toggles);

    const main = el("div", "main");
    this.boardsEl = el("div", "boards");
    this.inspector = el("div", "inspector");
    main.append(this.boardsEl, this.inspector);

    for (const w of this.tl.worlds.values()) {
      const card = el("div", "card");
      const head = el("div", "card-head");
      const score = el("div", "score", "0");
      head.append(el("div", "label", w.label), el("div", "team", w.team), score);
      const wrap = el("div", "board-wrap");
      const canvas = el("canvas");
      const results = el("div", "results");
      results.style.display = "none";
      wrap.append(canvas, results);
      const counters = el("div", "counters");
      const ticker = el("div", "ticker");
      card.append(head, wrap, counters, ticker);
      this.boardsEl.append(card);
      const c: Card = {
        world: w,
        root: card,
        canvas,
        score,
        counters,
        ticker,
        results,
        hits: [],
        visible: true,
      };
      canvas.addEventListener("click", (e) => this.onClick(c, e));
      this.cards.push(c);
      const lbl = el("label");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.addEventListener("change", () => {
        c.visible = cb.checked;
        card.style.display = cb.checked ? "" : "none";
        this.layout();
      });
      lbl.append(cb, document.createTextNode(w.label));
      toggles.append(lbl);
    }

    const controls = el("div", "controls");
    this.playBtn = el("button", "", "❚❚");
    this.playBtn.title = "Play / pause (space)";
    this.playBtn.addEventListener("click", () => this.togglePlay());
    const back = el("button", "", "◀ tick");
    back.addEventListener("click", () => this.stepTick(-1));
    const fwd = el("button", "", "tick ▶");
    fwd.addEventListener("click", () => this.stepTick(1));
    controls.append(this.playBtn, back, fwd);
    for (const s of SPEEDS) {
      const b = el("button", "", `${s}×`);
      b.addEventListener("click", () => this.setSpeed(s));
      this.speedBtns.push(b);
      controls.append(b);
    }
    const scrubWrap = el("div", "scrub");
    this.scrubMarks = el("canvas");
    this.scrub = el("input");
    this.scrub.type = "range";
    this.scrub.min = "0";
    this.scrub.step = "1";
    this.scrub.addEventListener("input", () => {
      this.t = Number(this.scrub.value);
      this.followLive = false;
    });
    scrubWrap.append(this.scrubMarks, this.scrub);
    this.clockEl = el("div", "clock");
    controls.append(scrubWrap, this.clockEl);
    if (this.o.mode === "live") {
      const liveBtn = el("button", "", "● live");
      liveBtn.addEventListener("click", () => {
        this.followLive = true;
        this.playing = true;
      });
      controls.append(liveBtn);
    }

    shell.append(top, main, controls);
    this.root.replaceChildren(shell);
    this.setSpeed(1);
    requestAnimationFrame(() => this.layout());
  }

  private layout() {
    const visible = this.cards.filter((c) => c.visible);
    const n = Math.max(1, visible.length);
    const box = this.boardsEl.getBoundingClientRect();
    const W = box.width - 24;
    const H = box.height - 24;
    const chrome = 150; // card header + counters + ticker
    let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const size = Math.floor(Math.min((W - (cols - 1) * 12) / cols, (H - (rows - 1) * 12) / rows - chrome));
      if (size > best.size) best = { cols, size };
    }
    const size = Math.max(220, best.size);
    this.boardsEl.style.gridTemplateColumns = `repeat(${best.cols}, ${size}px)`;
    const dpr = window.devicePixelRatio || 1;
    for (const c of this.cards) {
      c.canvas.style.width = `${size}px`;
      c.canvas.style.height = `${size}px`;
      c.canvas.width = Math.round(size * dpr);
      c.canvas.height = Math.round(size * dpr);
    }
    const r = this.scrubMarks.getBoundingClientRect();
    this.scrubMarks.width = Math.round(r.width * dpr);
    this.scrubMarks.height = Math.round(r.height * dpr);
    this.lastVersion = -1;
  }

  private togglePlay() {
    this.playing = !this.playing;
    if (this.playing && this.o.mode === "replay" && this.t >= this.tl.durationMs) this.t = 0;
  }

  private setSpeed(s: number) {
    this.speed = s;
    this.speedBtns.forEach((b, i) => b.classList.toggle("on", SPEEDS[i] === s));
  }

  private stepTick(d: number) {
    this.playing = false;
    this.followLive = false;
    const w = this.cards[0]!.world;
    const f = this.tl.frameAt(w, this.t);
    const tick = Math.max(0, Math.min(this.tl.maxTick(w), (f?.tick ?? 0) + d));
    this.t = this.tl.tickTime(w, tick);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT" && (e.target as HTMLInputElement).type !== "range")
      return;
    if (e.key === " ") {
      e.preventDefault();
      this.togglePlay();
    } else if (e.key === "ArrowRight") this.stepTick(1);
    else if (e.key === "ArrowLeft") this.stepTick(-1);
    else if (e.key >= "1" && e.key <= "5") this.setSpeed(SPEEDS[Number(e.key) - 1]!);
    else if (e.key === "Escape") this.closeInspector();
  }

  private onClick(c: Card, e: MouseEvent) {
    const r = c.canvas.getBoundingClientRect();
    const dpr = c.canvas.width / r.width;
    const x = (e.clientX - r.left) * dpr;
    const y = (e.clientY - r.top) * dpr;
    const hit = c.hits.find((h) => (h.x - x) ** 2 + (h.y - y) ** 2 <= h.r * h.r);
    if (hit) {
      this.selected = { world: c.world.id, agent: hit.id };
      this.inspector.classList.add("open");
      this.inspectorKey = "";
      this.layout();
    }
  }

  private closeInspector() {
    this.selected = null;
    this.inspector.classList.remove("open");
    this.layout();
  }

  private frame(now: number) {
    const dt = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    const dur = this.tl.durationMs;
    if (this.o.mode === "live" && this.followLive && this.liveOffset !== null) {
      this.t = Math.min(now - this.liveOffset, this.tl.lastMs + this.tl.tickMs);
    } else if (this.playing) {
      this.t = Math.min(dur, this.t + dt * this.speed);
      if (this.o.mode === "replay" && this.t >= dur) this.playing = false;
    }
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
    if (this.tl.end && this.o.mode === "live") {
      this.badge.textContent = "FINISHED";
      this.badge.className = "badge replay";
    }
    this.scrub.max = String(Math.max(1, Math.ceil(dur)));
    if (document.activeElement !== this.scrub) this.scrub.value = String(Math.round(this.t));
    this.render();
    requestAnimationFrame((n) => this.frame(n));
  }

  private render() {
    const t = this.t;
    const holdMs = 900 * Math.max(1, this.speed);
    let leader: Card | null = null;
    let leaderScore = -Infinity;
    let tickShown = 0;
    for (const c of this.cards) {
      if (!c.visible) continue;
      const f = this.tl.frameAt(c.world, t);
      const ctx = c.canvas.getContext("2d")!;
      ctx.fillStyle = "#11131c";
      ctx.fillRect(0, 0, c.canvas.width, c.canvas.height);
      if (!f) continue;
      tickShown = Math.max(tickShown, f.tick);
      const size = c.canvas.width;
      const cell = size / f.cur.size;
      c.hits = drawBoard(
        ctx,
        { x: 0, y: 0, cell, size },
        {
          scenario: this.tl.header.scenario,
          cur: f.cur,
          next: f.next,
          alpha: f.alpha,
          t,
          messages: this.tl.activeMessages(c.world, t, holdMs),
          holdMs,
          selected: this.selected?.world === c.world.id ? this.selected.agent : null,
          showHq: c.world.team === "subagents",
        },
      );
      const score = f.cur.score.total;
      c.score.textContent = String(score);
      if (score > leaderScore) {
        leaderScore = score;
        leader = c;
      }
      const k = this.tl.counters(c.world, t, f.tick);
      const counter = (v: string | number, label: string) =>
        `<div class="counter"><b>${v}</b><span>${label}</span></div>`;
      c.counters.innerHTML =
        counter(`$${k.cost.toFixed(2)}`, "cost") +
        counter(k.calls, "LLM calls") +
        counter(k.messages, "messages") +
        counter(k.stale, "stale actions") +
        counter(k.idle, "idle agent-ticks") +
        counter(k.joint, "missed joint");
      const recent = this.tl.recentMessages(c.world, t, 3);
      c.ticker.innerHTML = recent.length
        ? recent
            .map(
              (m) =>
                `<div><b>${esc(m.from)}</b> → ${esc(m.to.join(", ") || m.channel)}: ${esc(m.text)}</div>`,
            )
            .join("")
        : `<div>${c.world.team.startsWith("none") || c.world.team === "perfect" ? "no messages on this team" : "no messages yet"}</div>`;
      const ended =
        f.cur.ended && f.tick === this.tl.maxTick(c.world) && t >= this.tl.tickTime(c.world, f.tick);
      c.results.style.display = ended ? "flex" : "none";
      if (ended) c.results.innerHTML = `<div>${score} pts</div>`;
    }
    for (const c of this.cards) c.root.classList.toggle("leader", c === leader && this.cards.length > 1);
    const secs = (t / 1000).toFixed(1);
    this.clockEl.textContent = `tick ${tickShown} / ${this.tl.header.ticks} · ${secs}s · ${this.speed}×`;
    this.drawMarks();
    this.renderInspector(t);
  }

  private drawMarks() {
    if (this.lastVersion === this.tl.version) return;
    this.lastVersion = this.tl.version;
    const cv = this.scrubMarks;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const dur = Math.max(1, this.tl.durationMs);
    const color: Record<string, string> = {
      civilian_lost: "#ff4d6d",
      civilian_evacuated: "#7cfc9a",
      house_destroyed: "#ff9f43",
      wind_changed: "#5bc0eb",
      bridge_collapsed: "#c792ea",
    };
    for (const m of this.tl.markers()) {
      ctx.fillStyle = color[m.type] ?? "#999";
      const x = (m.t / dur) * cv.width;
      ctx.fillRect(x - 1, 0, 2, cv.height * 0.35);
    }
  }

  private renderInspector(t: number) {
    if (!this.selected) return;
    const w = this.tl.worlds.get(this.selected.world)!;
    const f = this.tl.frameAt(w, t);
    const agentId = this.selected.agent;
    const call = this.tl.lastLlmCall(w, agentId, t);
    const key = `${agentId}|${f?.tick}|${call?.id}`;
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    const a = f?.cur.agents.find((x) => x.id === agentId);
    const box = this.inspector;
    box.replaceChildren();
    const close = el("button", "close", "×");
    close.addEventListener("click", () => this.closeInspector());
    box.append(close, el("h3", "", `${agentId} · ${w.label}`));
    if (a) {
      const kv = el("div", "kv");
      const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
      row("role", a.role);
      row("position", `(${a.pos.join(",")})`);
      row(
        "order",
        `${formatOrder(a.order) ?? "none"} · ${a.order_status}${a.block_reason ? ` (${a.block_reason})` : ""}`,
      );
      if (a.role === "firefighter") row("water", String(a.water));
      box.append(kv);
    } else if (agentId === HQ_ID) {
      box.append(
        el("div", "meta", "The orchestrator has no body. It only knows what sub-agents report back."),
      );
    }
    const involving = w.messages
      .filter((m) => m.t_ms <= t && (m.from === agentId || m.to.includes(agentId)))
      .slice(-8);
    box.append(el("h4", "", "Recent messages"));
    if (!involving.length) box.append(el("div", "meta", "none"));
    for (const m of involving) {
      const d = el("div", "msg");
      d.innerHTML = `<span class="who">${esc(m.from)} → ${esc(m.to.join(", ") || m.channel)}</span> <span class="meta">t${Math.floor(m.t_ms / this.tl.tickMs)}</span><br>${esc(m.text)}`;
      box.append(d);
    }
    box.append(el("h4", "", "Last decision"));
    if (!call) {
      box.append(el("div", "meta", w.team.startsWith("bots") ? "Scripted bot: no LLM." : "No decision yet."));
      return;
    }
    const kv = el("div", "kv");
    const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
    row(
      "at",
      `${(call.started_ms / 1000).toFixed(1)}s, took ${((call.ended_ms - call.started_ms) / 1000).toFixed(1)}s`,
    );
    row("tokens", `${call.input_tokens} in · ${call.output_tokens} out`);
    row("cost", `$${call.cost_usd.toFixed(4)}${call.cost_estimated ? " (est.)" : ""}`);
    if (call.error) row("error", call.error);
    box.append(kv);
    box.append(el("h4", "", "Tool calls"));
    box.append(
      el(
        "pre",
        "",
        call.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.input)})\n  → ${c.result}`).join("\n") ||
          "(none)",
      ),
    );
    if (call.response) {
      box.append(el("h4", "", "Model text"));
      box.append(el("pre", "", call.response));
    }
    box.append(el("h4", "", "Prompt"));
    const pre = el("pre", "", call.prompt ?? "loading…");
    box.append(pre);
    if (!call.prompt) void this.loadPrompt(call, pre);
  }

  private async loadPrompt(call: LlmFrame, pre: HTMLElement) {
    const p = this.o.fetchPrompt ? await this.o.fetchPrompt(call.id) : null;
    pre.textContent = p ?? "(prompt not included in this recording)";
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
