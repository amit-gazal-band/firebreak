import { formatOrder, type LlmFrame, type Score } from "@firebreak/engine";
import { drawChart, teamColor } from "./chart";
import { COLLAPSED_LINES, EXPANDED_LINES, FEED_MODES, Feed, agentIcon, type FeedMode } from "./feed";
import { drawGraph, hitGraph, nodeTraffic, type GraphHits, type GraphNode } from "./graph";
import { iconImg, type IconName } from "./icons";
import { loadViewPreferences, saveViewPreferences, type ViewPreferences } from "./preferences";
import { compactRoleLegend, createLegendDialog, rulesHref } from "./reference";
import { HQ_ID, drawBoard, type HitTarget } from "./render";
import { createThemeToggle } from "./theme";
import {
  edgeKey,
  splitEdge,
  type Edges,
  type OutcomeMetric,
  type ScoreEntry,
  type Timeline,
  type WorldTimeline,
} from "./timeline";

const SPEEDS = [0.5, 1, 2, 4, 10];
const VIEWS = ["board", "graph", "both"] as const;
export type View = (typeof VIEWS)[number];
/** The graph's "recent" window (SPEC §9.1). */
const RECENT_TICKS = 10;
/** Smallest board side in px; below it the expanded feeds show fewer lines instead. */
const MIN_BOARD = 220;
const STARTED_TITLE =
  "Standing houses count from tick 0, so the score starts above zero and each destroyed house shows as −5";
const TIMELINE_MARKERS = {
  civilian_lost: { color: "#ff4d6d", label: "civilian lost" },
  civilian_evacuated: { color: "#7cfc9a", label: "civilian evacuated" },
  house_destroyed: { color: "#ff9f43", label: "house destroyed" },
  wind_changed: { color: "#5bc0eb", label: "wind changed" },
  bridge_collapsed: { color: "#c792ea", label: "bridge collapsed" },
} as const;
const CHART_METRICS: Record<OutcomeMetric, { label: string; help: string; better: "high" | "low" }> = {
  score: { label: "Score", help: "Total points at each tick", better: "high" },
  extinguished: { label: "Fires out", help: "Cumulative fire tiles extinguished", better: "high" },
  active_fires: { label: "Active fires", help: "Fire tiles currently burning", better: "low" },
  evacuated: { label: "Civilians saved", help: "Cumulative civilian evacuations", better: "high" },
  lost: { label: "Civilians lost", help: "Cumulative civilian losses", better: "low" },
  houses_standing: { label: "Houses standing", help: "Houses still standing", better: "high" },
  houses_destroyed: { label: "Houses destroyed", help: "Cumulative houses destroyed", better: "low" },
};

interface Card {
  world: WorldTimeline;
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  graph: HTMLCanvasElement;
  wrap: HTMLElement;
  tooltip: HTMLElement;
  score: HTMLElement;
  chips: HTMLElement;
  scorebar: HTMLElement;
  outcomes: HTMLElement;
  counters: HTMLElement;
  feed: Feed;
  commentary: HTMLElement;
  results: HTMLElement;
  hits: HitTarget[];
  graphHits: GraphHits;
  hoverEdge: string | null;
  hoverAgent: string | null;
  visible: boolean;
  color: string;
  /** Last score shown and the breakdown key, to flash on change and rebuild chips only when needed. */
  lastScore: number | null;
  chipsKey: string;
  resultsKey: string;
}

const silent = (team: string) => team.startsWith("none") || team === "perfect" || team.startsWith("bots");

export interface PlayerOptions {
  mode: "live" | "replay";
  /** Loads a prompt that is not embedded in the bundle. */
  fetchPrompt?(llmId: string): Promise<string | null>;
  recordingName?: string;
  /** Start position in match seconds, and whether to start paused (URL ?t=…&paused). */
  startAt?: number;
  paused?: boolean;
  speed?: number;
  /** Card view (URL ?view=). Unset: board, or both when focused on one team. */
  view?: View;
  /** Feed tab (URL ?feed=). Default: all. */
  feed?: FeedMode;
  /** Non-fatal automatic commentary-generation failure. */
  commentaryError?: string;
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
  private shell!: HTMLElement;
  private contentEl!: HTMLElement;
  private boardsEl!: HTMLElement;
  private scrub!: HTMLInputElement;
  private scrubMarks!: HTMLCanvasElement;
  private timelineTeamKey!: HTMLElement;
  private clockEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private speedBtns: HTMLButtonElement[] = [];
  private inspector!: HTMLElement;
  /** The inspected agent, and the decision pinned from a feed line or ◀ / ▶ (null: follow the latest). */
  private selected: { world: string; agent: string; pin: string | null } | null = null;
  /** The world whose score log is open in the side panel. */
  private scoreLog: string | null = null;
  private inspectorKey = "";
  private lastFrame = performance.now();
  private badge!: HTMLElement;
  private view: View | null = null;
  private recent = false;
  private viewBtns: HTMLButtonElement[] = [];
  private recentBtn!: HTMLButtonElement;
  private expandBtn!: HTMLButtonElement;
  /** One expand state for every feed (SPEC §9.2). */
  private expanded = false;
  private feedMode: FeedMode = "all";
  private feedBtns: HTMLButtonElement[] = [];
  private hideDone = false;
  private orderLines = true;
  private legendDialog!: HTMLDialogElement;
  private broadcastDialog!: HTMLDialogElement;
  private subagentDialog!: HTMLDialogElement;
  private viewDialog!: HTMLDialogElement;
  private viewPreferences: ViewPreferences = loadViewPreferences();
  private chartCanvas!: HTMLCanvasElement;
  private chartValues!: HTMLElement;
  private chartMetric: OutcomeMetric = "score";
  private chartWorlds = new Set<string>();
  private chartMetricButtons = new Map<OutcomeMetric, HTMLButtonElement>();
  private chartRenderKey = "";

