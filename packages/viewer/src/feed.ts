import { iconImg } from "./icons";
import { HQ_ID, agentLook, roleOf } from "./render";
import type { ActionView, MessageView, WorldTimeline } from "./timeline";

export const FEED_MODES = ["messages", "actions", "all"] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export interface FeedOptions {
  tickMs: number;
  /** Shown when the team has no messages at all (none, perfect, bots). */
  silent: boolean;
  onSeek(tMs: number): void;
  /** A line was clicked: open the inspector on that agent (and that decision, for a tool call). */
  onPick(agent: string, llmId: string | null): void;
  /** The toggle was clicked: expand or collapse every feed (SPEC §9.2). */
  onToggle(expanded: boolean): void;
}

/** Feed line height; keep in sync with `.feed-list` in style.css. */
const LINE_PX = 18;
/** Lines shown when collapsed, and at most when expanded. */
export const COLLAPSED_LINES = 3;
export const EXPANDED_LINES = 10;
const listPx = (lines: number) => lines * LINE_PX + 4;

/** A pair of agents the feed is filtered to (from the graph, SPEC §9.1). */
export type Pair = [string, string];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export function agentIcon(id: string, px = 14): HTMLImageElement {
  const look = agentLook(id, roleOf(id));
  return iconImg(look.icon, px, {
    disc: id === HQ_ID ? "#1b1e2b" : look.color,
    fg: id === HQ_ID ? look.color : "#1b1e2b",
    ...(look.badge ? { badge: look.badge } : {}),
    title: id,
  });
}

/**
 * Feed under a board: messages (SPEC §9.2), agent actions (§9.4), or both by time. Collapsed it
 * shows the latest 3 lines; expanded it shows 10 and scrolls through everything up to t. Lines
 * are appended as t advances and the list is rebuilt only when t goes back or a filter changes,
 * so scrolling is never reset.
 */
export class Feed {
  readonly root = el("div", "feed");
  private title = el("span", "feed-title");
  private list = el("div", "feed-list");
  private pairChip = el("button", "feed-chip");
  private agentChip = el("button", "feed-chip");
  private toggleBtn = el("button", "feed-toggle");
  private newBtn = el("button", "feed-new", "↓ new");
  private empty = el("div", "feed-empty");
  private expanded = false;
  private lines = EXPANDED_LINES;
  private mode: FeedMode | null = null;
  private hideDone = false;
  private pair: Pair | null = null;
  private agent: string | null = null;
  /** messages[0..mi) and actions[0..ai) have been considered for the list. */
  private mi = 0;
  private ai = 0;
  private lastT = -Infinity;
  private rev = 0;
  private atBottom = true;

  constructor(
    private w: WorldTimeline,
    private o: FeedOptions,
  ) {
    const head = el("div", "feed-head");
    head.append(this.title, this.pairChip, this.agentChip, el("span", "spacer"), this.toggleBtn);
    this.pairChip.title = "Remove the pair filter";
    this.pairChip.addEventListener("click", () => this.setFilter(null));
    this.agentChip.title = "Remove the agent filter";
    this.agentChip.addEventListener("click", () => this.setAgent(null));
    this.toggleBtn.addEventListener("click", () => this.o.onToggle(!this.expanded));
    this.newBtn.addEventListener("click", () => this.scrollToEnd());
    this.list.addEventListener("scroll", () => {
      this.atBottom = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
      if (this.atBottom) this.newBtn.style.display = "none";
    });
    const body = el("div", "feed-body");
    body.append(this.list, this.newBtn);
    this.root.append(head, body);
    this.setExpanded(false);
    this.setFilter(null);
    this.setAgent(null);
  }

  /** Height of the feed showing `lines` lines, for the board size calculation. */
  heightFor(lines: number): number {
    const body = this.root.querySelector<HTMLElement>(".feed-body")!;
    return this.root.offsetHeight - body.offsetHeight + listPx(lines);
  }

  /** How many lines the expanded feed shows; fewer than 10 when the window is too small. */
  setLines(n: number): void {
    this.lines = n;
    if (this.expanded) this.list.style.height = `${listPx(n)}px`;
  }

  get filteredAgent(): string | null {
    return this.agent;
  }

  setExpanded(on: boolean): void {
    this.expanded = on;
    this.root.classList.toggle("expanded", on);
    this.list.style.height = on ? `${listPx(this.lines)}px` : "";
    this.toggleBtn.textContent = on ? "▴ collapse" : "▾ expand";
    this.toggleBtn.title = on ? "Show the latest 3 lines" : "Show 10 lines and scroll through everything";
    this.scrollToEnd();
  }

  setMode(mode: FeedMode, hideDone: boolean): void {
    if (mode === this.mode && hideDone === this.hideDone) return;
    this.mode = mode;
    this.hideDone = hideDone;
    this.title.textContent = mode === "all" ? "feed" : mode;
    this.reset();
  }

