import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { jsonSchema } from "./anthropic-api";
import { costUsd } from "./pricing";
import type { DecideRequest, DecideResult, LlmClient, ToolResult } from "./types";

type JsonObject = Record<string, unknown>;
type RpcId = number | string;

export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexAppServerConnection {
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  respond(id: RpcId, result: unknown): void;
  onMessage(listener: (message: RpcMessage) => void): () => void;
  close(): Promise<void>;
}

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

interface DecisionContext {
  request: DecideRequest;
  result: DecideResult;
  session: CodexSession;
  latestUsage: UsageSnapshot | null;
  turnId: string | null;
  cacheWriteTokens: number;
  failedCalls: number;
  resolve(): void;
  reject(error: Error): void;
}

interface UsageSnapshot {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface CodexSession {
  threadId: string;
  signature: string;
  usage: UsageSnapshot;
}

function subscriptionEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  // ChatGPT subscription auth only. Never let an API key silently change billing mode.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.CODEX_ACCESS_TOKEN;
  return env;
}

class StdioCodexConnection implements CodexAppServerConnection {
  private nextId = 1;
  private pending = new Map<
    RpcId,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private listeners = new Set<(message: RpcMessage) => void>();
  private stderr = "";
  private closed = false;

  private constructor(
    private child: ChildProcessWithoutNullStreams,
    private isolatedHome: string,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        return;
      }
      if (message.method) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(
            `codex app-server: ${message.error.message ?? `RPC error ${message.error.code ?? "unknown"}`}`,
          ),
        );
      else pending.resolve(message.result);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = (this.stderr + String(chunk)).slice(-8_000);
    });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim();
      this.fail(
        new Error(`codex app-server exited (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
      );
    });
  }

  static async launch(): Promise<StdioCodexConnection> {
    const sourceHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const sourceAuth = join(sourceHome, "auth.json");
    if (!existsSync(sourceAuth))
      throw new Error(`codex subscription login not found; run 'codex login' first`);

    // Do not inherit config.toml, AGENTS.md, plugins, MCP servers, skills, or persisted sessions.
    // Only the saved ChatGPT login is copied into this private, per-process Codex home.
    const isolatedHome = mkdtempSync(join(tmpdir(), "firebreak-codex-"));
    chmodSync(isolatedHome, 0o700);
    copyFileSync(sourceAuth, join(isolatedHome, "auth.json"));
    chmodSync(join(isolatedHome, "auth.json"), 0o600);

    const child = spawn(
      "codex",
      [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "features.shell_tool=false",
        "-c",
        "features.shell_snapshot=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        "agents.enabled=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.plugins=false",
        "-c",
        'web_search="disabled"',
        "-c",
        'shell_environment_policy.inherit="none"',
      ],
      {
        cwd: tmpdir(),
        env: subscriptionEnv(isolatedHome),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const connection = new StdioCodexConnection(child, isolatedHome);
    try {
      await connection.request("initialize", {
        clientInfo: { name: "firebreak", title: "Firebreak", version: "0.1.0" },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
          ],
        },
      });
      connection.notify("initialized", {});
      const account = await connection.request<{
        account: { type?: string } | null;
        requiresOpenaiAuth: boolean;
      }>("account/read", { refreshToken: false });
      // `requiresOpenaiAuth` describes whether this provider needs OpenAI auth at all; it remains
      // true for a valid ChatGPT account. The account discriminator is the billing-mode check.
      if (account.account?.type !== "chatgpt")
        throw new Error(
          "codex is not signed in with ChatGPT; run 'codex login' and choose ChatGPT authentication",
        );
      return connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("codex app-server is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server timed out waiting for ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ method, id, params });
    });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  onMessage(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(message: unknown): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: "connection/error", params: { message: error.message } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("codex app-server closed"));
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    rmSync(this.isolatedHome, { recursive: true, force: true });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatalKind(message: string): DecideResult["fatal"] | undefined {
  if (/usage.?limit|rate.?limit|spend.?control|quota|429/i.test(message)) return "usage_limit";
  if (
    /not signed in|log ?in|auth|unauthorized|401|not available to this ChatGPT account|spawn codex|ENOENT/i.test(
      message,
    )
  )
    return "auth";
  return undefined;
}

/**
 * OpenAI Codex subscription backend.
 *
 * One App Server process is reused, with one isolated ephemeral thread per logical Firebreak
 * agent. Later decisions append turns to that thread. Codex's own shell, apps, plugins, web
 * search, and multi-agent tools are disabled; only Firebreak's dynamic tools are supplied.
 */
export class CodexAppServerClient implements LlmClient {
  readonly backend = "codex" as const;
  readonly retainsSessionContext = true;
  private connectionPromise: Promise<CodexAppServerConnection> | null = null;
  private unsubscribe: (() => void) | null = null;
  private decisions = new Map<string, DecisionContext>();
  private sessions = new Map<string, Promise<CodexSession>>();

  constructor(
    readonly model: string,
    private opts: { reasoningEffort: ReasoningEffort; maxTokens: number },
    private connectionFactory: () => Promise<CodexAppServerConnection> = () => StdioCodexConnection.launch(),
  ) {}

  private async connection(): Promise<CodexAppServerConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.connectionFactory().then(async (connection) => {
        this.unsubscribe = connection.onMessage((message) => this.onMessage(connection, message));
        const models = await connection.request<{ data?: { id?: string; model?: string }[] }>("model/list", {
          limit: 100,
        });
        if (!(models.data ?? []).some((entry) => entry.id === this.model || entry.model === this.model)) {
          await connection.close();
          throw new Error(`codex model '${this.model}' is not available to this ChatGPT account`);
        }
        return connection;
      });
    }
    return this.connectionPromise;
  }

  private sessionSignature(req: DecideRequest): string {
    return JSON.stringify({
      system: req.system,
      tools: req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchema(tool),
      })),
    });
  }

  private async session(connection: CodexAppServerConnection, req: DecideRequest): Promise<CodexSession> {
    const signature = this.sessionSignature(req);
    let pending = this.sessions.get(req.session_id);
    if (!pending) {
      pending = connection
        .request<{
          thread: { id: string };
          model: string;
          instructionSources?: string[];
        }>("thread/start", {
          model: this.model,
          cwd: tmpdir(),
          approvalPolicy: "never",
          sandbox: "read-only",
          ephemeral: true,
          serviceName: "firebreak",
          baseInstructions: req.system,
          developerInstructions: "",
          dynamicTools: req.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: jsonSchema(tool),
          })),
        })
        .then((started) => {
          if (started.model !== this.model)
            throw new Error(`codex requested ${this.model} but App Server selected ${started.model}`);
          if (started.instructionSources?.length)
            throw new Error(
              `codex loaded unexpected instruction files: ${started.instructionSources.join(", ")}`,
            );
          return {
            threadId: started.thread.id,
            signature,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        });
      this.sessions.set(req.session_id, pending);
      pending.catch(() => this.sessions.delete(req.session_id));
    }
    const session = await pending;
    if (session.signature !== signature)
      throw new Error(`codex session '${req.session_id}' changed its system prompt or tools`);
    return session;
  }

  async decide(req: DecideRequest): Promise<DecideResult> {
    const result: DecideResult = {
      response: "",
      tool_calls: [],
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0,
      cost_estimated: true,
    };
    let threadId: string | null = null;
    let context: DecisionContext | null = null;
    let removeAbort: (() => void) | null = null;
    try {
      const connection = await this.connection();
      if (req.signal.aborted) return result;
      const session = await this.session(connection, req);
      threadId = session.threadId;
      if (this.decisions.has(threadId)) throw new Error(`codex session '${req.session_id}' is already busy`);

      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const done = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      context = {
        request: req,
        result,
        session,
        latestUsage: null,
        turnId: null,
        cacheWriteTokens: 0,
        failedCalls: 0,
        resolve,
        reject,
      };
      this.decisions.set(threadId, context);
      const onAbort = () => {
        if (context?.turnId)
          void connection
            .request("turn/interrupt", { threadId, turnId: context.turnId })
            .catch(() => undefined);
        resolve();
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => req.signal.removeEventListener("abort", onAbort);

      const turn = await connection.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: [{ type: "text", text: req.user }],
        effort: this.opts.reasoningEffort === "none" ? "low" : this.opts.reasoningEffort,
      });
      context.turnId = turn.turn.id;
      if (req.signal.aborted) onAbort();
      await done;
    } catch (error) {
      if (!req.signal.aborted) {
        result.error = errorText(error);
        result.fatal = fatalKind(result.error);
      }
    } finally {
      removeAbort?.();
      if (threadId) this.decisions.delete(threadId);
      if (context?.latestUsage) context.session.usage = context.latestUsage;
      const c = costUsd(this.model, {
        input: Math.max(0, result.input_tokens - result.cache_read_tokens - (context?.cacheWriteTokens ?? 0)),
        output: result.output_tokens,
        cacheRead: result.cache_read_tokens,
        cacheWrite: context?.cacheWriteTokens ?? 0,
      });
      // This is an API-equivalent estimate only; ChatGPT subscription usage is not API-billed.
      result.cost_usd = c.usd;
      result.cost_estimated = true;
    }
    return result;
  }

  private onMessage(connection: CodexAppServerConnection, message: RpcMessage): void {
    if (message.method === "connection/error") {
      const error = new Error(String(message.params?.message ?? "codex app-server connection failed"));
      for (const context of this.decisions.values()) context.reject(error);
      return;
    }
    if (message.method === "item/tool/call" && message.id !== undefined) {
      void this.callTool(connection, message.id, message.params ?? {});
      return;
    }
    if (
      message.id !== undefined &&
      ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
        message.method ?? "",
      )
    ) {
      connection.respond(message.id, { decision: "decline" });
      return;
    }
    const threadId = String(message.params?.threadId ?? "");
    const context = this.decisions.get(threadId);
    if (!context) return;

    if (message.method === "item/completed") {
      const item = message.params?.item as { type?: string; text?: string } | undefined;
      if (item?.type === "agentMessage" && item.text)
        context.result.response += `${context.result.response ? "\n" : ""}${item.text}`;
    } else if (message.method === "thread/tokenUsage/updated") {
      const usage = (message.params?.tokenUsage as JsonObject | undefined)?.total as JsonObject | undefined;
      if (usage) {
        const current = {
          input: Number(usage.inputTokens ?? 0),
          output: Number(usage.outputTokens ?? 0),
          cacheRead: Number(usage.cachedInputTokens ?? 0),
          cacheWrite: Number(usage.cacheWriteInputTokens ?? 0),
        };
        context.latestUsage = current;
        context.result.input_tokens = Math.max(0, current.input - context.session.usage.input);
        context.result.output_tokens = Math.max(0, current.output - context.session.usage.output);
        context.result.cache_read_tokens = Math.max(0, current.cacheRead - context.session.usage.cacheRead);
        context.cacheWriteTokens = Math.max(0, current.cacheWrite - context.session.usage.cacheWrite);
      }
    } else if (message.method === "error") {
      const error = message.params?.error as { message?: string; codexErrorInfo?: unknown } | undefined;
      const text = error?.message ?? JSON.stringify(error?.codexErrorInfo ?? "unknown Codex error");
      context.result.error = `codex: ${text}`;
      context.result.fatal = fatalKind(`${text} ${JSON.stringify(error?.codexErrorInfo ?? "")}`);
    } else if (message.method === "turn/completed") {
      const turn = message.params?.turn as
        { status?: string; error?: { message?: string; codexErrorInfo?: unknown } } | undefined;
      if (turn?.status === "failed") {
        const text = turn.error?.message ?? "turn failed";
        context.result.error = `codex: ${text}`;
        context.result.fatal = fatalKind(`${text} ${JSON.stringify(turn.error?.codexErrorInfo ?? "")}`);
      }
      context.resolve();
    }
  }

  private async callTool(connection: CodexAppServerConnection, id: RpcId, params: JsonObject): Promise<void> {
    const threadId = String(params.threadId ?? "");
    const context = this.decisions.get(threadId);
    if (!context) {
      connection.respond(id, {
        contentItems: [{ type: "inputText", text: "decision is no longer active" }],
        success: false,
      });
      return;
    }
    const name = String(params.tool ?? "");
    const raw = params.arguments;
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonObject) : {};
    let toolResult: ToolResult;
    try {
      toolResult = await context.request.execute(name, input);
    } catch (error) {
      toolResult = { text: errorText(error), isError: true };
    }
    context.result.tool_calls.push({ name, input, result: toolResult.text });
    if (toolResult.isError) context.failedCalls += 1;
    connection.respond(id, {
      contentItems: [{ type: "inputText", text: toolResult.text }],
      success: !toolResult.isError,
    });
    if (toolResult.isError && context.failedCalls >= context.request.maxTurns && context.turnId) {
      void connection.request("turn/interrupt", { threadId, turnId: context.turnId }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const context of this.decisions.values()) context.reject(new Error("codex client closed"));
    this.decisions.clear();
    this.sessions.clear();
    if (this.connectionPromise) {
      try {
        await (await this.connectionPromise).close();
      } finally {
        this.connectionPromise = null;
      }
    }
  }
}
