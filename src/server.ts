import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Agents } from "./agents.js";
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

function createServer() {
  const server = new McpServer({ name: "agy-codex-mcp", version: "0.2.0" }, {
    instructions: "Delegate coding tasks to local Codex without manual approvals. Use codex_run for a single-shot task (waits until finished or needs_input, returning result and any worktree diff), or pass background: true to launch parallel tasks and wait with codex_wait. Pass agent_id to codex_run to continue an existing agent. Use codex_send to answer a pending question (no reply_to ID needed), steer a running turn, or start a follow-up. Use codex_manage for list, changes, interrupt, and close. Discover models and effort options with codex_models when requested.",
  });

  server.registerTool("codex_run", {
    title: "Run Codex subagent",
    description: "Start a new Codex agent (supply workspace) or continue an existing one (supply agent_id). Defaults to blocking until completion or needs_input, returning the result and worktree changes. Set background: true for parallel delegation.",
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
      fork_from: agent.optional().describe("Fork context from a settled agent in the same workspace."),
      background: z.boolean().default(false).describe("Return immediately instead of waiting for completion."),
      timeout_seconds: z.number().int().min(1).max(600).default(120).describe("Wait timeout when background is false."),
    }),
    annotations: write,
  }, (args, ctx) => result(() => agents.run(args, ctx.mcpReq.signal)));

  server.registerTool("codex_wait", {
    title: "Wait for background Codex agents",
    description: "Wait for background Codex agents and return incremental events. Omit agent_ids to watch all currently active agents, and omit after to resume from the automatic cursor.",
    inputSchema: z.strictObject({
      agent_ids: z.array(agent).max(32).default([]),
      mode: z.enum(["any", "all"]).default("all").describe("all waits for all targets to settle or ask a question; any returns on the first new event."),
      seconds: z.number().int().min(0).max(25).default(25),
      after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    }),
    annotations: readOnly,
  }, (args, ctx) => result(() => agents.wait(args, ctx.mcpReq.signal)));

  server.registerTool("codex_send", {
    title: "Message or answer Codex subagent",
    description: "Send input to a Codex agent. In auto mode (default), answers any pending question directly, steers a running turn, or starts a follow-up on a settled agent.",
    inputSchema: z.strictObject({
      agent_id: agent,
      text: limit(6_000),
      mode: z.enum(["auto", "steer", "followup"]).default("auto"),
      wait: z.boolean().default(false).describe("Wait for completion after answering or starting a follow-up."),
      timeout_seconds: z.number().int().min(1).max(600).default(120),
    }),
    annotations: localWrite,
  }, (args, ctx) => result(() => agents.send(args, ctx.mcpReq.signal)));

  server.registerTool("codex_manage", {
    title: "Manage Codex subagents",
    description: "List recent/active agents, read a worktree diff (changes), interrupt a running turn, or close an agent.",
    inputSchema: z.strictObject({
      action: z.enum(["list", "changes", "interrupt", "close"]),
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