  constructor(
    private root: HTMLElement,
    private tl: Timeline,
    private o: PlayerOptions,
  ) {
    this.followLive = o.mode === "live";
    if (o.startAt !== undefined) this.t = o.startAt * 1000;
    if (o.paused) this.playing = false;
    if (o.view && VIEWS.includes(o.view)) this.view = o.view;
    if (o.feed && FEED_MODES.includes(o.feed)) this.feedMode = o.feed;
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

  setCommentaryMessage(message?: string): void {
    this.o.commentaryError = message;
    this.lastVersion = -1;
  }

  private build() {
    const h = this.tl.header;
    const resolved = h.config.resolved as { clock?: { mode?: string } } | undefined;
    const clockMode = resolved?.clock?.mode ?? "realtime";
    const shell = el("div", "shell");
    this.shell = shell;
    const top = el("div", "topbar");
    const brand = el("div", "brand");
    brand.innerHTML = "FIRE<span>BREAK</span>";
    this.badge = el("span", `badge ${this.o.mode}`, this.o.mode === "live" ? "LIVE" : "REPLAY");
    const meta = el(
      "div",
      "meta",
      `seed ${h.seed} · ${h.ticks} ticks × ${h.tick_ms / 1000}s · ${clockMode === "synchronized" ? "synchronized" : "real time"} · ${h.match_id}`,
    );
    const toggles = el("div", "toggles");
    const viewbar = el("div", "viewbar");
    const seg = el("div", "seg");
    for (const v of VIEWS) {
      const b = el("button", "", v);
      b.title = `Show the ${v === "both" ? "board and the communication graph" : v === "graph" ? "communication graph" : "board"} on every card`;
      b.addEventListener("click", () => this.setView(v));
      this.viewBtns.push(b);
      seg.append(b);
    }
    this.recentBtn = el("button", "", "whole match");
    this.recentBtn.title = `Graph: count every message so far, or only the last ${RECENT_TICKS} ticks`;
    this.recentBtn.addEventListener("click", () => {
      this.recent = !this.recent;
      this.recentBtn.textContent = this.recent ? `last ${RECENT_TICKS} ticks` : "whole match";
      this.recentBtn.classList.toggle("on", this.recent);
    });
    this.expandBtn = el("button", "", "expand feeds");
    this.expandBtn.title = "Expand or collapse every message feed";
    this.expandBtn.addEventListener("click", () => this.setExpanded(!this.expanded));
    const feedSeg = el("div", "seg");
    for (const m of FEED_MODES) {
      const b = el("button", "", m);
      b.title =
        m === "messages"
          ? "Feeds show messages"
          : m === "actions"
            ? "Feeds show what agents do: tool calls and order outcomes"
            : "Feeds show messages and actions, by time";
      b.addEventListener("click", () => this.setFeedMode(m));
      this.feedBtns.push(b);
      feedSeg.append(b);
    }
    const doneBtn = el("button", "", "completions");
    doneBtn.title = "Show or hide order completions in the feeds (move_to completions are frequent)";
    doneBtn.classList.add("on");
    doneBtn.addEventListener("click", () => {
      this.hideDone = !this.hideDone;
      doneBtn.classList.toggle("on", !this.hideDone);
      this.syncFeeds();
    });
    const linesBtn = el("button", "on", "order targets");
    linesBtn.title =
      "Show a role-coloured dashed line from each agent to its current target; red means the order is blocked";
    linesBtn.addEventListener("click", () => {
      this.orderLines = !this.orderLines;
      linesBtn.classList.toggle("on", this.orderLines);
    });
    viewbar.append(seg, this.recentBtn, feedSeg, doneBtn, this.expandBtn, linesBtn);
    const help = el("div", "help-links");
    const viewButton = el("button", "top-action", "Panels");
    viewButton.addEventListener("click", () => this.viewDialog.showModal());
    const legendButton = el("button", "top-action", "Legend");
    legendButton.addEventListener("click", () => this.legendDialog.showModal());
    const rules = el("a", "top-action", "Rules");
    rules.href = rulesHref();
    const subagentsButton = el("button", "top-action", "Sub-agents");
    subagentsButton.addEventListener("click", () => this.subagentDialog.showModal());
    const themeButton = createThemeToggle(() => {
      this.chartRenderKey = "";
      this.lastVersion = -1;
      requestAnimationFrame(() => this.layout());
    });
    help.append(viewButton, legendButton, rules, subagentsButton, themeButton);
    top.append(brand, this.badge, meta, compactRoleLegend(), viewbar, el("div", "spacer"), help, toggles);

    const main = el("div", "main");
    this.contentEl = el("div", "viewer-content");
    this.boardsEl = el("div", "boards");
    this.inspector = el("div", "inspector");
    this.contentEl.append(this.boardsEl);
    main.append(this.contentEl, this.inspector);

    let index = 0;
    for (const w of this.tl.worlds.values()) {
      const card = el("div", "card");
      const head = el("div", "card-head");
      const score = el("div", "score", "0");
      score.title = "Click for the score log: every scoring event so far";
      const color = teamColor(w.team, index++);
      const label = el("div", "label");
      const swatch = el("span", "swatch");
      swatch.style.background = color;
      swatch.title = "This team's colour in the outcome chart";
      label.append(swatch, document.createTextNode(w.label));
      head.append(label, score);
      const scorebar = el("div", "scorebar");
      const chips = el("div", "chips");
      scorebar.append(chips);
      const wrap = el("div", "board-wrap");
      const canvas = el("canvas");
      const graph = el("canvas", "graph");
      const tooltip = el("div", "graph-tip");
      const results = el("div", "results");
      results.style.display = "none";
      const cell = el("div", "board-cell");
      cell.append(canvas, results);
      wrap.append(cell, graph, tooltip);
      const outcomes = el("div", "outcomes");
      const counters = el("div", "counters");
      const feed = new Feed(w, {
        tickMs: this.tl.tickMs,
        silent: silent(w.team),
        onSeek: (t) => this.seek(t),
        onPick: (agent, llmId) => this.select(c, agent, llmId),
        onToggle: (on) => this.setExpanded(on),
      });
      feed.setMode(this.feedMode, this.hideDone);
      const commentary = el("section", "commentary");
      const commentaryHead = el("div", "commentary-head");
      commentaryHead.append(el("span", "", "AI BROADCAST"));
      const commentaryActions = el("span", "commentary-actions");
      commentaryActions.append(el("span", "commentary-status", "post-match observer"));
      const readCommentary = el("button", "commentary-read", "Read full");
      readCommentary.type = "button";
      commentaryActions.append(readCommentary);
      commentaryHead.append(commentaryActions);
      commentary.append(commentaryHead, el("div", "commentary-body meta", "Waiting for commentary…"));
      card.append(head, scorebar, wrap, outcomes, counters, feed.root, commentary);
      this.boardsEl.append(card);
      const c: Card = {
        world: w,
        root: card,
        canvas,
        graph,
        wrap,
        tooltip,
        score,
        chips,
        scorebar,
        outcomes,
        counters,
        feed,
        commentary,
        results,
        hits: [],
        graphHits: { nodes: [], edges: [] },
        hoverEdge: null,
        hoverAgent: null,
        visible: true,
        color,
        lastScore: null,
        chipsKey: "",
        resultsKey: "",
      };
      readCommentary.addEventListener("click", () => this.openBroadcast(c));
      canvas.addEventListener("click", (e) => this.onClick(c, e));
      canvas.addEventListener("mousemove", (e) => {
        c.hoverAgent = this.hitAgent(c, e);
        canvas.title = c.hoverAgent ? "" : "Click an agent to inspect it";
      });
      canvas.addEventListener("mouseleave", () => (c.hoverAgent = null));
      score.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openScoreLog(c);
      });
      graph.addEventListener("click", (e) => this.onGraphClick(c, e));
      graph.addEventListener("mousemove", (e) => this.onGraphHover(c, e));
      graph.addEventListener("mouseleave", () => {
        c.hoverEdge = null;
        tooltip.style.display = "none";
      });
      head.title = "Click to focus on this team (click again for all)";
      head.style.cursor = "pointer";
      head.addEventListener("click", () => this.toggleFocus(c));
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

    this.buildOutcomeChart();

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
    this.timelineTeamKey = el("div", "timeline-team-key");
    const timelineKey = el("div", "timeline-key");
    for (const { color, label } of Object.values(TIMELINE_MARKERS)) {
      const item = el("span");
      const mark = el("i");
      mark.style.background = color;
      item.append(mark, document.createTextNode(label));
      timelineKey.append(item);
    }
    controls.append(this.timelineTeamKey, timelineKey);
    if (this.o.mode === "live") {
      const liveBtn = el("button", "", "● live");
      liveBtn.addEventListener("click", () => {
        this.followLive = true;
        this.playing = true;
      });
      controls.append(liveBtn);
    }

    this.legendDialog = createLegendDialog();
    this.viewDialog = this.createViewDialog();
    this.subagentDialog = this.createSubagentDialog();
    this.broadcastDialog = el("dialog", "broadcast-dialog") as HTMLDialogElement;
    this.broadcastDialog.addEventListener("click", (event) => {
      if (event.target === this.broadcastDialog) this.broadcastDialog.close();
    });
    shell.append(
      top,
      main,
      controls,
      this.viewDialog,
      this.legendDialog,
      this.subagentDialog,
      this.broadcastDialog,
    );
    this.root.replaceChildren(shell);
    this.applyViewPreferences(false);
    this.setSpeed(1);
    this.syncView();
    this.syncFeeds();
    requestAnimationFrame(() => this.layout());
  }

