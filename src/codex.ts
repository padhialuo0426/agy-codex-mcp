import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { ToolError, type Settings } from "./settings.js";

type Envelope = Record<string, unknown>;
type RequestId = string | number;

export function record(value: unknown): Envelope {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Envelope : {};
}

export function message(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function output(value: string, max = 6_000) {
  return value.length <= max ? value : value.slice(0, max) + "\n[truncated]";
}

type Pending = { resolve: (result: Envelope) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class Codex extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private connecting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private counter = 0;
  private intentionalStop = false;

  constructor(private readonly settings: Settings) { super(); }

  async request(method: string, params: Envelope, timeout = 12_000) {
    await this.connect();
    return this.rpc(method, params, timeout);
  }

  reply(id: RequestId, result: Envelope) {
    if (!this.child?.stdin.writable) return false;
    this.write({ id, result });
    return true;
  }

  fail(id: RequestId, detail: string) {
    if (this.child?.stdin.writable) this.write({ id, error: { code: -32603, message: detail } });
  }

  stop() {
    this.intentionalStop = true;
    const pid = this.child?.pid;
    if (pid) {
      try { process.kill(-pid, "SIGTERM"); } catch { /* Already gone. */ }
      const watchdog = setTimeout(() => {
        if (this.child?.pid === pid) {
          try { process.kill(-pid, "SIGKILL"); } catch { /* Already gone. */ }
        }
      }, 1_000);
      watchdog.unref();
    }
    this.child?.stdin.end();
  }

  private connect() {
    if (this.connecting) return this.connecting;
    if (this.child) return Promise.resolve();
    this.connecting = this.start().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async start() {
    this.intentionalStop = false;
    const overrides = [
      "agents.enabled=false",
      'web_search="disabled"',
      'shell_environment_policy.inherit="all"',
      ...this.settings.codex_config,
    ];
    const child = spawn(this.settings.codex, [
      ...overrides.flatMap((override) => ["-c", override]),
      "app-server", "--listen", "stdio://",
    ], {
      cwd: this.settings.state_dir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let buffer = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line) {
          if (line.length > 8_000_000) { this.stop(); return; }
          this.receive(line);
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > 8_000_000) this.stop();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4_096);
    });
    child.stdin.on("error", () => this.stop());
    child.once("error", (error) => {
      if (!this.intentionalStop) process.stderr.write(`agy-codex-mcp: codex spawn error: ${error.message}\n`);
      this.disconnected(child);
    });
    child.once("exit", (code, signal) => {
      if (!this.intentionalStop && (code || signal)) {
        const detail = stderrTail.trim();
        process.stderr.write(`agy-codex-mcp: codex exited (${code ?? signal})${detail ? `: ${detail}` : ""}\n`);
      }
      this.disconnected(child);
    });
    try {
      await this.rpc("initialize", {
        clientInfo: { name: "agy-codex-mcp", title: "Codex subagents for Antigravity", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ["item/reasoning/textDelta", "item/reasoning/summaryTextDelta", "item/commandExecution/outputDelta"] },
      }, 6_000);
      this.write({ method: "initialized" });
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  private disconnected(child: ChildProcessWithoutNullStreams) {
    if (child !== this.child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ToolError("codex_disconnected", "Codex app-server exited. Use codex_resume for a saved agent."));
    }
    this.pending.clear();
    this.emit("disconnected");
  }

  private rpc(method: string, params: Envelope, timeout: number) {
    const id = ++this.counter;
    return new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError("codex_timeout", `Codex did not acknowledge ${method} in time. Check the agent status before retrying.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(value: Envelope) {
    if (!this.child?.stdin.writable) throw new ToolError("codex_unavailable", "Codex app-server is unavailable. Check its executable and login.");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private receive(line: string) {
    let value: Envelope;
    try { value = record(JSON.parse(line)); } catch { return; }
    const id = value.id;
    const method = message(value.method);
    if (method) {
      const params = record(value.params);
      if (typeof id === "string" || typeof id === "number") this.emit("request", id, method, params);
      else this.emit("notification", method, params);
      return;
    }
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (value.error) {
      const error = record(value.error);
      pending.reject(new ToolError("codex_error", output(message(error.message) ?? "Codex rejected the request.", 500)));
    } else {
      pending.resolve(record(value.result));
    }
  }
}
