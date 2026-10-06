import {
  formatOrder,
  teamVision,
  type AgentState,
  type Role,
  type Scenario,
  type TileKind,
  type Vec,
  type WorldState,
} from "@firebreak/engine";
import { ROLE_ICON, drawBadge, drawIcon, type IconName } from "./icons";
import { SCORE_LABEL, type MessageView, type ScoreEntry } from "./timeline";

export const TILE_COLOR: Record<TileKind, string> = {
  grass: "#9dbb6f",
  forest: "#4f7a45",
  house: "#b58a5e",
  road: "#a9a296",
  water: "#4d97c7",
  bridge: "#8a6843",
  debris: "#a9a296",
  firebreak: "#8b7a55",
  ash: "#57534f",
  station: "#a9a296",
};

export const ROLE_COLOR: Record<Role, string> = {
  scout: "#f5d547",
  firefighter: "#ff6b4a",
  engineer: "#5bc0eb",
  rescuer: "#f7f7f2",
};

/** Non-body participants drawn at a fixed spot (the sub-agent orchestrator). */
export const HQ_ID = "orchestrator";
export const HQ_COLOR = "#c792ea";

/** How an agent is drawn everywhere (board, graph, feed, inspector): disc colour, icon, FF badge. */
export function agentLook(id: string, role: Role | null): { icon: IconName; color: string; badge?: string } {
  if (id === HQ_ID || !role) return { icon: "hq", color: HQ_COLOR };
  const badge = id === "ff1" ? "1" : id === "ff2" ? "2" : undefined;
  return { icon: ROLE_ICON[role], color: ROLE_COLOR[role], ...(badge ? { badge } : {}) };
}

/** Role of an agent id on the standard team, for places that only have the id. */
export function roleOf(id: string): Role | null {
  if (id === "scout") return "scout";
  if (id.startsWith("ff")) return "firefighter";
  if (id === "engineer") return "engineer";
  if (id === "rescuer") return "rescuer";
  return null;
}

export interface BoardGeometry {
  x: number;
  y: number;
  cell: number;
  size: number;
}

export interface DrawInput {
  scenario: Scenario;
  cur: WorldState;
  next: WorldState | null;
  alpha: number;
  t: number;
  messages: MessageView[];
  holdMs: number;
  selected: string | null;
  hover: string | null;
  showHq: boolean;
  /** Draw each agent's current order as a dashed line to its target (SPEC §9.4). */
  orderLines: boolean;
  /** Scoring events to float up from their tile, with age 0..1 (SPEC §9.5). */
  popups: { entry: ScoreEntry; age: number }[];
}