  setFilter(pair: Pair | null): void {
    this.pair = pair;
    this.pairChip.style.display = pair ? "" : "none";
    if (pair) this.pairChip.textContent = `${pair[0]} ⇄ ${pair[1]} ×`;
    this.reset();
  }

  /** Show only one agent's messages and actions (SPEC §9.4). */
  setAgent(agent: string | null): void {
    this.agent = agent;
    this.agentChip.style.display = agent ? "" : "none";
    if (agent)
      this.agentChip.replaceChildren(agentIcon(agent, 12), document.createTextNode(` only ${agent} ×`));
    this.reset();
  }

  /** Show lines up to t. */
  update(t: number): void {
    // Something already listed is now in the future (a seek back), or an action arrived out of order.
    if (this.lastT > t || this.rev !== this.w.actionsRev) this.reset();
    if (!this.mode) return;
    const ms = this.mode !== "actions" ? this.w.messages : [];
    const as = this.mode !== "messages" ? this.w.actions : [];
    let added = 0;
    for (;;) {
      const m = this.mi < ms.length && ms[this.mi]!.t_ms <= t ? ms[this.mi]! : null;
      const a = this.ai < as.length && as[this.ai]!.t_ms <= t ? as[this.ai]! : null;
      if (!m && !a) break;
      if (m && (!a || m.t_ms <= a.t_ms)) {
        this.mi++;
        this.lastT = m.t_ms;
        if (!this.showMessage(m)) continue;
        this.list.append(this.messageLine(m));
      } else {
        this.ai++;
        this.lastT = a!.t_ms;
        if (!this.showAction(a!)) continue;
        this.list.append(this.actionLine(a!));
      }
      added++;
    }
    if (!added) return;
    this.empty.remove();
    if (!this.expanded || this.atBottom) this.scrollToEnd();
    else this.newBtn.style.display = "";
  }

  private reset(): void {
    this.mi = 0;
    this.ai = 0;
    this.lastT = -Infinity;
    this.rev = this.w.actionsRev;
    const what =
      this.mode === "messages" ? "messages" : this.mode === "actions" ? "actions" : "messages or actions";
    this.empty.textContent = this.agent
      ? `no ${what} for ${this.agent} yet`
      : this.pair
        ? `no ${what} between ${this.pair[0]} and ${this.pair[1]} yet`
        : this.mode === "messages" && this.o.silent
          ? "no messages on this team"
          : `no ${what} yet`;
    this.list.replaceChildren(this.empty);
    this.scrollToEnd();
  }

  private showMessage(m: MessageView): boolean {
    if (this.agent && m.from !== this.agent && !m.to.includes(this.agent)) return false;
    if (!this.pair) return true;
    const [a, b] = this.pair;
    return (m.from === a && m.to.includes(b)) || (m.from === b && m.to.includes(a));
  }

  private showAction(a: ActionView): boolean {
    // Actions leaves plain messaging to the message feed; All shows every communication call once, as the message.
    if (this.mode === "actions" ? a.messaging : a.asMessage) return false;
    if (this.hideDone && a.kind === "done") return false;
    if (this.agent && a.agent !== this.agent) return false;
    if (this.pair && !this.pair.includes(a.agent)) return false;
    return true;
  }

  private tick(t_ms: number, tick?: number) {
    return el("span", "feed-tick", `t${tick ?? Math.floor(t_ms / this.o.tickMs)}`);
  }

  private messageLine(m: MessageView): HTMLElement {
    const d = el("div", "feed-line");
    d.append(
      this.tick(m.t_ms),
      agentIcon(m.from),
      el("b", "", m.from),
      document.createTextNode(` → ${m.to.join(", ") || m.channel}: `),
      el("span", "feed-text", m.text),
    );
    d.title = "Click to jump to this message";
    d.addEventListener("click", () => this.o.onSeek(m.t_ms));
    return d;
  }

  private actionLine(a: ActionView): HTMLElement {
    const d = el("div", `feed-line action ${a.tone} ${a.kind}`);
    d.append(this.tick(a.t_ms, a.tick), agentIcon(a.agent));
    if (a.kind === "call") {
      d.append(el("code", "", a.text));
      if (a.result) d.append(document.createTextNode(" "), el("span", "feed-result", a.result));
    } else if (a.kind === "done") {
      d.append(el("span", "feed-result", "✓ "), el("code", "", a.text), el("span", "feed-result", " done"));
    } else {
      d.append(
        el("span", "feed-result", "⛔ "),
        el("code", "", a.text),
        el("span", "feed-result", ` ${a.result.slice(2)}`),
      );
    }
    d.title = a.llm ? "Click to jump here and open this decision in the inspector" : "Click to jump here";
    d.addEventListener("click", () => {
      this.o.onSeek(a.t_ms);
      this.o.onPick(a.agent, a.llm?.id ?? null);
    });
    return d;
  }

  private scrollToEnd(): void {
    this.list.scrollTop = this.list.scrollHeight;
    this.atBottom = true;
    this.newBtn.style.display = "none";
  }
}