  private createViewDialog(): HTMLDialogElement {
    const dialog = el("dialog", "legend-dialog view-dialog") as HTMLDialogElement;
    const closeForm = el("form") as HTMLFormElement;
    closeForm.method = "dialog";
    const close = el("button", "dialog-close", "×");
    close.setAttribute("aria-label", "Close view settings");
    closeForm.append(close);
    const options = el("div", "view-options");
    const definitions: { key: keyof ViewPreferences; label: string; detail: string }[] = [
      {
        key: "scoreBreakdown",
        label: "Score breakdown",
        detail: "House, rescue, loss, and extinguishment calculations",
      },
      { key: "missionStats", label: "Mission outcomes", detail: "Civilians, fires, and houses" },
      {
        key: "operationalStats",
        label: "Operational stats",
        detail: "Cost, calls, stale actions, idle time, and uncovered I3 fires",
      },
      { key: "messages", label: "Team feed", detail: "Messages and agent actions" },
      { key: "commentary", label: "AI commentary", detail: "Human-readable omniscient broadcast" },
      { key: "comparisonChart", label: "Outcome chart", detail: "Cross-team metrics over time" },
    ];
    for (const definition of definitions) {
      const label = el("label");
      const checkbox = el("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.checked = this.viewPreferences[definition.key];
      const copy = el("span");
      copy.append(el("b", "", definition.label), el("small", "", definition.detail));
      label.append(checkbox, copy);
      checkbox.addEventListener("change", () => {
        this.viewPreferences[definition.key] = checkbox.checked;
        this.applyViewPreferences();
      });
      options.append(label);
    }
    const reset = el("button", "top-action", "Show everything");
    reset.type = "button";
    reset.addEventListener("click", () => {
      this.viewPreferences = {
        scoreBreakdown: true,
        missionStats: true,
        operationalStats: true,
        messages: true,
        commentary: true,
        comparisonChart: true,
        comparisonChartCollapsed: false,
      };
      for (const input of Array.from(options.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')))
        input.checked = true;
      const chartCollapse = this.contentEl.querySelector<HTMLButtonElement>(".chart-collapse");
      if (chartCollapse) {
        chartCollapse.textContent = "Collapse";
        chartCollapse.setAttribute("aria-expanded", "true");
      }
      this.applyViewPreferences();
    });
    dialog.append(
      closeForm,
      el("div", "eyebrow", "Persistent display preferences"),
      el("h2", "", "Replay panels"),
      el("p", "meta", "Changes apply immediately and are remembered in this browser."),
      options,
      reset,
    );
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    return dialog;
  }

  private applyViewPreferences(persist = true) {
    const p = this.viewPreferences;
    this.shell.classList.toggle("hide-score-breakdown", !p.scoreBreakdown);
    this.shell.classList.toggle("hide-mission-stats", !p.missionStats);
    this.shell.classList.toggle("hide-operational-stats", !p.operationalStats);
    this.shell.classList.toggle("hide-messages", !p.messages);
    this.shell.classList.toggle("hide-commentary", !p.commentary);
    this.shell.classList.toggle("hide-comparison-chart", !p.comparisonChart);
    this.shell.classList.toggle("collapse-comparison-chart", p.comparisonChartCollapsed);
    if (persist) saveViewPreferences(p);
    requestAnimationFrame(() => this.layout());
  }

  private createSubagentDialog(): HTMLDialogElement {
    const dialog = el("dialog", "legend-dialog subagent-dialog") as HTMLDialogElement;
    const closeForm = el("form") as HTMLFormElement;
    closeForm.method = "dialog";
    const close = el("button", "dialog-close", "×");
    closeForm.append(close);
    const resolved = this.tl.header.config.resolved as
      { subagents?: { max_lifetime_ticks?: number } } | undefined;
    const recordedLimit = Number(resolved?.subagents?.max_lifetime_ticks ?? 0);
    const controls = el("div", "subagent-settings");
    const enabledLabel = el("label");
    const enabled = el("input") as HTMLInputElement;
    enabled.type = "checkbox";
    enabled.checked = recordedLimit > 0;
    enabledLabel.append(enabled, document.createTextNode("Enable hard lifetime limit"));
    const ticksLabel = el("label");
    ticksLabel.append(document.createTextNode("Maximum ticks"));
    const ticks = el("input") as HTMLInputElement;
    ticks.type = "number";
    ticks.min = "1";
    ticks.value = String(recordedLimit > 0 ? recordedLimit : 8);
    ticksLabel.append(ticks);
    controls.append(enabledLabel, ticksLabel);
    const commandRow = el("div", "setting-command");
    const command = el("code");
    const copy = el("button", "top-action", "Copy command");
    copy.type = "button";
    const teams = this.tl.header.teams.map((team) => team.team);
    if (!teams.includes("subagents")) teams.push("subagents");
    const update = () => {
      ticks.disabled = !enabled.checked;
      const limit = enabled.checked ? Math.max(1, Math.floor(Number(ticks.value) || 8)) : 0;
      command.textContent = `pnpm firebreak run --live --teams ${teams.join(",")} --set subagents.max_lifetime_ticks=${limit}`;
    };
    enabled.addEventListener("change", update);
    ticks.addEventListener("input", update);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(command.textContent ?? "");
        copy.textContent = "Copied";
      } catch {
        window.getSelection()?.selectAllChildren(command);
      }
    });
    update();
    commandRow.append(command, copy);
    dialog.append(
      closeForm,
      el("div", "eyebrow", "Run configuration"),
      el("h2", "", "Sub-agent lifecycle"),
      el(
        "p",
        "setting-current",
        recordedLimit > 0
          ? `This replay: hard ${recordedLimit}-tick limit.`
          : "This replay: task-driven lifecycle with no fixed limit.",
      ),
      el(
        "p",
        "meta",
        "Workers own bounded assignments until verified completion or an unrecoverable blockage.",
      ),
      controls,
      commandRow,
    );
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    return dialog;
  }