export interface HitTarget {
  id: string;
  x: number;
  y: number;
  r: number;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function agentPos(cur: WorldState, next: WorldState | null, alpha: number, id: string): Vec | null {
  const a = cur.agents.find((x) => x.id === id);
  if (!a) return null;
  const b = next?.agents.find((x) => x.id === id);
  if (!b) return a.pos;
  // Ease so movement reads as a step, not a slide.
  const e = alpha < 0.5 ? 2 * alpha * alpha : 1 - (-2 * alpha + 2) ** 2 / 2;
  return [lerp(a.pos[0], b.pos[0], e), lerp(a.pos[1], b.pos[1], e)];
}

/**
 * Stack floating labels (centre x, half width, wanted y) so none overlaps an earlier one: each
 * label that would collide moves up one line above it. Returns the y to draw each label at.
 */
export function stackLabels(labels: { x: number; half: number; y: number }[], lineH: number): number[] {
  const placed: { x0: number; x1: number; y: number }[] = [];
  return labels.map(({ x, half, y }) => {
    for (let moved = true; moved;) {
      moved = false;
      for (const r of placed)
        if (x - half < r.x1 && x + half > r.x0 && Math.abs(y - r.y) < lineH) {
          y = r.y - lineH;
          moved = true;
        }
    }
    placed.push({ x0: x - half, x1: x + half, y });
    return y;
  });
}

export function drawBoard(ctx: CanvasRenderingContext2D, g: BoardGeometry, d: DrawInput): HitTarget[] {
  const { cur } = d;
  const S = cur.size;
  const c = g.cell;
  const px = (x: number) => g.x + x * c;
  const py = (y: number) => g.y + y * c;
  const center = (p: Vec): Vec => [px(p[0]) + c / 2, py(p[1]) + c / 2];
  ctx.save();

  // Tiles.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const k = cur.tiles[y * S + x]!;
      ctx.fillStyle = TILE_COLOR[k];
      ctx.fillRect(px(x), py(y), c + 0.5, c + 0.5);
      if (k === "forest") {
        ctx.fillStyle = "#3d6436";
        ctx.beginPath();
        ctx.arc(px(x) + c * 0.5, py(y) + c * 0.45, c * 0.28, 0, Math.PI * 2);
        ctx.fill();
      } else if (k === "house") {
        ctx.fillStyle = "#e9dcc6";
        ctx.fillRect(px(x) + c * 0.2, py(y) + c * 0.45, c * 0.6, c * 0.4);
        ctx.fillStyle = "#9c3f2e";
        ctx.beginPath();
        ctx.moveTo(px(x) + c * 0.12, py(y) + c * 0.48);
        ctx.lineTo(px(x) + c * 0.5, py(y) + c * 0.15);
        ctx.lineTo(px(x) + c * 0.88, py(y) + c * 0.48);
        ctx.fill();
      } else if (k === "debris") {
        ctx.strokeStyle = "#5b4330";
        ctx.lineWidth = Math.max(1.5, c * 0.12);
        ctx.beginPath();
        ctx.moveTo(px(x) + c * 0.2, py(y) + c * 0.25);
        ctx.lineTo(px(x) + c * 0.8, py(y) + c * 0.75);
        ctx.moveTo(px(x) + c * 0.75, py(y) + c * 0.2);
        ctx.lineTo(px(x) + c * 0.25, py(y) + c * 0.8);
        ctx.stroke();
      } else if (k === "firebreak") {
        ctx.strokeStyle = "#6b5c3e";
        ctx.lineWidth = 1;
        for (let i = 0.2; i < 1; i += 0.3) {
          ctx.beginPath();
          ctx.moveTo(px(x), py(y) + c * i);
          ctx.lineTo(px(x) + c, py(y) + c * i);
          ctx.stroke();
        }
      } else if (k === "station") {
        ctx.fillStyle = "#d9463b";
        ctx.fillRect(px(x) + c * 0.15, py(y) + c * 0.15, c * 0.7, c * 0.7);
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.floor(c * 0.5)}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("+", px(x) + c / 2, py(y) + c / 2 + 1);
      } else if (k === "bridge") {
        ctx.strokeStyle = "#5e4428";
        ctx.lineWidth = 1;
        for (let i = 0.2; i < 1; i += 0.25) {
          ctx.beginPath();
          ctx.moveTo(px(x) + c * i, py(y));
          ctx.lineTo(px(x) + c * i, py(y) + c);
          ctx.stroke();
        }
      }
    }
  }

  // Fires, flickering by intensity.
  for (const f of cur.fires) {
    const [x, y] = f.pos;
    const flick = 0.85 + 0.15 * Math.sin(d.t / 90 + x * 7.1 + y * 3.3);
    const colors = ["", "rgba(255,196,64,0.85)", "rgba(255,120,30,0.9)", "rgba(220,40,20,0.95)"];
    ctx.fillStyle = colors[f.intensity]!;
    ctx.fillRect(px(x), py(y), c + 0.5, c + 0.5);
    ctx.fillStyle = `rgba(255,240,180,${0.55 * flick})`;
    ctx.beginPath();
    ctx.moveTo(px(x) + c * 0.5, py(y) + c * (0.18 + 0.08 * (1 - flick)));
    ctx.quadraticCurveTo(px(x) + c * 0.85, py(y) + c * 0.7, px(x) + c * 0.5, py(y) + c * 0.85);
    ctx.quadraticCurveTo(px(x) + c * 0.15, py(y) + c * 0.7, px(x) + c * 0.5, py(y) + c * 0.18);
    ctx.fill();
    if (f.intensity === 3) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(px(x) + 1, py(y) + 1, c - 2, c - 2);
    }
  }

  // Fog of war: tiles the team cannot see right now.
  const vis = teamVision(cur);
  ctx.fillStyle = "rgba(10,12,20,0.42)";
  for (let i = 0; i < S * S; i++) {
    if (!vis.has(i)) ctx.fillRect(px(i % S), py(Math.floor(i / S)), c + 0.5, c + 0.5);
  }

  // Civilians with countdown rings.
  for (const cv of cur.civilians) {
    if (cv.status !== "waiting") continue;
    const [cx, cy] = center(cv.pos);
    const total = Math.max(1, cv.deadline - cv.appeared);
    const left = Math.max(0, cv.deadline - cur.tick) / total;
    ctx.fillStyle = "rgba(27,30,43,0.55)";
    ctx.beginPath();
    ctx.arc(cx, cy, c * 0.34, 0, Math.PI * 2);
    ctx.fill();
    drawIcon(ctx, "civilian", cx, cy, c * 0.62, "#fff");
    ctx.strokeStyle = left > 0.4 ? "#7CFC9A" : left > 0.2 ? "#ffd166" : "#ff4d6d";
    ctx.lineWidth = Math.max(2, c * 0.1);
    ctx.beginPath();
    ctx.arc(cx, cy, c * 0.46, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.stroke();
  }

  const hq: Vec = [g.x + g.size - c * 1.1, g.y + c * 1.1];
  if (d.showHq) {
    ctx.fillStyle = "rgba(20,24,36,0.85)";
    ctx.strokeStyle = d.selected === HQ_ID ? "#fff" : HQ_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(hq[0] - c * 0.9, hq[1] - c * 0.7, c * 1.8, c * 1.4, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = HQ_COLOR;
    ctx.font = `900 ${Math.max(9, Math.round(c * 0.48))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("HQ", hq[0], hq[1] + c * 0.02);
  }

  const posOf = (id: string): Vec | null => {
    if (id === HQ_ID) return hq;
    const p = agentPos(cur, d.next, d.alpha, id);
    return p ? center(p) : null;
  };

  // Each agent's current order: a dashed line in its role colour to the target, red when blocked.
  if (d.orderLines) {
    for (const a of cur.agents) {
      if (a.order_status !== "active" && a.order_status !== "blocked") continue;
      const target = orderTarget(cur, a);
      const from = posOf(a.id);
      if (!target || !from) continue;
      const to = center(target);
      const blocked = a.order_status === "blocked";
      ctx.strokeStyle = blocked ? "rgba(255,77,109,0.9)" : withAlpha(ROLE_COLOR[a.role], 0.75);
      ctx.setLineDash([Math.max(2, c * 0.2), Math.max(3, c * 0.25)]);
      ctx.lineWidth = Math.max(1, c * 0.07);
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeRect(to[0] - c * 0.3, to[1] - c * 0.3, c * 0.6, c * 0.6);
    }
  }

  // Messages: a line per recipient with a dot travelling from sender to recipient.
  for (const m of d.messages) {
    const from = posOf(m.from);
    if (!from) continue;
    for (const r of m.to) {
      const to = posOf(r);
      if (!to) continue;
      const delivered = m.delivered.get(r);
      const travel = delivered !== undefined ? Math.max(250, delivered - m.t_ms) : Math.max(250, d.holdMs);
      const p = Math.min(1, (d.t - m.t_ms) / travel);
      const since = delivered !== undefined ? d.t - delivered : 0;
      const fade = delivered !== undefined && since > 0 ? Math.max(0, 1 - since / d.holdMs) : 1;
      ctx.strokeStyle = `rgba(199,146,234,${0.55 * fade})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
      ctx.fillStyle = `rgba(240,220,255,${fade})`;
      ctx.beginPath();
      ctx.arc(lerp(from[0], to[0], p), lerp(from[1], to[1], p), Math.max(2.5, c * 0.16), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Agents.
  const hits: HitTarget[] = [];
  for (const a of cur.agents) drawAgent(ctx, a, posOf(a.id)!, c, a.id === d.selected, hits);
  if (d.showHq) hits.push({ id: HQ_ID, x: hq[0], y: hq[1], r: c });

  // Score pop-ups name the event, rise from the tile and fade within about a tick (SPEC §9.5).
  // Oldest first, so a later label that would overlap an earlier one stacks above it.
  const fontPx = Math.max(10, Math.round(c * 0.6));
  ctx.font = `800 ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, c * 0.14);
  ctx.strokeStyle = "rgba(10,12,20,0.85)";
  const labels = [...d.popups].reverse().flatMap(({ entry, age }) => {
    if (!entry.pos) return [];
    const [x, y] = center(entry.pos);
    const text = SCORE_LABEL[entry.type];
    const half = ctx.measureText(text).width / 2 + 2;
    // Clamp to the board so labels near an edge stay readable.
    const cx = Math.min(Math.max(x, g.x + half), g.x + g.size - half);
    return [{ entry, age, text, x: cx, half, y: y - c * 0.4 - age * c * 1.4 }];
  });
  const ys = stackLabels(labels, fontPx + 2);
  labels.forEach(({ entry, age, text, x: cx }, i) => {
    const ty = ys[i]!;
    ctx.globalAlpha = Math.max(0, 1 - age);
    ctx.strokeText(text, cx, ty);
    ctx.fillStyle = entry.delta > 0 ? "#7cfc9a" : "#ff4d6d";
    ctx.fillText(text, cx, ty);
    ctx.globalAlpha = 1;
  });

  // Hover label: the agent's current order.
  const hovered = d.hover ? cur.agents.find((a) => a.id === d.hover) : undefined;
  if (hovered) {
    const p = posOf(hovered.id)!;
    const text = `${hovered.id}: ${formatOrder(hovered.order) ?? "no order"}${
      hovered.order_status === "blocked"
        ? ` ⛔ ${hovered.block_reason ?? "blocked"}`
        : hovered.order_status === "done"
          ? " ✓ done"
          : ""
    }`;
    ctx.font = `${Math.max(11, Math.round(c * 0.55))}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + c * 0.6;
    const h = Math.max(16, c * 0.9);
    const lx = Math.min(Math.max(g.x + 2, p[0] - w / 2), g.x + g.size - w - 2);
    const ly = p[1] - c * 0.6 - h < g.y ? p[1] + c * 0.6 : p[1] - c * 0.6 - h;
    ctx.fillStyle = "rgba(20,24,36,0.92)";
    ctx.strokeStyle = hovered.order_status === "blocked" ? "#ff4d6d" : ROLE_COLOR[hovered.role];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(lx, ly, w, h, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e8e9f0";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(text, lx + c * 0.3, ly + h / 2 + 1);
  }

  ctx.restore();
  return hits;
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  a: AgentState,
  p: Vec,
  c: number,
  selected: boolean,
  hits: HitTarget[],
) {
  // Larger on small boards so the icon still reads at ~11 px cells (SPEC §9.3).
  const r = c * (c < 20 ? 0.5 : 0.4);
  const look = agentLook(a.id, a.role);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.arc(p[0] + 1, p[1] + 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = look.color;
  ctx.strokeStyle = selected ? "#fff" : a.order_status === "blocked" ? "#ff4d6d" : "#1b1e2b";
  ctx.lineWidth = selected || a.order_status === "blocked" ? Math.max(2, c * 0.12) : Math.max(1.5, c * 0.08);
  ctx.beginPath();
  ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  drawIcon(ctx, look.icon, p[0], p[1], r * 1.5, "#1b1e2b");
  if (look.badge) drawBadge(ctx, p[0] + r * 0.78, p[1] - r * 0.78, Math.max(4, r * 0.42), look.badge);
  if (a.role === "firefighter") {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i < a.water ? "#4d97c7" : "rgba(0,0,0,0.4)";
      ctx.fillRect(p[0] - r + i * (r * 0.7), p[1] + r + 1, r * 0.55, Math.max(2, c * 0.12));
    }
  }
  hits.push({ id: a.id, x: p[0], y: p[1], r: r * 1.3 });
}

/** The tile an order points at, or null (refill, wait). */
export function orderTarget(s: WorldState, a: AgentState): Vec | null {
  const o = a.order;
  if (!o) return null;
  if ("x" in o) return [o.x, o.y];
  if (o.type === "rescue") return s.civilians.find((cv) => cv.id === o.civilian_id)?.pos ?? null;
  return null;
}

function withAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
