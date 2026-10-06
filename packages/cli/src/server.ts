import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { MatchHeader, StreamFrame } from "@firebreak/engine";
import { listRecordings, openRecording, readConfig, readPrompt, type FrameSink } from "@firebreak/recorder";
import { WebSocketServer, type WebSocket } from "ws";
import { REPO_ROOT, VIEWER_DIST } from "./paths";
import { RECORDING_DIRS } from "./run";
import { ensureCommentary, loadReplayBundle, loadSavedCommentary } from "./commentary";

function newestMtime(dir: string): number {
  let max = 0;
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    max = Math.max(max, f.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return max;
}

/** Build the viewer if dist/ is missing or older than its sources. */
export function ensureViewerBuilt(): string {
  const index = join(VIEWER_DIST, "index.html");
  const src = join(REPO_ROOT, "packages/viewer/src");
  const engineSrc = join(REPO_ROOT, "packages/engine/src");
  const stale =
    !existsSync(index) || statSync(index).mtimeMs < Math.max(newestMtime(src), newestMtime(engineSrc));
  if (stale) {
    console.log("building viewer…");
    execFileSync("pnpm", ["--filter", "@firebreak/viewer", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
  }
  return index;
}

/** Broadcasts a running match to viewers over WebSocket (SPEC §8.4). */
class LiveSink implements FrameSink {
  header: MatchHeader | null = null;
  frames: StreamFrame[] = [];
  clients = new Set<WebSocket>();
  private queue: StreamFrame[] = [];
  private scheduled = false;

  begin(h: MatchHeader) {
    this.header = h;
    this.frames = [];
    for (const c of this.clients) c.send(JSON.stringify({ type: "header", header: h }));
  }

  write(f: StreamFrame) {
    this.frames.push(f);
    this.queue.push(f);
    if (!this.scheduled) {
      this.scheduled = true;
      setTimeout(() => this.flush(), 50);
    }
  }

  private flush() {
    this.scheduled = false;
    const frames = this.queue.splice(0);
    const msg = JSON.stringify({ type: "frames", frames });
    for (const c of this.clients) c.send(msg);
  }

  attach(ws: WebSocket) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    if (this.header) {
      ws.send(JSON.stringify({ type: "header", header: this.header }));
      ws.send(JSON.stringify({ type: "frames", frames: this.frames }));
    }
  }
}

function send(res: ServerResponse, code: number, body: string, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function recordingPath(name: string): string | null {
  const file = basename(decodeURIComponent(name));
  if (!file.endsWith(".sqlite")) return null;
  for (const dir of RECORDING_DIRS) if (existsSync(join(dir, file))) return join(dir, file);
  return null;
}

export async function startServer(opts: {
  port: number;
  live: boolean;
}): Promise<{ sink: LiveSink; url: string; close(): void }> {
  const indexFile = ensureViewerBuilt();
  const sink = new LiveSink();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] !== "api")
        return send(res, 200, readFileSync(indexFile, "utf8"), "text/html; charset=utf-8");
      if (parts[1] === "live" && parts[2] === "status") {
        return send(
          res,
          200,
          JSON.stringify({
            running: !!sink.header && !sink.frames.some((f) => f.kind === "end"),
            match_id: sink.header?.match_id,
          }),
        );
      }
      if (parts[1] === "recordings" && parts.length === 2)
        return send(res, 200, JSON.stringify(RECORDING_DIRS.flatMap((d) => listRecordings(d))));
      if (parts[1] === "recordings" && parts[2]) {
        const p = recordingPath(parts[2]);
        if (!p) return send(res, 404, '{"error":"not found"}');
        if (parts[3] === "commentary" && req.method === "POST") {
          void ensureCommentary(p).then(
            (frames) => send(res, 200, JSON.stringify(frames)),
            (e) => send(res, 503, JSON.stringify({ error: e instanceof Error ? e.message : String(e) })),
          );
          return;
        }
        if (parts[3] === "prompt" && parts[4]) {
          const id = decodeURIComponent(parts[4]);
          const prompt = readPrompt(p, id) ?? loadSavedCommentary(p).find((f) => f.id === id)?.prompt ?? "";
          return send(res, 200, prompt, "text/plain; charset=utf-8");
        }
        if (parts[3] === "config") {
          const db = openRecording(p);
          const cfg = readConfig(db);
          db.close();
          return send(res, 200, JSON.stringify(cfg));
        }
        return send(res, 200, JSON.stringify(loadReplayBundle(p)));
      }
      send(res, 404, '{"error":"not found"}');
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/live")) wss.handleUpgrade(req, socket, head, (ws) => sink.attach(ws));
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => resolve());
  });
  const url = `http://localhost:${opts.port}${opts.live ? "/?live" : ""}`;
  return { sink, url, close: () => server.close() };
}