  private buildOutcomeChart() {
    const section = el("section", "outcome-chart");
    const heading = el("div", "outcome-chart-heading");
    const title = el("div");
    title.append(
      el("h2", "", "Outcome over time"),
      el("p", "meta", "Compare communication styles at every tick."),
    );
    const metricControls = el("div", "chart-metrics");
    for (const [key, config] of Object.entries(CHART_METRICS) as [
      OutcomeMetric,
      (typeof CHART_METRICS)[OutcomeMetric],
    ][]) {
      const button = el("button", key === this.chartMetric ? "on" : "", config.label);
      button.title = config.help;
      button.addEventListener("click", () => {
        this.chartMetric = key;
        for (const [metric, candidate] of this.chartMetricButtons)
          candidate.classList.toggle("on", metric === key);
        this.chartRenderKey = "";
        this.drawOutcomeChart();
      });
      this.chartMetricButtons.set(key, button);
      metricControls.append(button);
    }
    const chartActions = el("div", "outcome-chart-actions");
    const collapse = el(
      "button",
      "chart-collapse",
      this.viewPreferences.comparisonChartCollapsed ? "Expand" : "Collapse",
    );
    collapse.type = "button";
    collapse.setAttribute("aria-expanded", String(!this.viewPreferences.comparisonChartCollapsed));
    collapse.addEventListener("click", () => {
      this.viewPreferences.comparisonChartCollapsed = !this.viewPreferences.comparisonChartCollapsed;
      collapse.textContent = this.viewPreferences.comparisonChartCollapsed ? "Expand" : "Collapse";
      collapse.setAttribute("aria-expanded", String(!this.viewPreferences.comparisonChartCollapsed));
      this.applyViewPreferences();
    });
    chartActions.append(metricControls, collapse);
    heading.append(title, chartActions);
    const teamControls = el("div", "chart-teams");
    this.cards.forEach((card) => {
      this.chartWorlds.add(card.world.id);
      const label = el("label");
      const checkbox = el("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.chartWorlds.add(card.world.id);
        else this.chartWorlds.delete(card.world.id);
        this.chartRenderKey = "";
        this.drawOutcomeChart();
      });
      const swatch = el("i");
      swatch.style.background = card.color;
      label.append(checkbox, swatch, document.createTextNode(card.world.label));
      teamControls.append(label);
    });
    const plot = el("div", "chart-plot");
    this.chartCanvas = el("canvas");
    plot.append(this.chartCanvas);
    this.chartValues = el("div", "chart-values");
    section.append(heading, teamControls, plot, this.chartValues);
    this.contentEl.append(section);
  }

  private layout() {
    const visible = this.focused ? [this.focused] : this.cards.filter((c) => c.visible);
    const n = Math.max(1, visible.length);
    const box = this.boardsEl.getBoundingClientRect();
    const W = Math.max(MIN_BOARD, Math.floor(box.width));
    const H = Math.max(MIN_BOARD, Math.floor(this.contentEl.clientHeight - 24));
    const view = this.effectiveView();
    const gap = 12;
    // Presentation mode: every selected team remains visible in one row.
    // Users can hide teams or switch to a single-surface view when they want
    // larger maps or graphs, without changing the cross-team alignment.
    const cols = n;
    const rows = 1;
    let cardWidth = Math.floor((W - (cols - 1) * gap) / cols);
    if (n === 1 && view === "board") cardWidth = Math.min(900, cardWidth);

    // Expanded feeds yield lines before shrinking a visible surface below the readable minimum.
    let lines = this.expanded ? EXPANDED_LINES : COLLAPSED_LINES;
    let usableHeight = Math.floor((H - (rows - 1) * gap) / rows - this.chromeHeight(lines));
    while (this.expanded && lines > COLLAPSED_LINES && usableHeight < MIN_BOARD)
      usableHeight = Math.floor((H - (rows - 1) * gap) / rows - this.chromeHeight(--lines));
    usableHeight = Math.max(MIN_BOARD, usableHeight);
    for (const c of this.cards) c.feed.setLines(lines);
    this.boardsEl.style.gridTemplateColumns = `repeat(${cols}, ${cardWidth}px)`;
    const dpr = window.devicePixelRatio || 1;
    for (const c of this.cards) {
      const cell = c.canvas.parentElement!;
      let mapSize = 0;
      let graphSize = 0;
      if (view === "board") {
        mapSize = Math.min(900, cardWidth, usableHeight);
      } else if (view === "graph") {
        graphSize = Math.min(900, cardWidth, usableHeight);
      } else {
        mapSize = Math.min(900, Math.floor((cardWidth - 8) / 2), usableHeight);
        graphSize = mapSize;
      }
      c.wrap.style.width = `${cardWidth}px`;
      const surfaceHeight = Math.max(mapSize, graphSize);
      c.wrap.style.height = `${surfaceHeight}px`;
      c.wrap.style.justifyContent =
        (view === "board" && mapSize < cardWidth) || (view === "graph" && graphSize < cardWidth)
          ? "center"
          : "";
      cell.style.display = view === "graph" ? "none" : "";
      cell.style.width = `${mapSize}px`;
      cell.style.height = `${mapSize}px`;
      c.canvas.style.width = `${mapSize}px`;
      c.canvas.style.height = `${mapSize}px`;
      c.canvas.width = Math.round(mapSize * dpr);
      c.canvas.height = Math.round(mapSize * dpr);
      c.graph.style.display = view === "board" ? "none" : "";
      c.graph.style.width = `${graphSize}px`;
      c.graph.style.height = `${graphSize}px`;
      c.graph.width = Math.round(graphSize * dpr);
      c.graph.height = Math.round(graphSize * dpr);
    }
    const r = this.scrubMarks.getBoundingClientRect();
    this.scrubMarks.width = Math.round(r.width * dpr);
    this.scrubMarks.height = Math.round(r.height * dpr);
    this.chartRenderKey = "";
    this.drawOutcomeChart();
    this.lastVersion = -1;
  }

  private focused: Card | null = null;

  private chromeHeight(lines: number): number {
    const c = this.cards.find((x) => x.root.style.display !== "none") ?? this.cards[0];
    const head = c?.root.querySelector<HTMLElement>(".card-head")?.offsetHeight || 42;
    const counters = this.viewPreferences.operationalStats ? (c?.counters.offsetHeight ?? 46) : 0;
    const scorebar = this.viewPreferences.scoreBreakdown ? (c?.scorebar.offsetHeight ?? 44) : 0;
    const outcomes = this.viewPreferences.missionStats ? (c?.outcomes.offsetHeight ?? 104) : 0;
    const commentary = this.viewPreferences.commentary ? (c?.commentary.offsetHeight ?? 0) : 0;
    const feed = this.viewPreferences.messages ? (c?.feed.heightFor(lines) ?? 90) : 0;
    return head + scorebar + outcomes + counters + feed + commentary + 4;
  }

  private effectiveView(): View {
    return this.view ?? (this.focused ? "both" : "board");
  }

  private setView(v: View) {
    this.view = v;
    try {
      const u = new URL(location.href);
      u.searchParams.set("view", v);
      history.replaceState(null, "", u);
    } catch {
      // file:// pages may refuse URL changes; the view still applies.
    }
    this.syncView();
    this.layout();
  }

  private syncView() {
    const v = this.effectiveView();
    this.viewBtns.forEach((b, i) => b.classList.toggle("on", VIEWS[i] === v));
    this.recentBtn.style.display = v === "board" ? "none" : "";
  }

  private setFeedMode(m: FeedMode) {
    this.feedMode = m;
    try {
      const u = new URL(location.href);
      u.searchParams.set("feed", m);
      history.replaceState(null, "", u);
    } catch {
      // file:// pages may refuse URL changes; the mode still applies.
    }
    this.syncFeeds();
  }

  private syncFeeds() {
    this.feedBtns.forEach((b, i) => b.classList.toggle("on", FEED_MODES[i] === this.feedMode));
    for (const c of this.cards) c.feed.setMode(this.feedMode, this.hideDone);
  }

  private setExpanded(on: boolean) {
    this.expanded = on;
    for (const c of this.cards) c.feed.setExpanded(on);
    this.expandBtn.textContent = on ? "collapse feeds" : "expand feeds";
    this.layout();
  }

  private seek(t: number) {
    this.t = t;
    this.followLive = false;
  }

  /** Presenter mode: show one board at full size (PLAN M9). */
  private toggleFocus(c: Card) {
    this.focused = this.focused === c ? null : c;
    for (const x of this.cards) {
      const show = this.focused ? x === this.focused : x.visible;
      x.root.style.display = show ? "" : "none";
    }
    this.syncView();
    this.layout();
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
    else if (e.key.toLowerCase() === "l" && !this.legendDialog.open) this.legendDialog.showModal();
    else if (e.key === "Escape") this.closeInspector();
  }

  private hitAgent(c: Card, e: MouseEvent): string | null {
    const r = c.canvas.getBoundingClientRect();
    const dpr = c.canvas.width / r.width;
    const x = (e.clientX - r.left) * dpr;
    const y = (e.clientY - r.top) * dpr;
    return c.hits.find((h) => (h.x - x) ** 2 + (h.y - y) ** 2 <= h.r * h.r)?.id ?? null;
  }

  private onClick(c: Card, e: MouseEvent) {
    const hit = this.hitAgent(c, e);
    if (hit) this.select(c, hit);
  }

  /** Inspect an agent; with `llmId`, pin that decision instead of following the latest (SPEC §9.4). */
  private select(c: Card, agent: string, llmId: string | null = null) {
    const wasOpen = this.inspector.classList.contains("open");
    this.selected = { world: c.world.id, agent, pin: llmId };
    this.scoreLog = null;
    this.inspector.classList.add("open");
    this.inspectorKey = "";
    if (!wasOpen) this.layout();
  }

  private openScoreLog(c: Card) {
    const wasOpen = this.inspector.classList.contains("open");
    this.scoreLog = c.world.id;
    this.selected = null;
    this.inspector.classList.add("open");
    this.inspectorKey = "";
    if (!wasOpen) this.layout();
  }

  private graphPoint(c: Card, e: MouseEvent) {
    const r = c.graph.getBoundingClientRect();
    const dpr = c.graph.width / r.width;
    return {
      x: (e.clientX - r.left) * dpr,
      y: (e.clientY - r.top) * dpr,
      dpr,
      cx: e.clientX - r.left,
      cy: e.clientY - r.top,
    };
  }

  /** Click a node to inspect it, or an edge to filter the feed to that pair (SPEC §9.1). */
  private onGraphClick(c: Card, e: MouseEvent) {
    const p = this.graphPoint(c, e);
    const hit = hitGraph(c.graphHits, p.x, p.y, 6 * p.dpr);
    if (hit.node) this.select(c, hit.node);
    else if (hit.edge) c.feed.setFilter(splitEdge(hit.edge));
  }

  private onGraphHover(c: Card, e: MouseEvent) {
    const p = this.graphPoint(c, e);
    const hit = hitGraph(c.graphHits, p.x, p.y, 6 * p.dpr);
    c.hoverEdge = hit.edge ?? null;
    c.graph.style.cursor = hit.node || hit.edge ? "pointer" : "default";
    c.tooltip.style.display = c.hoverEdge ? "block" : "none";
    const wrap = c.graph.getBoundingClientRect();
    const box = c.graph.parentElement!.getBoundingClientRect();
    c.tooltip.style.left = `${wrap.left - box.left + p.cx + 12}px`;
    c.tooltip.style.top = `${wrap.top - box.top + p.cy + 12}px`;
  }

  private closeInspector() {
    this.selected = null;
    this.scoreLog = null;
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
    const shown = this.cards.filter((c) => c.visible && (!this.focused || c === this.focused));
    const view = this.effectiveView();
    // One weight scale for every graph on screen, so the same width means the same traffic (SPEC §9.1).
    const edges = new Map<Card, Edges>();
    let maxEdge = 0;
    let maxNode = 0;
    if (view !== "board") {
      for (const c of shown) {
        const e = this.tl.edgesAt(c.world, t, this.recent ? RECENT_TICKS * this.tl.tickMs : undefined);
        edges.set(c, e);
        for (const n of e.values()) maxEdge = Math.max(maxEdge, n);
        for (const n of nodeTraffic(e).values()) maxNode = Math.max(maxNode, n);
      }
    }
    for (const c of shown) {
      c.feed.update(t);
      const e = edges.get(c);
      if (e) this.renderGraph(c, e, t, maxEdge, maxNode, holdMs);
      if (view === "graph") {
        const f = this.tl.frameAt(c.world, t);
        if (f) tickShown = Math.max(tickShown, f.tick);
        this.renderStats(c, t, f?.tick ?? 0);
        if (f) this.renderMissionStats(c, f.cur.score, f.cur.fires.length);
        this.renderCommentary(c, t);
        const score = f?.cur.score.total ?? 0;
        if (f && score > leaderScore) {
          leaderScore = score;
          leader = c;
        }
        continue;
      }
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
          hover: c.hoverAgent,
          showHq: c.world.team === "subagents",
          orderLines: this.orderLines,
          popups: this.popups(c.world, t),
        },
      );
      const score = f.cur.score.total;
      if (score > leaderScore) {
        leaderScore = score;
        leader = c;
      }
      this.renderStats(c, t, f.tick);
      this.renderMissionStats(c, f.cur.score, f.cur.fires.length);
      this.renderCommentary(c, t);
      const ended =
        f.cur.ended && f.tick === this.tl.maxTick(c.world) && t >= this.tl.tickTime(c.world, f.tick);
      c.results.style.display = ended ? "flex" : "none";
      if (ended) this.renderResults(c, f.cur.score);
    }
    for (const c of this.cards) c.root.classList.toggle("leader", c === leader && this.cards.length > 1);
    const secs = (t / 1000).toFixed(1);
    this.clockEl.textContent = `tick ${tickShown} / ${this.tl.header.ticks} · ${secs}s · ${this.speed}×`;
    this.drawMarks();
    this.drawOutcomeChart();
    this.renderInspector(t);
  }

  /** Score and counters under a card (SPEC §9). */
  private renderStats(c: Card, t: number, tick: number) {
    const f = this.tl.frameAt(c.world, t);
    const total = f?.cur.score.total ?? 0;
    c.score.textContent = String(total);
    if (c.lastScore !== null && total !== c.lastScore) {
      c.score.classList.remove("flash-up", "flash-down");
      void c.score.offsetWidth; // restart the animation
      c.score.classList.add(total > c.lastScore ? "flash-up" : "flash-down");
    }
    c.lastScore = total;
    if (f) this.renderBreakdown(c, f.cur.score);
    const k = this.tl.counters(c.world, t, tick);
    const counter = (v: string | number, label: string) =>
      `<div class="counter"><b>${v}</b><span>${label}</span></div>`;
    c.counters.innerHTML =
      counter(`$${k.cost.toFixed(2)}`, "cost") +
      counter(k.calls, "LLM calls") +
      counter(k.messages, "messages") +
      counter(k.stale, "stale actions") +
      counter(k.idle, "idle agent-ticks") +
      counter(k.joint, "uncovered I3");
  }

  private renderMissionStats(c: Card, outcome: Score, activeFires: number) {
    const stat = (value: number, label: string, tone: "good" | "bad" | "neutral", title: string) =>
      `<div class="outcome ${tone}" title="${title}"><b>${value}</b><span>${label}</span></div>`;
    const pair = (a: string, b: string) => `<div class="outcome-pair">${a}${b}</div>`;
    c.outcomes.innerHTML =
      pair(
        stat(
          outcome.evacuated,
          `saved +${outcome.evacuated * 10}`,
          "good",
          "Civilians evacuated: 10 points each.",
        ),
        stat(outcome.lost, `lost −${outcome.lost * 20}`, "bad", "Civilians lost: minus 20 points each."),
      ) +
      pair(
        stat(
          outcome.extinguished,
          `fires out +${outcome.extinguished}`,
          "good",
          "Fire tiles extinguished: 1 point each.",
        ),
        stat(activeFires, "fires active", activeFires ? "bad" : "good", "Fire tiles currently burning."),
      ) +
      pair(
        stat(
          outcome.houses_standing,
          `standing +${outcome.houses_standing * 5}`,
          "good",
          "Houses standing: 5 points each.",
        ),
        stat(
          outcome.houses_destroyed,
          "destroyed",
          outcome.houses_destroyed ? "bad" : "neutral",
          "Houses destroyed.",
        ),
      );
  }

  private renderCommentary(c: Card, t: number) {
    const commentary = this.tl.commentaryAt(c.world, t);
    const body = c.commentary.querySelector<HTMLElement>(".commentary-body")!;
    const status = c.commentary.querySelector<HTMLElement>(".commentary-status")!;
    if (commentary) {
      const model = c.world.commentary.at(-1)?.model;
      status.textContent = model ?? "omniscient replay commentary";
      body.className = "commentary-body";
      body.replaceChildren();
      for (const paragraph of commentary.commentary.split(/\n\s*\n/).filter(Boolean))
        body.append(el("p", "", paragraph.trim()));
    } else {
      status.textContent = "post-match observer";
      body.className = "commentary-body meta";
      body.textContent =
        this.o.commentaryError ??
        (this.o.mode === "live"
          ? "The broadcast is generated after the outcome is fixed, then saved with the replay."
          : "No broadcast checkpoint yet.");
    }
  }

  /** Four score components behind the total in the card header (SPEC §9.5). */
  private renderBreakdown(c: Card, s: Score) {
    const key = `${s.houses_standing}|${s.evacuated}|${s.lost}|${s.extinguished}|${s.total}`;
    if (key === c.chipsKey) return;
    c.chipsKey = key;
    c.chips.replaceChildren(...this.scoreChips(c.world, s));
  }

  /** The four components behind the total already shown in the card header (SPEC §9.5). */
  private scoreChips(w: WorldTimeline, s: Score): HTMLElement[] {
    const chip = (icon: IconName, n: number, per: number, title: string) => {
      const d = el("span", `chip${n ? "" : " zero"}${per < 0 && n ? " loss" : ""}`);
      d.title = title;
      d.append(
        iconImg(icon, 13, {
          fg: icon === "lost" ? "#ff4d6d" : icon === "fire" ? "#ff9f43" : "#e8e9f0",
          title,
        }),
      );
      const v = n * per;
      d.append(
        document.createTextNode(
          ` ${n}×${per < 0 ? "−" : ""}${Math.abs(per)} = ${v < 0 ? "−" : ""}${Math.abs(v)}`,
        ),
      );
      return d;
    };
    const houses = w.startHouses || s.houses_standing + s.houses_destroyed;
    return [
      chip(
        "house",
        s.houses_standing,
        5,
        `+5 for each house still standing: ${houses} at the start, ${s.houses_destroyed} destroyed`,
      ),
      chip(
        "civilian",
        s.evacuated,
        10,
        `+10 for each civilian evacuated by the rescuer: ${s.evacuated} so far`,
      ),
      chip("lost", s.lost, -20, `−20 for each civilian lost to fire or a missed deadline: ${s.lost} so far`),
      chip("fire", s.extinguished, 1, `+1 for each fire tile put out: ${s.extinguished} so far`),
    ];
  }

  /** Scoring events to float up from their tile during about a tick of match time (SPEC §9.5). */
  private popups(w: WorldTimeline, t: number): { entry: ScoreEntry; age: number }[] {
    const out: { entry: ScoreEntry; age: number }[] = [];
    const life = this.tl.tickMs;
    for (let i = w.score.length - 1; i >= 0; i--) {
      const e = w.score[i]!;
      if (e.t_ms > t) continue;
      if (t - e.t_ms >= life) break;
      out.push({ entry: e, age: (t - e.t_ms) / life });
    }
    return out;
  }

  private drawOutcomeChart() {
    if (!this.chartCanvas || !this.chartValues) return;
    const rect = this.chartCanvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (this.chartCanvas.width !== width) this.chartCanvas.width = width;
    if (this.chartCanvas.height !== height) this.chartCanvas.height = height;
    const selected = this.cards.filter((card) => this.chartWorlds.has(card.world.id));
    const reference = selected[0]?.world;
    const frame = reference ? this.tl.frameAt(reference, this.t) : null;
    const tick = frame?.tick ?? 0;
    const key = `${this.tl.version}|${this.chartMetric}|${[...this.chartWorlds].join(",")}|${tick}|${width}|${height}|${document.documentElement.dataset.theme}`;
    if (key === this.chartRenderKey) return;
    this.chartRenderKey = key;
    const rows = selected.map((card) => ({
      card,
      values: this.tl.outcomeSeries(card.world, this.chartMetric).map((point) => point.value),
    }));
    const values = rows.flatMap((row) => row.values);
    if (!values.length) {
      this.chartCanvas.getContext("2d")!.clearRect(0, 0, width, height);
      this.chartValues.textContent = "Select at least one communication style.";
      return;
    }
    let min = Math.min(0, ...values);
    let max = Math.max(0, ...values);
    if (min === max) max = min + 1;
    const pad = Math.max(1, (max - min) * 0.06);
    if (min < 0) min -= pad;
    max += pad;
    drawChart(this.chartCanvas, {
      lines: rows.map(({ card, values: scores }) => ({ color: card.color, scores })),
      ticks: this.tl.header.ticks,
      min,
      max,
      at: tick + (frame?.alpha ?? 0),
      dpr,
    });
    const metric = CHART_METRICS[this.chartMetric];
    this.chartValues.replaceChildren(
      el(
        "span",
        `chart-direction ${metric.better}`,
        metric.better === "high" ? "Higher is better" : "Lower is better",
      ),
    );
    for (const { card } of rows) {
      const snapshot = this.tl.outcomesAt(card.world, this.t);
      if (!snapshot) continue;
      const chip = el("span", "chart-value");
      const swatch = el("i");
      swatch.style.background = card.color;
      chip.append(swatch, document.createTextNode(`${card.world.label}: ${snapshot[this.chartMetric]}`));
      this.chartValues.append(chip);
    }
  }

  /** End of match: the final score and the chips that explain it (SPEC §9.5). */
  private renderResults(c: Card, s: Score) {
    const key = `${s.houses_standing}|${s.evacuated}|${s.lost}|${s.extinguished}|${s.total}`;
    if (key === c.resultsKey) return;
    c.resultsKey = key;
    const box = el("div", "result-box");
    const houses = c.world.startHouses || s.houses_standing + s.houses_destroyed;
    // One line per category: points gained in green, lost in red, nothing in muted.
    const rows = el("div", "result-rows");
    const row = (icon: IconName, label: string, n: number, per: number, title: string) => {
      const v = n * per;
      const r = el("div", `result-row${v > 0 ? " good" : v < 0 ? " bad" : " zero"}`);
      r.title = title;
      r.append(
        iconImg(icon, 18, {
          fg: icon === "lost" ? "#ff4d6d" : icon === "fire" ? "#ff9f43" : "#e8e9f0",
          title,
        }),
        el("span", "result-label", label),
        el("span", "result-calc", `${n} × ${per < 0 ? "−" : ""}${Math.abs(per)}`),
        el("b", "result-pts", `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}`),
      );
      rows.append(r);
    };
    row(
      "house",
      "houses standing",
      s.houses_standing,
      5,
      `+5 for each house still standing: ${houses} at the start, ${s.houses_destroyed} destroyed`,
    );
    row("civilian", "civilians evacuated", s.evacuated, 10, "+10 for each civilian evacuated by the rescuer");
    row("lost", "civilians lost", s.lost, -20, "−20 for each civilian lost to fire or a missed deadline");
    row("fire", "fires put out", s.extinguished, 1, "+1 for each fire tile put out");
    const total = el("div", "result-row result-total");
    total.append(
      el("span"),
      el("span", "result-label", "total"),
      el("span"),
      el("b", "result-pts", String(s.total)),
    );
    rows.append(total);
    const started = el("div", "result-started", `started at ${c.world.startScore} (${houses} houses)`);
    started.title = STARTED_TITLE;
    box.append(el("b", "", `${s.total} pts`), rows, started);
    c.results.replaceChildren(box);
  }

  private graphNodes = new Map<string, GraphNode[]>();

  /** The team's agents, plus HQ for the sub-agent team (SPEC §9.1). */
  private nodesOf(w: WorldTimeline): GraphNode[] {
    let nodes = this.graphNodes.get(w.id);
    if (!nodes) {
      const first = w.ticks.find(Boolean);
      if (!first) return [];
      nodes = first.state.agents.map((a) => ({ id: a.id, role: a.role }));
      if (w.team === "subagents") nodes.push({ id: HQ_ID, role: null });
      this.graphNodes.set(w.id, nodes);
    }
    return nodes;
  }

  private renderGraph(c: Card, edges: Edges, t: number, maxEdge: number, maxNode: number, holdMs: number) {
    const flash = new Map<string, number>();
    for (let i = c.world.messages.length - 1; i >= 0; i--) {
      const m = c.world.messages[i]!;
      if (m.t_ms > t) continue;
      if (t - m.t_ms > holdMs) break;
      for (const r of m.to) {
        const k = edgeKey(m.from, r);
        flash.set(k, Math.max(flash.get(k) ?? 0, 1 - (t - m.t_ms) / holdMs));
      }
    }
    const dpr = c.graph.width / Math.max(1, c.graph.clientWidth);
    const empty = edges.size === 0;
    c.graphHits = drawGraph(c.graph.getContext("2d")!, c.graph.width, dpr, {
      nodes: this.nodesOf(c.world),
      edges,
      maxEdge,
      maxNode,
      flash,
      hover: c.hoverEdge,
      selected: this.selected?.world === c.world.id ? this.selected.agent : null,
      note: empty
        ? silent(c.world.team)
          ? "no messages on this team"
          : this.recent
            ? `no messages in the last ${RECENT_TICKS} ticks`
            : "no messages yet"
        : null,
      legend: this.recent ? `last ${RECENT_TICKS} ticks, all teams` : "all teams",
    });
    if (c.hoverEdge) {
      const [a, b] = splitEdge(c.hoverEdge);
      const n = edges.get(c.hoverEdge) ?? 0;
      const back = edges.get(edgeKey(b, a)) ?? 0;
      c.tooltip.textContent = `${a} → ${b}: ${n} message${n === 1 ? "" : "s"} · ${b} → ${a}: ${back}`;
    }
  }

  private drawMarks() {
    if (this.lastVersion === this.tl.version) return;
    this.lastVersion = this.tl.version;
    const cv = this.scrubMarks;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const dur = Math.max(1, this.tl.durationMs);
    const visible = this.cards.filter((card) => card.visible && (!this.focused || card === this.focused));
    this.timelineTeamKey.replaceChildren(el("span", "", "Event rows, top → bottom:"));
    for (const card of visible) {
      const item = el("span");
      const swatch = el("i");
      swatch.style.background = card.color;
      item.append(swatch, document.createTextNode(card.world.label));
      this.timelineTeamKey.append(item);
    }
    const laneHeight = cv.height / Math.max(1, visible.length);
    for (const m of this.tl.markers()) {
      if (m.t > dur) continue;
      const lane = visible.findIndex((card) => card.world.id === m.world_id);
      if (!m.global && lane < 0) continue;
      ctx.fillStyle = TIMELINE_MARKERS[m.type as keyof typeof TIMELINE_MARKERS]?.color ?? "#999";
      const x = (m.t / dur) * cv.width;
      if (m.global) ctx.fillRect(x - 1, 0, 2, cv.height);
      else ctx.fillRect(x - 1, lane * laneHeight, 2, Math.max(2, laneHeight - 1));
    }
    cv.title = "Team-specific outcomes use the labelled rows. Shared wind and bridge events span all rows.";
  }

  private renderInspector(t: number) {
    if (this.scoreLog) return this.renderScoreLog(t);
    if (!this.selected) return;
    const w = this.tl.worlds.get(this.selected.world)!;
    const card = this.cards.find((c) => c.world === w)!;
    const f = this.tl.frameAt(w, t);
    const agentId = this.selected.agent;
    const decisions = this.tl.decisionsOf(w, agentId);
    const pinned = this.selected.pin ? decisions.findIndex((d) => d.id === this.selected!.pin) : -1;
    const idx = pinned >= 0 ? pinned : this.tl.decisionIndexAt(w, agentId, t);
    const call = decisions[idx] ?? null;
    const inFlight = this.tl.inFlightLlmCall(w, agentId, t);
    const points = this.tl.pointsAt(w, t);
    const key = `${agentId}|${f?.tick}|${call?.id}|${inFlight?.id}|${pinned}|${card.feed.filteredAgent}|${points.agents.get(agentId)?.points}`;
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    const a = f?.cur.agents.find((x) => x.id === agentId);
    const box = this.inspector;
    box.replaceChildren();
    const close = el("button", "close", "×");
    close.addEventListener("click", () => this.closeInspector());
    const h = el("h3");
    h.append(agentIcon(agentId, 20), document.createTextNode(` ${agentId} · ${w.label}`));
    box.append(close, h);
    const only = el(
      "button",
      "inline-btn",
      card.feed.filteredAgent === agentId
        ? "show every agent in the feed"
        : "show only this agent in the feed",
    );
    only.addEventListener("click", () => {
      card.feed.setAgent(card.feed.filteredAgent === agentId ? null : agentId);
      this.inspectorKey = "";
    });
    box.append(only);
    if (a) {
      const kv = el("div", "kv");
      const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
      row("role", a.role);
      row("position", `(${a.pos.join(",")})`);
      row(
        "order",
        `${formatOrder(a.order) ?? "none"} · ${a.order_status}${a.block_reason ? ` (${a.block_reason})` : ""}`,
      );
      if (a.block_detail && a.order_status === "blocked") row("blocked by", a.block_detail);
      if (a.role === "firefighter") row("water", String(a.water));
      box.append(kv);
    } else if (agentId === HQ_ID) {
      box.append(
        el("div", "meta", "The orchestrator has no body. It only knows what sub-agents report back."),
      );
    }
    // Points earned by this agent; losses belong to the team, not to an agent (SPEC §9.5).
    box.append(el("h4", "", "Points"));
    const mine = points.agents.get(agentId);
    const pk = el("div", "kv");
    const prow = (k: string, v: string) => pk.append(el("span", "", k), el("span", "", v));
    const parts = mine
      ? [
          mine.evacuated ? `${mine.evacuated} evacuated` : "",
          mine.extinguished ? `${mine.extinguished} fire${mine.extinguished === 1 ? "" : "s"} out` : "",
        ].filter(Boolean)
      : [];
    prow("credited", mine ? `${fmtDelta(mine.points)} (${parts.join(", ")})` : "0");
    prow(
      "team losses",
      `${points.lostCivilians} civilian${points.lostCivilians === 1 ? "" : "s"} (${fmtDelta(-20 * points.lostCivilians)}), ${points.lostHouses} house${points.lostHouses === 1 ? "" : "s"} (${fmtDelta(-5 * points.lostHouses)})`,
    );
    box.append(pk);
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
    if (inFlight) {
      box.append(el("h4", "", "Decision in progress"));
      const notice = el("div", "decision-in-flight");
      notice.append(
        el("b", "", `${(Math.max(0, t - inFlight.started_ms) / 1000).toFixed(1)}s elapsed`),
        el(
          "span",
          "",
          a?.order_status === "active"
            ? "The body continues its current active order while the model responds."
            : "The body awaits the model response before choosing new work.",
        ),
      );
      box.append(notice);
    }
    // Decisions, stepped through with ◀ / ▶ (SPEC §9.4).
    const nav = el("h4", "decision-nav");
    nav.append(document.createTextNode(pinned >= 0 ? "Decision " : "Last decision "));
    if (decisions.length) {
      const step = (d: number) => {
        const target = decisions[Math.max(0, Math.min(decisions.length - 1, idx + d))];
        if (!target) return;
        this.selected = { world: w.id, agent: agentId, pin: target.id };
        this.seek(target.ended_ms);
        this.inspectorKey = "";
      };
      const prev = el("button", "", "◀");
      prev.title = "Previous decision";
      prev.disabled = idx <= 0;
      prev.addEventListener("click", () => step(idx < 0 ? 1 : -1));
      const next = el("button", "", "▶");
      next.title = "Next decision";
      next.disabled = idx >= decisions.length - 1;
      next.addEventListener("click", () => step(1));
      nav.append(prev, el("span", "", ` ${idx + 1} / ${decisions.length} `), next);
      if (pinned >= 0) {
        const latest = el("button", "", "latest");
        latest.title = "Follow the agent's latest decision again";
        latest.addEventListener("click", () => {
          this.selected = { world: w.id, agent: agentId, pin: null };
          this.inspectorKey = "";
        });
        nav.append(latest);
      }
    }
    box.append(nav);
    if (!call) {
      box.append(el("div", "meta", w.team.startsWith("bots") ? "Scripted bot: no LLM." : "No decision yet."));
      return;
    }
    const kv = el("div", "kv");
    const row = (k: string, v: string) => kv.append(el("span", "", k), el("span", "", v));
    row(
      "at",
      `t${Math.floor(call.ended_ms / this.tl.tickMs)} · ${(call.started_ms / 1000).toFixed(1)}s, took ${((call.latency_ms ?? call.ended_ms - call.started_ms) / 1000).toFixed(1)}s`,
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

  /** Every scoring event up to t, with running totals; click a line to seek (SPEC §9.5). */
  private renderScoreLog(t: number) {
    const w = this.tl.worlds.get(this.scoreLog!)!;
    const log = this.tl.scoreLogAt(w, t);
    const key = `score|${w.id}|${log.length}`;
    if (key === this.inspectorKey) return;
    this.inspectorKey = key;
    const box = this.inspector;
    box.replaceChildren();
    const close = el("button", "close", "×");
    close.addEventListener("click", () => this.closeInspector());
    box.append(close, el("h3", "", `Score log · ${w.label}`));
    box.append(
      el(
        "div",
        "meta",
        `Started at ${w.startScore}: +5 for each of ${w.startHouses} standing houses. +10 per evacuation, −20 per civilian lost, +1 per fire tile put out, −5 per house destroyed.`,
      ),
    );
    const list = el("div", "score-log");
    const icon: Record<ScoreEntry["type"], IconName> = {
      civilian_evacuated: "civilian",
      civilian_lost: "lost",
      extinguished: "fire",
      house_destroyed: "house",
    };
    const start = el("div", "score-line dim");
    start.append(
      el("span", "feed-tick", "t0"),
      el("span", "score-text", "start"),
      el("span", "score-total", `→ ${w.startScore}`),
    );
    list.append(start);
    for (const e of log) {
      const d = el("div", `score-line ${e.delta > 0 ? "gain" : "loss"}`);
      d.append(
        el("span", "feed-tick", `t${e.tick}`),
        iconImg(icon[e.type], 14, { fg: e.delta > 0 ? "#7cfc9a" : "#ff4d6d" }),
        el("span", "score-text", ` ${e.text}`),
        el("span", "score-delta", fmtDelta(e.delta)),
        el("span", "score-total", `→ ${e.total}`),
      );
      d.title = "Click to jump here";
      d.addEventListener("click", () => this.seek(e.t_ms));
      list.append(d);
    }
    box.append(list);
    list.scrollTop = list.scrollHeight;
  }

  private openBroadcast(c: Card) {
    const updates = this.tl.commentaryThrough(c.world, this.t);
    const dialog = this.broadcastDialog;
    dialog.replaceChildren();
    const close = el("button", "dialog-close", "×");
    close.type = "button";
    close.addEventListener("click", () => dialog.close());
    dialog.append(close, el("div", "eyebrow", "AI broadcast"), el("h2", "", c.world.label));
    if (!updates.length) {
      dialog.append(el("p", "meta", this.o.commentaryError ?? "No broadcast update is available yet."));
    } else {
      const transcript = el("div", "broadcast-transcript");
      updates.forEach((update, index) => {
        const article = el("article", index === updates.length - 1 ? "latest" : "");
        article.append(el("h3", "", index === updates.length - 1 ? "Latest update" : "Earlier update"));
        for (const paragraph of update.commentary.split(/\n\s*\n/).filter(Boolean))
          article.append(el("p", "", paragraph.trim()));
        transcript.append(article);
      });
      dialog.append(transcript);
    }
    dialog.showModal();
  }

  private async loadPrompt(call: LlmFrame, pre: HTMLElement) {
    const p = this.o.fetchPrompt ? await this.o.fetchPrompt(call.id) : null;
    pre.textContent = p ?? "(prompt not included in this recording)";
  }
}

function fmtDelta(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
