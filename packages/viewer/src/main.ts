import type { MatchHeader, RecordingBundle, StreamFrame } from "@firebreak/engine";
import type { FeedMode } from "./feed";
import { Player, type View } from "./player";
import { renderRulesPage, rulesHref } from "./reference";
import "./style.css";
import { applyViewerTheme, createThemeToggle, loadViewerTheme } from "./theme";
import { Timeline } from "./timeline";

declare global {
  interface Window {
    __FIREBREAK_BUNDLE__?: RecordingBundle;
  }
}

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
applyViewerTheme(loadViewerTheme());
const view = {
  ...(params.has("view") ? { view: params.get("view") as View } : {}),
  ...(params.has("feed") ? { feed: params.get("feed") as FeedMode } : {}),
};

function play(bundle: RecordingBundle, name?: string, commentaryError?: string) {
  const tl = new Timeline(bundle.header);
  for (const f of bundle.frames) tl.add(f);
  const player = new Player(app, tl, {
    mode: "replay",
    ...(params.has("t") ? { startAt: Number(params.get("t")) } : {}),
    ...(params.has("speed") ? { speed: Number(params.get("speed")) } : {}),
    paused: params.has("paused"),
    ...view,
    ...(name ? { recordingName: name, fetchPrompt: (id: string) => fetchPrompt(name, id) } : {}),
    ...(commentaryError ? { commentaryError } : {}),
  });
  return { tl, player };
}

async function generateMissingCommentary(rec: string, tl: Timeline, player: Player) {
  try {
    const generated = await fetch(`/api/recordings/${encodeURIComponent(rec)}/commentary`, {
      method: "POST",
    });
    if (!generated.ok) {
      const body = (await generated.json()) as { error?: string };
      throw new Error(body.error ?? `HTTP ${generated.status}`);
    }
    for (const frame of (await generated.json()) as StreamFrame[]) tl.add(frame);
    player.setCommentaryMessage();
    player.onFrames();
  } catch (e) {
    player.setCommentaryMessage(e instanceof Error ? e.message : String(e));
  }
}

async function fetchPrompt(rec: string, id: string): Promise<string | null> {
  const r = await fetch(`/api/recordings/${encodeURIComponent(rec)}/prompt/${encodeURIComponent(id)}`);
  return r.ok ? r.text() : null;
}

function live() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  let tl: Timeline | null = null;
  let player: Player | null = null;
  const pending: StreamFrame[] = [];
  app.innerHTML = `<div class="index"><h1>Waiting for a live match…</h1><p class="meta">Start one with <code>pnpm firebreak run --live</code>.</p></div>`;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as
      { type: "header"; header: MatchHeader } | { type: "frames"; frames: StreamFrame[] };
    if (msg.type === "header") {
      tl = new Timeline(msg.header);
      for (const f of pending.splice(0)) tl.add(f);
      player = new Player(app, tl, { mode: "live", fetchPrompt: async () => null, ...view });
      return;
    }
    if (!tl) {
      pending.push(...msg.frames);
      return;
    }
    for (const f of msg.frames) tl.add(f);
    player?.onFrames();
  };
  ws.onclose = () => setTimeout(live, 2000);
}

async function index() {
  app.innerHTML = `<div class="index"><div class="index-actions" id="index-actions"></div><h1>FIRE<span style="color:var(--accent)">BREAK</span></h1>
    <div class="meta">Teams of AI agents fight the same wildfire. The only difference is how they communicate.</div>
    <p class="index-nav"><a href="${rulesHref()}">Rules and map legend</a></p>
    <div id="live-slot"></div><div id="list" class="empty">Loading recordings…</div></div>`;
  document.getElementById("index-actions")!.append(createThemeToggle());
  try {
    const status = (await (await fetch("/api/live/status")).json()) as {
      running: boolean;
      match_id?: string;
    };
    if (status.running) {
      document.getElementById("live-slot")!.innerHTML =
        `<p><span class="badge live">LIVE</span> <a href="?live">Watch ${status.match_id}</a></p>`;
    }
  } catch {
    // no server-side live support
  }
  const list = document.getElementById("list")!;
  try {
    const recs = (await (await fetch("/api/recordings")).json()) as {
      file: string;
      created_at: string;
      seed: number;
      status: string;
      abort_reason: string | null;
      teams: { team: string; label: string; score: number | null; cost_usd: number | null }[];
    }[];
    if (!recs.length) {
      list.textContent = "No recordings yet. Run `pnpm firebreak run` to create one.";
      return;
    }
    list.className = "";
    list.innerHTML = `<table><thead><tr><th>Recorded</th><th>Seed</th><th>Status</th><th>Scores</th><th></th></tr></thead><tbody>${recs
      .map(
        (
          r,
        ) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.seed}</td><td>${r.status}${r.abort_reason ? ` (${r.abort_reason})` : ""}</td>
      <td>${r.teams.map((t) => `${t.label}: <b>${t.score ?? "–"}</b>`).join(" · ")}</td>
      <td><a href="?rec=${encodeURIComponent(r.file)}">Replay</a></td></tr>`,
      )
      .join("")}</tbody></table>`;
  } catch (e) {
    list.textContent = `Could not load recordings: ${e}`;
  }
}

async function boot() {
  if (params.has("rules")) return renderRulesPage(app);
  if (window.__FIREBREAK_BUNDLE__) return play(window.__FIREBREAK_BUNDLE__);
  const rec = params.get("rec");
  if (rec) {
    app.innerHTML = `<div class="index"><h1>Loading ${rec}…</h1></div>`;
    const r = await fetch(`/api/recordings/${encodeURIComponent(rec)}`);
    if (!r.ok) {
      app.innerHTML = `<div class="index"><h1>Recording not found</h1><p><a href="/">Back</a></p></div>`;
      return;
    }
    const bundle = (await r.json()) as RecordingBundle;
    if (!bundle.frames.some((f) => f.kind === "commentary")) {
      const { tl, player } = play(
        bundle,
        rec,
        "Generating and saving this broadcast in the background. The replay is ready to watch.",
      );
      void generateMissingCommentary(rec, tl, player);
      return;
    }
    return play(bundle, rec);
  }
  if (params.has("live")) return live();
  return index();
}

void boot();
