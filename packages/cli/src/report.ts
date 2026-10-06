import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeMetrics, summarize, type MatchMetrics, type WorldMetrics } from "@firebreak/recorder";
import { RUNS_DIR } from "./run";

/** Files of the most recent batch, or null if there is none. */
function latestBatch(): string[] | null {
  if (!existsSync(RUNS_DIR)) return null;
  const manifests = readdirSync(RUNS_DIR)
    .filter((f) => f.startsWith("batch-") && f.endsWith(".json"))
    .map((f) => join(RUNS_DIR, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  // The newest batch with at least one completed match (a batch stopped by a usage limit may have none).
  for (const path of manifests) {
    const m = JSON.parse(readFileSync(path, "utf8")) as { files: string[] };
    const files = m.files.map((f) => join(RUNS_DIR, f)).filter((f) => existsSync(f));
    if (files.some((f) => summarize(f).status === "completed")) return files;
  }
  return null;
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function stats(xs: number[]): { mean: number; sd: number; n: number } {
  const n = xs.length;
  const mean = n ? xs.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, sd, n };
}

const METRICS: {
  key: keyof WorldMetrics;
  label: string;
  fmt: (v: number) => string;
  better: "high" | "low" | null;
}[] = [
  { key: "score", label: "Score", fmt: (v) => v.toFixed(1), better: "high" },
  { key: "cost_usd", label: "Cost ($)", fmt: (v) => v.toFixed(3), better: "low" },
  { key: "llm_calls", label: "LLM calls", fmt: (v) => v.toFixed(0), better: null },
  { key: "evacuated", label: "Civilians evacuated", fmt: (v) => v.toFixed(1), better: "high" },
  { key: "civilians_lost", label: "Civilians lost", fmt: (v) => v.toFixed(1), better: "low" },
  { key: "houses_standing", label: "Houses standing", fmt: (v) => v.toFixed(1), better: "high" },
  { key: "messages", label: "Messages", fmt: (v) => v.toFixed(0), better: null },
  {
    key: "latency_median_ms",
    label: "Message latency, median (ms)",
    fmt: (v) => v.toFixed(0),
    better: "low",
  },
  { key: "latency_p90_ms", label: "Message latency, p90 (ms)", fmt: (v) => v.toFixed(0), better: "low" },
  { key: "idle_agent_ticks", label: "Idle agent-ticks", fmt: (v) => v.toFixed(0), better: "low" },
  { key: "stale_actions", label: "Stale actions", fmt: (v) => v.toFixed(1), better: "low" },
  {
    key: "missed_joint",
    label: "Uncovered intensity-3 fire-ticks",
    fmt: (v) => v.toFixed(1),
    better: "low",
  },
  { key: "duplicate_work", label: "Duplicate work (agent-ticks)", fmt: (v) => v.toFixed(1), better: "low" },
  { key: "noise_ratio", label: "Noise ratio", fmt: (v) => `${(v * 100).toFixed(0)}%`, better: "low" },
  { key: "context_avg_tokens", label: "Prompt size, avg (tokens)", fmt: (v) => v.toFixed(0), better: "low" },
  {
    key: "orchestrator_queue_median_ms",
    label: "Orchestrator queue, median (ms)",
    fmt: (v) => v.toFixed(0),
    better: "low",
  },
  {
    key: "comm_concentration",
    label: "Communication concentration",
    fmt: (v) => `${(v * 100).toFixed(0)}%`,
    better: null,
  },
  {
    key: "forecast_shared_lead_ticks",
    label: "Forecast lead shared (ticks)",
    fmt: (v) => v.toFixed(1),
    better: "high",
  },
];

const NODE_ORDER = ["scout", "ff1", "ff2", "engineer", "rescuer", "orchestrator"];
const NODE_LABEL: Record<string, string> = { orchestrator: "HQ" };

/** Mean messages per match for each sender → recipient pair of one team (SPEC §10). */
function matrixTable(matches: MatchMetrics[], team: string, label: string): string {
  const worlds = matches.flatMap((m) => m.worlds.filter((w) => w.team === team));
  const sums = new Map<string, number>();
  const nodes = new Set<string>();
  for (const w of worlds)
    for (const e of w.comm_matrix) {
      sums.set(`${e.from}>${e.to}`, (sums.get(`${e.from}>${e.to}`) ?? 0) + e.count);
      nodes.add(e.from).add(e.to);
    }
  if (!nodes.size) return `<h3>${esc(label)}</h3><p class="muted">No messages on this team.</p>`;
  const order = [...nodes].sort(
    (a, b) => (NODE_ORDER.indexOf(a) + 1 || 99) - (NODE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
  );
  const name = (n: string) => esc(NODE_LABEL[n] ?? n);
  const max = Math.max(...sums.values()) / worlds.length;
  const body = order
    .map(
      (from) =>
        `<tr><th>${name(from)}</th>${order
          .map((to) => {
            const v = (sums.get(`${from}>${to}`) ?? 0) / worlds.length;
            return v
              ? `<td style="background:rgba(255,77,109,${((0.6 * v) / max).toFixed(2)})">${v.toFixed(1)}</td>`
              : `<td class="muted">·</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<h3>${esc(label)}</h3><div class="wrap"><table class="matrix"><thead><tr><th>from ↓ to →</th>${order.map((n) => `<th>${name(n)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function writeReport(files?: string[], out?: string): string {
  const list =
    files ??
    latestBatch() ??
    readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith(".sqlite"))
      .map((f) => join(RUNS_DIR, f));
  const matches: MatchMetrics[] = [];
  for (const f of list) {
    try {
      matches.push(computeMetrics(f));
    } catch (e) {
      console.warn(`skipping ${f}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const scored = matches.filter((m) => m.status === "completed");
  const teams = [...new Set(scored.flatMap((m) => m.worlds.map((w) => w.team)))];
  const labels = new Map(scored.flatMap((m) => m.worlds.map((w) => [w.team, w.label] as const)));
  const backends = [...new Set(scored.map((m) => m.llm))];

  const rows = METRICS.map((m) => {
    const cells = teams.map((t) => {
      const xs = scored
        .flatMap((x) => x.worlds.filter((w) => w.team === t).map((w) => w[m.key] as number | null))
        .filter((v): v is number => v !== null && Number.isFinite(v));
      return xs.length ? stats(xs) : null;
    });
    const means = cells.map((c) => c?.mean ?? NaN).filter(Number.isFinite);
    const best = m.better === "high" ? Math.max(...means) : m.better === "low" ? Math.min(...means) : NaN;
    return `<tr><th>${m.label}</th>${cells
      .map((c) =>
        c
          ? `<td class="${c.mean === best && means.length > 1 ? "best" : ""}">${m.fmt(c.mean)}${c.n > 1 ? ` <span>± ${m.fmt(c.sd)}</span>` : ""}</td>`
          : "<td>–</td>",
      )
      .join("")}</tr>`;
  }).join("");

  const perSeed = scored
    .map(
      (m) =>
        `<tr><td>${m.seed}</td>${teams.map((t) => `<td>${m.worlds.find((w) => w.team === t)?.score ?? "–"}</td>`).join("")}<td class="muted">${esc(m.match_id)}</td></tr>`,
    )
    .join("");
  const skipped = matches.filter((m) => m.status !== "completed");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Firebreak report</title><style>
:root{--bg:#fff;--fg:#1b1e2b;--muted:#6b7086;--line:#e3e5ee;--best:#e8f7ec;--accent:#e2551b}
@media (prefers-color-scheme: dark){:root{--bg:#11131c;--fg:#e8e9f0;--muted:#9097b1;--line:#2e3348;--best:#15321f;--accent:#ff7a3d}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,sans-serif;max-width:1100px;margin:0 auto;padding:24px 16px}
h1{margin:0}h1 b{color:var(--accent)}.muted,td span{color:var(--muted)}td span{font-size:12px}
.wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}thead th{font-weight:700}td.best{background:var(--best);font-weight:700}
table.matrix{width:auto}
</style></head><body>
<h1>FIRE<b>BREAK</b> report</h1>
<p class="muted">${scored.length} completed match${scored.length === 1 ? "" : "es"}${skipped.length ? `, ${skipped.length} aborted and excluded` : ""} · LLM ${esc(backends.join(", ") || "none")} · generated ${new Date().toLocaleString()}</p>
${backends.length > 1 ? `<p><b>Warning:</b> these matches used different LLM backends; compare within one backend only.</p>` : ""}
<h2>Summary (mean ± standard deviation across recordings)</h2>
<div class="wrap"><table><thead><tr><th>Metric</th>${teams.map((t) => `<th>${esc(labels.get(t) ?? t)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">Relative score = (mean team − mean no-communication) / (mean perfect − mean no-communication): the share of the possible coordination gain a team captured. It is only meaningful when the perfect team clearly beats the no-communication team. Highlighted cells are the best mean per metric.</p>
<h2>Scores per recording</h2>
<div class="wrap"><table><thead><tr><th>Seed</th>${teams.map((t) => `<th>${esc(labels.get(t) ?? t)}</th>`).join("")}<th>Match</th></tr></thead><tbody>${perSeed}</tbody></table></div>
<h2>Communication matrix (mean messages per match)</h2>
<p class="muted">Messages per sender → recipient pair. A message to several recipients counts once for each; the orchestrator's spawn briefs count. Concentration is the share of all this traffic on the busiest agent's edges (100% is a pure star). The viewer's graph view draws the same numbers.</p>
${teams.map((t) => matrixTable(scored, t, labels.get(t) ?? t)).join("\n")}
${skipped.length ? `<h2>Excluded</h2><ul>${skipped.map((m) => `<li>${esc(m.match_id)}: ${esc(m.abort_reason ?? m.status)}</li>`).join("")}</ul>` : ""}
</body></html>`;
  const target = out ?? join(RUNS_DIR, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.html`);
  writeFileSync(target, html);
  return target;
}
