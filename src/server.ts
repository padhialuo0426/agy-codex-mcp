import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { Agents } from "./agents.js";
import { loadSettings, ToolError } from "./settings.js";

const settings = loadSettings();
const agents = new Agents(settings);
const limit = (size: number) => z.string().trim().min(1).max(size);
const group = z.uuid().describe("The group ID returned by the first codex_spawn call.");
const agent = z.uuid().describe("An agent ID from this group.");
const agentKey = { group_id: group, agent_id: agent };
const task = limit(12_000).describe("Task, scope, and expected deliverable for Codex.");
const context = limit(16_000).optional().describe("Only the background Codex needs, such as file paths, constraints, and test observations.");
const panel = "ui://agy-codex-mcp/agents.html";
const mimeType = "text/html;profile=mcp-app";
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
      : "The local bridge failed. Check the desktop connection, workspace, and Codex session.";
    if (code === "bridge_error" && error instanceof Error && error.name !== "AbortError") {
      process.stderr.write(`agy-codex-mcp: ${error.name}: ${error.message}\n`);
    }
    return { isError: true, content: [{ type: "text" as const, text: `${code}: ${text}` }] };
  }
}

function createServer() {
  const server = new McpServer({ name: "agy-codex-mcp", version: "0.1.0" }, {
    instructions: "Delegate bounded coding tasks to local Codex when the user asks for Codex or independent parallel work benefits the task. Supply the absolute path of the active project, scope, relevant context, and expected result. If the user requests a model or reasoning effort, discover choices with codex_models before spawning. Reuse the returned group_id for peers. Spawn is asynchronous. Continue other work, then call codex_wait and answer a question using codex_send with its reply_to ID. If a tool returns needs_approval, open or focus codex_panel for that group_id and tell the user to review the request in the Codex side panel, then continue waiting. Approvals are decided only by the user. Use codex_followup to start another turn. Report verified results and worktree diffs to the user. Use codex_panel to show the desktop agent view.",
  });

  server.registerTool("codex_spawn", {
    title: "Start Codex subagent",
    description: "Start an independent Codex agent in the background. Reuse group_id for peers. Default is read-only. Worktree mode requires a Git project. Allowlisted roots can start directly; other eligible projects can request a side-panel approval. fork_from can copy a settled agent's Codex context in the same group.",
    inputSchema: z.strictObject({
      group_id: group.optional(), workspace: limit(4_096).describe("Absolute directory of the current project or its checkout."),
      role: z.enum(["default", "explorer", "reviewer", "worker"]).default("default"),
      mode: z.enum(["read_only", "worktree"]).default("read_only"),
      network: z.boolean().default(false).describe("Request network access in the Codex sandbox. Requires human approval unless enabled in server config."),
      task, context, model: limit(100).optional().describe("Model ID from codex_models. Omit to use the Codex default."),
      effort: limit(100).optional().describe("Exact reasoning effort value returned by codex_models for the selected model."),
      base: limit(200).optional().describe("Git revision for the new worktree, defaults to HEAD."),
      input_patch: z.string().min(1).max(120_000).optional().describe("An explicit Git patch containing parent changes needed on the chosen base."),
      fork_from: agent.optional(), request_id: z.uuid().optional().describe("A fresh UUID to deduplicate retries of the same spawn."),
    }), annotations: write,
  }, (args) => result(() => agents.spawn(args)));

  server.registerTool("codex_models", {
    title: "List available Codex models",
    description: "Read selectable model IDs, default reasoning effort, and supported reasoning effort values from the local Codex account. Use these IDs and values in codex_spawn.",
    inputSchema: z.strictObject({ cursor: limit(1_000).optional(), limit: z.number().int().min(1).max(50).default(30) }),
    annotations: { ...readOnly, openWorldHint: true },
  }, ({ cursor, limit }) => result(() => agents.models(cursor, limit)));

  server.registerTool("codex_send", {
    title: "Message Codex subagent",
    description: "Steer the active turn or queue a message for its next turn. Answer a pending child question by passing its question ID in reply_to. Sending a message to an idle agent queues it without starting a turn.",
    inputSchema: z.strictObject({
      ...agentKey, text: limit(6_000), reply_to: z.uuid().optional(),
      delivery: z.enum(["steer", "queue"]).default("steer"),
    }), annotations: localWrite,
  }, (args) => result(() => agents.send(args)));

  server.registerTool("codex_followup", {
    title: "Assign a follow-up task",
    description: "Start another turn in a settled agent's existing Codex session. It reads queued messages and retains conversation context. Use codex_send to steer a turn that is still running.",
    inputSchema: z.strictObject({ ...agentKey, task, context }), annotations: write,
  }, (args) => result(() => agents.followup(args)));

  server.registerTool("codex_wait", {
    title: "Wait for Codex messages",
    description: "Return incremental messages and current statuses for the group or a subset. Continue with the returned cursor. all_finished snapshots the current turns and also returns early for a new approval prompt or a question needing an answer. Use seconds: 0 for a snapshot.",
    inputSchema: z.strictObject({
      group_id: group, agent_ids: z.array(agent).max(32).default([]),
      after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
      mode: z.enum(["any", "all_finished"]).default("any"),
      seconds: z.number().int().min(0).max(25).default(20),
    }), annotations: readOnly,
  }, (args, ctx) => result(() => agents.wait(args.group_id, args.agent_ids, args.after, args.mode, args.seconds, ctx.mcpReq.signal)));

  server.registerTool("codex_list", {
    title: "List Codex subagents",
    description: "Read roles, results, question IDs, and attachment status in an existing group. For incremental progress, use codex_wait.",
    inputSchema: z.strictObject({ group_id: group }), annotations: readOnly,
  }, ({ group_id }) => result(() => agents.list(group_id)));

  server.registerTool("codex_interrupt", {
    title: "Interrupt Codex turn",
    description: "Interrupt a running turn while preserving the agent and its context. Use codex_wait to observe the terminal event.",
    inputSchema: z.strictObject(agentKey), annotations: localWrite,
  }, ({ group_id, agent_id }) => result(() => agents.interrupt(group_id, agent_id)));

  server.registerTool("codex_close", {
    title: "Close Codex subagent",
    description: "Interrupt any running turn and release the agent's loaded session. Saved history and worktree changes are retained.",
    inputSchema: z.strictObject(agentKey), annotations: { ...localWrite, idempotentHint: true },
  }, ({ group_id, agent_id }) => result(() => agents.close(group_id, agent_id)));

  server.registerTool("codex_resume", {
    title: "Reattach saved Codex subagent",
    description: "Attach a saved agent to this Desktop MCP connection. Follow up explicitly to start a new turn.",
    inputSchema: z.strictObject(agentKey), annotations: { ...localWrite, idempotentHint: true },
  }, ({ group_id, agent_id }) => result(() => agents.resume(group_id, agent_id)));

  server.registerTool("codex_changes", {
    title: "Read a Codex worktree diff",
    description: "Show changes relative to an agent's saved base commit. Includes a bounded diff and the list of untracked files. Select a single relative path for details.",
    inputSchema: z.strictObject({ ...agentKey, path: limit(2_000).optional() }), annotations: readOnly,
  }, ({ group_id, agent_id, path }) => result(() => agents.changes(group_id, agent_id, path)));

  server.registerResource("Codex subagent panel", panel, { mimeType, _meta: { ui: { csp: {} } } },
    () => ({ contents: [{ uri: panel, mimeType, text: readFileSync(new URL("./panel.html", import.meta.url), "utf8") }] }));

  server.registerTool("codex_panel", {
    title: "Open Codex subagent panel",
    description: "Open the Antigravity desktop side panel for a group. Provide its group ID so the panel can show status, messages, pending approvals, and direct controls.",
    inputSchema: z.strictObject({ group_id: group.optional() }), annotations: readOnly,
    _meta: {
      ui: { resourceUri: panel },
      "com.google.antigravity/ui": { entrypoints: [{ type: "aux_pane", title: "Codex 子代理" }] },
    },
  }, ({ group_id }) => result(() => {
    if (group_id) {
      agents.checkGroup(group_id);
      return { group_id };
    }
    return { group_id: agents.latestGroupId() ?? null };
  }));

  server.registerTool("codex_panel_state", {
    title: "Read Codex panel state",
    description: "App-only endpoint for the Codex side panel to fetch recent groups, incremental events, and pending approvals.",
    inputSchema: z.strictObject({
      group_id: group.optional(),
      after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    }),
    annotations: readOnly,
    _meta: { ui: { visibility: ["app"] } },
  }, ({ group_id, after }) => result(() => agents.panelState(group_id, after)));

  server.registerTool("codex_approval_decide", {
    title: "Decide pending Codex approval",
    description: "App-only endpoint for human approval actions in the Codex side panel.",
    inputSchema: z.strictObject({
      ...agentKey,
      approval_id: z.uuid(),
      decision: z.enum(["once", "session", "amend", "decline"]),
    }),
    annotations: localWrite,
    _meta: { ui: { visibility: ["app"] } },
  }, ({ group_id, agent_id, approval_id, decision }) => result(() => agents.decideApproval(group_id, agent_id, approval_id, decision)));

  return server;
}

process.stdin.once("end", () => agents.shutdown());
process.once("SIGTERM", () => { agents.shutdown(); setTimeout(() => process.exit(0), 1_200).unref(); });
process.once("SIGINT", () => { agents.shutdown(); setTimeout(() => process.exit(0), 1_200).unref(); });
await serveStdio(createServer);
