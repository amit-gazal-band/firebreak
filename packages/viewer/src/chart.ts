import type { ScoreEntry } from "./timeline";

/** Line colour per team in the shared score chart; the card header shows the same swatch (SPEC §9.5). */
const TEAM_COLOR: Record<string, string> = {
  none: "#9097b1",
  perfect: "#f5d547",
  band: "#ff7a3d",
  subagents: "#c792ea",
  slack: "#5bc0eb",
  linear: "#7cfc9a",
};
const FALLBACK = ["#5bc0eb", "#7cfc9a", "#ff9f43", "#f7f7f2", "#ff4d6d"];

export function teamColor(team: string, index: number): string {
  return TEAM_COLOR[team.replace(/^bots-/, "")] ?? FALLBACK[index % FALLBACK.length]!;
}

export interface ChartLine {
  color: string;
  /** Score per tick, from tick 0 up to the tick shown. */
  scores: number[];
  /** Scoring events to mark with dots (per-card chart only). */
  events?: ScoreEntry[];
}

export interface ChartInput {
  lines: ChartLine[];
  /** Ticks in the match, so the x-axis doesn't rescale during playback. */
  ticks: number;
  /** Shared y range, from the whole match so lines don't jump. */
  min: number;
  max: number;
  /** Current position in ticks (fractional), drawn as a cursor. */
  at: number;
  dpr: number;
}

/** Score over ticks (SPEC §9.5): one line per team on a shared y-axis, with a zero line and a cursor. */
export function drawChart(cv: HTMLCanvasElement, g: ChartInput): { x: (tick: number) => number } {
  const ctx = cv.getContext("2d")!;
  const W = cv.width;
  const H = cv.height;
  const pad = 3 * g.dpr;
  ctx.clearRect(0, 0, W, H);
  const span = Math.max(1, g.max - g.min);
  const x = (tick: number) => pad + (tick / Math.max(1, g.ticks)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - g.min) / span) * (H - 2 * pad);
  if (g.min < 0 && g.max > 0) {
    ctx.strokeStyle = "rgba(144,151,177,0.35)";
    ctx.lineWidth = g.dpr;
    ctx.setLineDash([2 * g.dpr, 3 * g.dpr]);
    ctx.beginPath();
    ctx.moveTo(pad, y(0));
    ctx.lineTo(W - pad, y(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const l of g.lines) {
    if (!l.scores.length) continue;
    ctx.strokeStyle = l.color;
    ctx.lineWidth = 1.5 * g.dpr;
    ctx.lineJoin = "round";
    ctx.beginPath();
    l.scores.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    for (const e of l.events ?? []) {
      ctx.fillStyle = e.delta > 0 ? "#7cfc9a" : "#ff4d6d";
      ctx.beginPath();
      ctx.arc(x(e.tick), y(e.total), (Math.abs(e.delta) >= 10 ? 2.2 : 1.4) * g.dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.strokeStyle = "rgba(232,233,240,0.5)";
  ctx.lineWidth = g.dpr;
  ctx.beginPath();
  ctx.moveTo(x(g.at), 0);
  ctx.lineTo(x(g.at), H);
  ctx.stroke();
  return { x };
}
