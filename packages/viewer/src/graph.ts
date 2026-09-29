import type { Role, Vec } from "@firebreak/engine";
import { drawBadge, drawIcon } from "./icons";
import { HQ_COLOR, HQ_ID, agentLook } from "./render";
import { splitEdge, type Edges } from "./timeline";

/** Pentagon order, clockwise from the top; the same on every team so shapes compare (SPEC §9.1). */
const RING = ["scout", "ff1", "ff2", "engineer", "rescuer"];
const GREY: [number, number, number] = [107, 112, 134];
const RED: [number, number, number] = [255, 77, 109];

export interface GraphNode {
  id: string;
  role: Role | null;
}

export interface GraphInput {
  nodes: GraphNode[];
  edges: Edges;
  /** Shared across every team on screen, so the same width means the same traffic. */
  maxEdge: number;
  maxNode: number;
  /** Edge key → 0..1, how recently a message was sent on it. */
  flash: Map<string, number>;
  hover: string | null;
  selected: string | null;
  note: string | null;
  legend: string;
}

export interface GraphHits {
  nodes: { id: string; x: number; y: number; r: number }[];
  edges: { key: string; pts: Vec[] }[];
}

/** Grey → red and hairline → 8 px on a sqrt scale, from 1 message up to `max`. */
export function edgeScale(count: number, max: number): number {
  return max > 1 ? Math.max(0, (Math.sqrt(count) - 1) / (Math.sqrt(max) - 1)) : 0;
}

