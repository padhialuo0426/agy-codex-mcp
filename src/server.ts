import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Agents, type ProgressCallback } from "./agents.js";
import { loadSettings, ToolError } from "./settings.js";

const settings = loadSettings();
const agents = new Agents(settings);
const limit = (size: number) => z.string().trim().min(1).max(size);
const agent = z.uuid().describe("Codex agent ID.");
const task = limit(12_000).describe("Task, scope, and expected deliverable for Codex.");
const context = limit(16_000).optional().describe("Focused background context such as file paths, constraints, and observations.");
const readOnly = { readOnlyHint: true, openWorldHint: false };
const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

async function result<T extends Record<string, unknown>>(operation: () => T | Promise<T>) {
  try {
    const data = await operation();
    return { structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  } catch (error) {
    const code = error instanceof ToolError ? error.code : "bridge_error";
    const text = error instanceof ToolError ? error.message
      : error instanceof Error && error.name === "AbortError" ? "The wait was canceled."
      : "The local bridge failed. Check the workspace and Codex session.";
    if (code === "bridge_error" && error instanceof Error && error.name !== "AbortError") {
      process.stderr.write(`agy-codex-mcp: ${error.name}: ${error.message}\n`);
    }
    return { isError: true, content: [{ type: "text" as const, text: `${code}: ${text}` }] };
  }
}

function makeProgress(
  ctx: { mcpReq: { _meta?: { progressToken?: string | number }; notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void> } },
  total: number,
): ProgressCallback | undefined {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return (elapsedSec, activity) => {
    void ctx.mcpReq.notify({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: elapsedSec,
        total,
        message: activity ? `${activity.kind}: ${activity.detail}` : `Running (${elapsedSec}s)`,
      },
    }).catch(() => undefined);
  };
}

function createServer() {
  const server = new McpServer({ name: "agy-codex-mcp", version: "0.3.0" }, {
    instructions: "Delegate coding tasks to local Codex without manual approvals or polling loops. Call codex_run (waits up to wait_seconds; returns result and diff when done, or still_running: true with watch_command if a long script is still active — never poll in a loop; run watch_command via a background shell task for zero-token reactive wakeup). Use codex_send to steer a running turn in real time (mode: 'steer'), answer ask_parent questions (no reply_to ID needed), or follow up. Use codex_manage for status (live activity & events), list, changes, interrupt, close, and cleanup. Discover models with codex_models when requested.",
  });

  server.registerTool("codex_run", {
    title: "Run Codex subagent",
    description: "Start a new Codex agent (supply workspace) or continue an existing one (supply agent_id). Waits up to wait_seconds before returning still_running: true with a zero-polling watch_command. Ephemeral sessions auto-close after delivery unless keep_session: true is set.",
    inputSchema: z.strictObject({
      agent_id: agent.optional().describe("Existing agent ID to continue instead of spawning a new one."),
      workspace: limit(4_096).optional().describe("Absolute project or work-copy directory. Required when agent_id is omitted."),
      task,
      context,
      mode: z.enum(["read_only", "worktree", "workspace"]).default("read_only").describe("read_only (default), worktree (isolated Git worktree), or workspace (edit directly in workspace)."),
      role: z.enum(["default", "explorer", "reviewer", "worker"]).default("default"),
      network: z.boolean().optional().describe("Override sandbox network access for this agent."),
      model: limit(100).optional().describe("Model ID from codex_models. Omit for Codex default."),
      effort: limit(100).optional().describe("Reasoning effort value from codex_models."),
      base: limit(200).optional().describe("Git revision for worktree mode, defaults to HEAD."),
      input_patch: z.string().min(1).max(120_000).optional().describe("Explicit Git patch to apply when creating a worktree."),
      fork_from: agent.optional().describe("Fork context from a settled agent in the same workspace (requires keep_session: true on the source agent)."),
      background: z.boolean().default(false).describe("Return immediately with agent_id and watch_command."),
      keep_session: z.boolean().optional().describe("Keep the Codex thread alive after delivery for multi-turn follow-ups. Defaults to false for new runs."),
      wait_seconds: z.number().int().min(0).max(300).default(90).describe("Seconds to wait synchronously before returning still_running: true and watch_command (0 = immediate return). Does NOT kill running scripts."),
      max_turn_seconds: z.number().int().min(1).max(14_400).optional().describe("Hard execution deadline in seconds for this turn. When exceeded, the turn is interrupted and child scripts are terminated."),
    }),
    annotations: write,
  }, (args, ctx) => result(() => agents.run(args, ctx.mcpReq.signal, makeProgress(ctx, args.wait_seconds))));

  server.registerTool("codex_send", {
    title: "Message or answer Codex subagent",
    description: "Send input to a Codex agent. In auto mode (default), answers any pending question directly, steers a running turn in real time, or starts a follow-up on a settled agent.",
    inputSchema: z.strictObject({
      agent_id: agent,
      text: limit(6_000),
      mode: z.enum(["auto", "steer", "followup"]).default("auto"),
      wait: z.boolean().default(false).describe("Wait for completion after answering or starting a follow-up."),
      wait_seconds: z.number().int().min(0).max(300).default(90).describe("Seconds to wait synchronously when wait is true."),
    }),
    annotations: localWrite,
  }, (args, ctx) => result(() => agents.send(args, ctx.mcpReq.signal, makeProgress(ctx, args.wait_seconds))));

  server.registerTool("codex_manage", {
    title: "Manage Codex subagents",
    description: "Inspect live status/activity and recent events (status), list recent agents (list), read worktree diff (changes), interrupt a turn (interrupt), close an agent (close), or purge old persisted threads/worktrees (cleanup).",
    inputSchema: z.strictObject({
      action: z.enum(["status", "list", "changes", "interrupt", "close", "cleanup"]),
      agent_id: agent.optional(),
      path: limit(2_000).optional().describe("Optional relative path filter for action='changes'."),
      limit: z.number().int().min(1).max(50).default(20).optional().describe("Max agents for action='list'."),
    }),
    annotations: localWrite,
  }, (args) => result(() => agents.manage(args)));

  server.registerTool("codex_models", {
    title: "List available Codex models",
    description: "Read selectable model IDs, default reasoning effort, and supported reasoning effort values from the local Codex account.",
    inputSchema: z.strictObject({ cursor: limit(1_000).optional(), limit: z.number().int().min(1).max(50).default(30) }),
    annotations: { ...readOnly, openWorldHint: true },
  }, ({ cursor, limit }) => result(() => agents.models(cursor, limit)));

  return server;
}

process.stdin.once("end", () => agents.shutdown());
process.once("SIGTERM", () => { agents.shutdown(); setTimeout(() => process.exit(0), 1_200).unref(); });
process.once("SIGINT", () => { agents.shutdown(); setTimeout(() => process.exit(0), 1_200).unref(); });
await serveStdio(createServer);