function mix(f: number, alpha: number): string {
  const c = GREY.map((g, i) => Math.round(g + (RED[i]! - g) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

export function nodeTraffic(edges: Edges): Map<string, number> {
  const out = new Map<string, number>();
  for (const [k, n] of edges) {
    const [a, b] = splitEdge(k);
    out.set(a, (out.get(a) ?? 0) + n);
    if (b !== a) out.set(b, (out.get(b) ?? 0) + n);
  }
  return out;
}

/** Fixed positions: the ring agents on a pentagon, HQ in the centre, anything else on an outer ring. */
function layoutNodes(nodes: GraphNode[], cx: number, cy: number, R: number): Map<string, Vec> {
  const pos = new Map<string, Vec>();
  const extra: string[] = [];
  for (const n of nodes) {
    const i = RING.indexOf(n.id);
    if (n.id === HQ_ID) pos.set(n.id, [cx, cy]);
    else if (i >= 0) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / RING.length;
      pos.set(n.id, [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
    } else extra.push(n.id);
  }
  extra.forEach((id, i) => {
    const a = -Math.PI / 2 + Math.PI / RING.length + (i * 2 * Math.PI) / Math.max(RING.length, extra.length);
    pos.set(id, [cx + R * 1.15 * Math.cos(a), cy + R * 1.15 * Math.sin(a)]);
  });
  return pos;
}

/** Draw one team's communication graph into a square of side `size` (SPEC §9.1). */
export function drawGraph(
  ctx: CanvasRenderingContext2D,
  size: number,
  dpr: number,
  g: GraphInput,
): GraphHits {
  const hits: GraphHits = { nodes: [], edges: [] };
  ctx.save();
  ctx.fillStyle = "#151824";
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size * 0.47;
  const pos = layoutNodes(g.nodes, cx, cy, size * 0.34);
  const traffic = nodeTraffic(g.edges);
  const radius = new Map<string, number>();
  for (const n of g.nodes) {
    const t = traffic.get(n.id) ?? 0;
    radius.set(n.id, size * (0.05 + 0.035 * (g.maxNode ? Math.sqrt(t / g.maxNode) : 0)));
  }

  // Edges, lightest first so heavy ones sit on top.
  const sorted = [...g.edges].sort((a, b) => a[1] - b[1]);
  for (const [key, count] of sorted) {
    const [from, to] = splitEdge(key);
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b || from === to) continue;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dist = Math.hypot(dx, dy) || 1;
    // Bend to the right of the direction of travel, so A→B and B→A are two separate curves.
    const ctrl: Vec = [
      (a[0] + b[0]) / 2 - (dy / dist) * dist * 0.14,
      (a[1] + b[1]) / 2 + (dx / dist) * dist * 0.14,
    ];
    const toward = (p: Vec, q: Vec, d: number): Vec => {
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      return [p[0] + ((q[0] - p[0]) / l) * d, p[1] + ((q[1] - p[1]) / l) * d];
    };
    const f = edgeScale(count, g.maxEdge);
    const width = (1 + 7 * f) * dpr;
    const head = 5 * dpr + width * 1.4;
    const start = toward(a, ctrl, radius.get(from)! + 2 * dpr);
    const tip = toward(b, ctrl, radius.get(to)! + 2 * dpr);
    const end = toward(tip, ctrl, head * 0.8);
    const hover = g.hover === key;
    const flash = g.flash.get(key) ?? 0;
    if (flash > 0) {
      ctx.strokeStyle = `rgba(240,220,255,${0.7 * flash})`;
      ctx.lineWidth = width + 6 * dpr * flash;
      ctx.beginPath();
      ctx.moveTo(start[0], start[1]);
      ctx.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
      ctx.stroke();
    }
    const color = hover ? "#ffffff" : mix(f, 0.92);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(start[0], start[1]);
    ctx.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
    ctx.stroke();
    // Arrowhead along the curve's end tangent.
    const ang = Math.atan2(tip[1] - ctrl[1], tip[0] - ctrl[0]);
    const spread = 0.45;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(tip[0], tip[1]);
    ctx.lineTo(tip[0] - head * Math.cos(ang - spread), tip[1] - head * Math.sin(ang - spread));
    ctx.lineTo(tip[0] - head * Math.cos(ang + spread), tip[1] - head * Math.sin(ang + spread));
    ctx.closePath();
    ctx.fill();
    const pts: Vec[] = [];
    for (let i = 0; i <= 16; i++) {
      const s = i / 16;
      pts.push([
        (1 - s) ** 2 * start[0] + 2 * (1 - s) * s * ctrl[0] + s * s * tip[0],
        (1 - s) ** 2 * start[1] + 2 * (1 - s) * s * ctrl[1] + s * s * tip[1],
      ]);
    }
    hits.edges.push({ key, pts });
  }

  // Nodes.
  for (const n of g.nodes) {
    const p = pos.get(n.id)!;
    const r = radius.get(n.id)!;
    const look = agentLook(n.id, n.role);
    const hq = n.id === HQ_ID;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(p[0] + 1, p[1] + 2, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hq ? "#1b1e2b" : look.color;
    ctx.strokeStyle = n.id === g.selected ? "#fff" : hq ? HQ_COLOR : "#1b1e2b";
    ctx.lineWidth = (n.id === g.selected ? 3 : 2) * dpr;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    drawIcon(ctx, look.icon, p[0], p[1], r * 1.45, hq ? HQ_COLOR : "#1b1e2b");
    if (look.badge) drawBadge(ctx, p[0] + r * 0.75, p[1] - r * 0.75, r * 0.38, look.badge);
    hits.nodes.push({ id: n.id, x: p[0], y: p[1], r: r * 1.2 });
  }
  // Labels last, on a backdrop, so edges never run through them.
  ctx.font = `${Math.round(11 * dpr)}px system-ui`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const n of g.nodes) {
    const p = pos.get(n.id)!;
    const t = traffic.get(n.id) ?? 0;
    const label = `${n.id === HQ_ID ? "HQ" : n.id}${t ? ` · ${t}` : ""}`;
    const w = ctx.measureText(label).width + 8 * dpr;
    const y = p[1] + radius.get(n.id)! + 10 * dpr;
    ctx.fillStyle = "rgba(21,24,36,0.85)";
    ctx.beginPath();
    ctx.roundRect(p[0] - w / 2, y - 7 * dpr, w, 14 * dpr, 4 * dpr);
    ctx.fill();
    ctx.fillStyle = "#9097b1";
    ctx.fillText(label, p[0], y);
  }

  // Note and legend.
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (g.note) {
    ctx.fillStyle = "#9097b1";
    ctx.font = `${Math.round(13 * dpr)}px system-ui`;
    // Two short lines fit inside the pentagon even on a small card.
    const words = g.note.split(" ");
    const half = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, half).join(" "), cx, cy - 8 * dpr);
    ctx.fillText(words.slice(half).join(" "), cx, cy + 8 * dpr);
  }
  const ly = size - 14 * dpr;
  const lx = 12 * dpr;
  const len = 26 * dpr;
  ctx.lineCap = "round";
  ctx.strokeStyle = mix(0, 0.92);
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx + len, ly);
  ctx.stroke();
  ctx.font = `${Math.round(11 * dpr)}px system-ui`;
  ctx.fillStyle = "#9097b1";
  ctx.textAlign = "left";
  ctx.fillText("1", lx + len + 4 * dpr, ly);
  const lx2 = lx + len + 18 * dpr;
  if (g.maxEdge > 1) {
    ctx.strokeStyle = mix(1, 0.92);
    ctx.lineWidth = 8 * dpr;
    ctx.beginPath();
    ctx.moveTo(lx2, ly);
    ctx.lineTo(lx2 + len, ly);
    ctx.stroke();
    ctx.fillText(`${g.maxEdge} msgs · ${g.legend}`, lx2 + len + 8 * dpr, ly);
  } else ctx.fillText(`msg · ${g.legend}`, lx2 - 6 * dpr, ly);
  ctx.restore();
  return hits;
}

/** The edge or node under (x, y), in canvas pixels. */
export function hitGraph(h: GraphHits, x: number, y: number, tol: number): { node?: string; edge?: string } {
  const node = h.nodes.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 <= n.r * n.r);
  if (node) return { node: node.id };
  let best: { key: string; d: number } | null = null;
  for (const e of h.edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const d = segDist(e.pts[i - 1]!, e.pts[i]!, x, y);
      if (d <= tol && (!best || d < best.d)) best = { key: e.key, d };
    }
  }
  return best ? { edge: best.key } : {};
}

function segDist(a: Vec, b: Vec, x: number, y: number): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const s = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return Math.hypot(a[0] + s * dx - x, a[1] + s * dy - y);
}
