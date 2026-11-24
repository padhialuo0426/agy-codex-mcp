import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalDialogs, codexApproval, type Decision } from "./approvals.js";
import { Codex, message, output, record } from "./codex.js";
import { State, busy, ownerAlive, ownerId, type Agent, type ApprovalChoice, type ApprovalNotice, type ApprovalOption, type Role } from "./state.js";
import { approvalsEnabled, canWrite, effectiveApprovalMode, ToolError, workspace, type Settings } from "./settings.js";
import { makeWorktree, planWorktree, readChanges } from "./worktrees.js";

const roles: Record<Role, string> = {
  default: "Carry out the delegated task and report the result with evidence.",
  explorer: "Explore the repository. Cite file paths and line numbers and distinguish observations from inferences.",
  reviewer: "Review the requested work. Prioritize actionable findings and include a location and supporting evidence for each.",
  worker: "Implement the requested changes within the assigned scope and report the checks you actually ran.",
};

const mailboxTools = [
  { name: "report_to_parent", description: "Send a short progress report or important finding to the Antigravity parent.", field: "text" },
  { name: "ask_parent", description: "Ask the Antigravity parent a question that blocks progress. The tool returns its answer in this turn.", field: "question" },
] as const;

const inputs = (text: string) => [{ type: "text", text, text_elements: [] }];
type Id = string | number;
type PendingQuestion = { id: string; rpc: Id; timer: NodeJS.Timeout };
type PendingApproval = {
  agent: string;
  group: string;
  rpc?: Id;
  cancel: AbortController;
  options: ApprovalOption[];
  resolve: (choice: ApprovalChoice) => void;
};
type DeadlineEntry = { timer?: NodeJS.Timeout; remainingMs: number; startedAt?: number };
type Spawn = {
  group_id?: string; workspace: string; task: string; context?: string;
  role: Role; mode: "read_only" | "worktree"; network?: boolean; model?: string; effort?: string;
  base?: string; input_patch?: string; fork_from?: string; request_id?: string;
};
type Followup = { group_id: string; agent_id: string; task: string; context?: string };
type Send = { group_id: string; agent_id: string; text: string; reply_to?: string; delivery: "steer" | "queue" };

function itemText(label: string, text: string) {
  return `${label}:\n${text}`;
}

function isApprovedDecision(decision: Decision): decision is "once" | "session" | "amend" {
  return decision === "once" || decision === "session" || decision === "amend";
}

function waitAbort<T>(signal: AbortSignal, value: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(value);
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(value), { once: true });
  });
}

export class Agents {
  private readonly state: State;
  private readonly codex: Codex;
  private readonly dialogs: ApprovalDialogs;
  private readonly byThread = new Map<string, string>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly approvalItems = new Map<string, Map<string, Record<string, unknown>>>();
  private readonly interrupting = new Set<string>();
  private readonly deadlines = new Map<string, DeadlineEntry>();
  private readonly changing = new Set<string>();
  private lastPanelPollAt = 0;
  private stopping = false;

  constructor(private readonly settings: Settings) {
    this.state = new State(settings.state_dir);
    this.codex = new Codex(settings);
    this.dialogs = new ApprovalDialogs(settings.approval_dialog);
    this.codex.on("notification", (method, params) => this.notify(method, params));
    this.codex.on("request", (id, method, params) => {
      void this.serverRequest(id, method, params).catch(() => this.codex.fail(id, "The coordination request could not be processed."));
    });
    this.codex.on("disconnected", () => this.recoverOwned());
  }

  shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    this.recoverOwned();
    this.codex.stop();
  }

  markPanelActive() {
    this.lastPanelPollAt = Date.now();
  }

  private isPanelActive() {
    return Date.now() - this.lastPanelPollAt < 10_000;
  }

  latestGroupId() {
    return this.state.recentGroups(1)[0]?.group_id;
  }

  panelState(groupId?: string, after = 0) {
    this.markPanelActive();
    const recent_groups = this.state.recentGroups(12);
    const target = groupId ?? recent_groups[0]?.group_id;
    if (!target) {
      return { group_id: null, recent_groups: [], cursor: 0, events: [], agents: [] };
    }
    const agents = this.state.group(target);
    if (!agents.length) throw new ToolError("group_not_found", "Use a group ID returned by codex_spawn.");
    const events = this.state.recent(target, [], after, 50);
    return {
      group_id: target,
      recent_groups,
      cursor: events.at(-1)?.seq ?? after,
      events,
      agents: agents.map((agent) => this.view(agent)),
    };
  }

  decideApproval(group: string, agentId: string, approvalId: string, decision: ApprovalChoice) {
    this.markPanelActive();
    const agent = this.state.require(group, agentId);
    if (agent.owner !== ownerId || !ownerAlive(agent.owner)) {
      throw new ToolError("agent_detached", "This agent is not owned by the active desktop connection.");
    }
    const pending = this.approvals.get(approvalId);
    if (!pending || pending.agent !== agentId || pending.group !== group) {
      throw new ToolError("approval_not_pending", "This approval request is no longer pending.");
    }
    if (!pending.options.some((option) => option.choice === decision)) {
      throw new ToolError("invalid_approval_decision", `Allowed decisions: ${pending.options.map((o) => o.choice).join(", ")}.`);
    }
    pending.resolve(decision);
    return this.view(this.state.require(group, agentId));
  }

  async spawn(args: Spawn, parent?: Agent) {
    if (this.stopping) throw new ToolError("server_stopping", "The MCP server is shutting down.");
    const writable = args.mode === "worktree";
    const approvalsAllowed = approvalsEnabled(this.settings);
    const cwd = workspace(this.settings, args.workspace, writable && !approvalsAllowed);
    if ((args.base || args.input_patch) && !writable) throw new ToolError("worktree_required", "A base commit or input patch requires worktree mode.");
    const wantsNetwork = Boolean(args.network);
    const needsNetworkApproval = wantsNetwork && !this.settings.sandbox_network;
    if (needsNetworkApproval && !approvalsAllowed) {
      throw new ToolError("network_not_enabled", "Network access requires approval or sandbox_network in the desktop server configuration.");
    }
    const plan = writable ? await planWorktree(this.settings, cwd, args.base) : undefined;
    const requiresWorktreeApproval = Boolean(plan && (!canWrite(this.settings, cwd) || !canWrite(this.settings, plan.repository)));
    if (requiresWorktreeApproval && plan && !approvalsAllowed) workspace(this.settings, plan.repository, true);
    const selectedModel = await this.selectModel(cwd, args.model, args.effort);
    const group = args.group_id ?? randomUUID();
    const id = args.request_id ?? randomUUID();
    const agent: Agent = {
      id, group, role: args.role, task: args.task, workspace: cwd, cwd,
      status: "starting", owner: ownerId, generation: 1, settled: 0, queue: [],
      parent: parent?.id, depth: parent ? parent.depth + 1 : 1, model: selectedModel, effort: args.effort,
      network: wantsNetwork,
    };
    let existing: Agent | undefined;
    let source: Agent | undefined;
    this.state.change(() => {
      existing = this.state.find(id);
      if (existing) {
        if ((args.group_id && args.group_id !== existing.group) || args.task !== existing.task || cwd !== existing.workspace) {
          throw new ToolError("request_conflict", "Use a fresh request ID for a different task.");
        }
        return;
      }
      if (args.group_id && !this.state.group(group).length) throw new ToolError("group_not_found", "Use an existing group ID or omit it to create a group.");
      if (agent.depth > this.settings.max_depth) throw new ToolError("depth_limit", "Nested delegation has reached its configured depth limit.");
      if (args.fork_from) {
        source = this.state.require(group, args.fork_from);
        if (!source.thread || busy(source) || source.workspace !== cwd) {
          throw new ToolError("fork_unavailable", "Fork a settled Codex agent in the same project and group.");
        }
      }
      this.checkCapacity(group);
      this.state.save(agent);
      this.state.event(agent, "starting", output(args.task, 1_000));
    });
    if (existing) return this.view(existing);
    const needsUpfrontApproval = requiresWorktreeApproval || needsNetworkApproval;
    const approvalKind = requiresWorktreeApproval ? "worktree" : "spawn_permissions";
    const approvalSummary = requiresWorktreeApproval && needsNetworkApproval
      ? "创建可写 Git worktree 并开启沙箱网络"
      : requiresWorktreeApproval
        ? "创建可写 Git worktree"
        : "开启沙箱网络访问";
    const approvalDetails = needsUpfrontApproval ? {
      操作: approvalKind === "worktree" ? "为这次任务创建可写 Git worktree" : "为只读子代理开启网络访问",
      ...(plan ? { 仓库: plan.repository, 基线提交: plan.base } : {}),
      项目目录: cwd,
      网络访问: wantsNetwork,
      任务: args.task,
      模型: selectedModel,
      思考强度: args.effort,
      补充上下文: args.context,
      输入补丁: args.input_patch,
    } : undefined;
    const approvalOptions: ApprovalOption[] = [
      { choice: "once", label: "批准一次" },
      { choice: "session", label: requiresWorktreeApproval ? "本工作树免重复审批" : "本会话放行" },
      { choice: "decline", label: "拒绝" },
    ];
    return this.launch(agent, async (current, decision) => {
      if (requiresWorktreeApproval && (decision === "session" || (decision === "once" && this.settings.reuse_worktree_approval))) {
        current.worktree_approved = true;
        this.state.save(current);
      }
      if (plan) {
        const tree = await makeWorktree(this.settings, current, plan, args.input_patch);
        if (!this.activeTurn(current)) return;
        Object.assign(current, tree);
        this.state.save(current);
      }
      const options = await this.threadOptions(current);
      if (!this.activeTurn(current)) return;
      const result = source?.thread
        ? await this.codex.request("thread/fork", { ...options, threadId: source.thread, excludeTurns: true })
        : await this.codex.request("thread/start", { ...options, dynamicTools: this.dynamicTools() });
      const thread = message(record(result.thread).id);
      if (!thread) throw new ToolError("missing_thread", "Codex did not return a usable thread ID.");
      if (!this.activeTurn(current)) return;
      current.thread = thread;
      this.byThread.set(thread, current.id);
      this.state.save(current);
      await this.startTurn(current, args.task, args.context);
    }, approvalDetails ? { kind: approvalKind, summary: approvalSummary, details: approvalDetails, options: approvalOptions } : undefined);
  }

  async followup(args: Followup) {
    return this.exclusive(args.agent_id, async () => {
      const agent = this.owned(args.group_id, args.agent_id);
      const tree = agent.worktree;
      const needsApproval = Boolean(
        tree && !agent.worktree_approved && (!canWrite(this.settings, agent.workspace) || !canWrite(this.settings, tree.repository)),
      );
      if (needsApproval && !approvalsEnabled(this.settings)) {
        workspace(this.settings, tree!.repository, true);
      }
      this.state.change(() => {
        if (busy(agent)) throw new ToolError("agent_busy", "Use codex_send to steer an active agent, or interrupt it before starting another task.");
        this.checkCapacity(agent.group);
        agent.status = "starting";
        agent.followup_task = args.task;
        agent.generation++;
        agent.turn = undefined;
        agent.last = undefined;
        this.state.save(agent);
        this.state.event(agent, "starting", output(args.task, 1_000));
      });
      return this.launch(agent, async (current, decision) => {
        if (needsApproval && (decision === "session" || (decision === "once" && this.settings.reuse_worktree_approval))) {
          current.worktree_approved = true;
          this.state.save(current);
        }
        await this.startTurn(current, args.task, args.context);
      }, needsApproval && tree ? {
        kind: "worktree",
        summary: "在已有可写 Git worktree 运行续派任务",
        details: {
          操作: "在已有可写 Git worktree 运行一轮续派任务",
          仓库: tree.repository,
          工作树: tree.path,
          基线提交: tree.base,
          任务: args.task,
          补充上下文: args.context,
          模型: agent.model,
          思考强度: agent.effort,
        },
        options: [
          { choice: "once", label: "批准一次" },
          { choice: "session", label: "本工作树免重复审批" },
          { choice: "decline", label: "拒绝" },
        ],
      } : undefined);
    });
  }

  async send(args: Send) {
    return this.exclusive(args.agent_id, async () => {
      const agent = this.owned(args.group_id, args.agent_id);
      if (args.reply_to) {
        const pending = this.questions.get(agent.id);
        if (pending?.id !== args.reply_to) throw new ToolError("question_not_pending", "Read the agent's current question ID before replying.");
        this.answer(agent, args.text, true);
        this.state.event(agent, "answered", output(args.text, 1_000), pending.id);
        return { delivery: "answer", ...this.view(agent) };
      }
      if (agent.question && args.delivery === "steer") {
        throw new ToolError("reply_required", "This agent is waiting for an answer. Include its question ID as reply_to.");
      }
      if (agent.status === "running" && agent.turn && args.delivery === "steer") {
        await this.codex.request("turn/steer", {
          threadId: agent.thread, expectedTurnId: agent.turn, input: inputs(args.text),
        });
        this.state.event(agent, "steered", output(args.text, 1_000));
        return { delivery: "steer", ...this.view(this.state.require(agent.group, agent.id)) };
      }
      this.enqueue(agent, args.text);
      return { delivery: "queued", ...this.view(agent) };
    });
  }

  list(group: string) {
    const agents = this.state.group(group);
    if (!agents.length) throw new ToolError("group_not_found", "Use a group ID returned by codex_spawn.");
    return { group_id: group, agents: agents.map((agent) => this.view(agent)) };
  }

  async wait(group: string, ids: string[], after: number, mode: "any" | "all_finished", seconds: number, signal: AbortSignal) {
    const initial = ids.length ? ids.map((id) => this.state.require(group, id)) : this.state.group(group);
    if (!initial.length) throw new ToolError("group_not_found", "Use a group ID returned by codex_spawn.");
    const targets = initial.map((agent) => ({ id: agent.id, generation: agent.generation }));
    const deadline = Date.now() + seconds * 1_000;
    while (true) {
      const agents = targets.map((target) => this.state.require(group, target.id));
      const events = this.state.recent(group, ids, after, 20);
      const done = agents.every((agent, index) => agent.settled >= targets[index].generation || !ownerAlive(agent.owner));
      const needsInput = agents.some((agent) => agent.question && ownerAlive(agent.owner));
      const needsApproval = agents.some((agent) => agent.approvals?.length && ownerAlive(agent.owner));
      const newApproval = needsApproval && events.some((event) => event.kind === "approval_requested");
      const timedOut = Date.now() >= deadline;
      if (done || needsInput || newApproval || timedOut || (mode === "any" && events.length)) {
        return {
          group_id: group,
          reason: newApproval ? "needs_approval" : needsInput ? "needs_input" : done ? "all_finished" : (mode === "any" && events.length) ? "event" : "timeout",
          events, cursor: events.at(-1)?.seq ?? after, agents: agents.map((agent) => this.view(agent)),
        };
      }
      await delay(Math.min(200, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }

  async interrupt(group: string, id: string) {
    return this.exclusive(id, async () => {
      const agent = this.state.require(group, id);
      return this.stopTurn(agent.owner === ownerId && agent.approvals?.length ? agent : this.owned(group, id));
    });
  }

  async close(group: string, id: string) {
    return this.exclusive(id, async () => {
      const agent = this.state.require(group, id);
      if (agent.status === "closed") return this.view(agent);
      if (agent.owner && agent.owner !== ownerId && ownerAlive(agent.owner)) {
        throw new ToolError("other_connection", "Close this agent from its originating desktop connection.");
      }
      if (agent.owner === ownerId && busy(agent)) await this.stopTurn(agent, true);
      const current = this.state.require(group, id);
      if (current.owner === ownerId && current.thread) {
        await this.codex.request("thread/unsubscribe", { threadId: current.thread });
        this.byThread.delete(current.thread);
      }
      this.clearDeadline(id);
      current.status = "closed";
      current.settled = current.generation;
      current.owner = undefined;
      current.turn = undefined;
      current.question = undefined;
      this.state.save(current);
      this.state.event(current, "closed", "Agent closed. Its saved session and workspace can be resumed.");
      return this.view(current);
    });
  }

  async resume(group: string, id: string) {
    return this.exclusive(id, async () => {
      let agent = this.state.require(group, id);
      if (!agent.thread) throw new ToolError("no_saved_session", "This agent did not start a Codex session. Spawn a new agent.");
      if (agent.owner === ownerId && this.byThread.has(agent.thread)) return this.view(agent);
      const savedThread = agent.thread;
      workspace(this.settings, agent.workspace, Boolean(agent.worktree) && !approvalsEnabled(this.settings));
      this.state.change(() => {
        agent = this.state.require(group, id);
        if (agent.owner !== ownerId && ownerAlive(agent.owner)) {
          throw new ToolError("other_connection", "This agent is already attached to another live desktop connection.");
        }
        agent.owner = ownerId;
        agent.status = "idle";
        agent.settled = agent.generation;
        agent.question = undefined;
        agent.approvals = undefined;
        agent.turn = undefined;
        this.state.save(agent);
      });
      try {
        await this.codex.request("thread/resume", { threadId: savedThread, excludeTurns: true, ...await this.threadOptions(agent) });
        this.byThread.set(savedThread, agent.id);
        this.state.event(agent, "resumed", "Session restored. Use codex_followup to start another turn.");
        return this.view(agent);
      } catch (error) {
        const current = this.state.require(group, id);
        current.owner = undefined;
        this.finish(current, "failed", this.describe(error));
        throw error;
      }
    });
  }

  changes(group: string, id: string, path?: string) {
    return readChanges(this.settings, this.state.require(group, id), path);
  }

  checkGroup(group: string) { this.list(group); }

  async models(cursor?: string, limit = 30) {
    const allow = this.settings.allowed_models;
    const result = await this.codex.request("model/list", { cursor, limit, includeHidden: false });
    const rows = Array.isArray(result.data) ? result.data.map(record) : [];
    const models = rows.flatMap((row) => {
      const model = message(row.model) ?? message(row.id);
      const id = message(row.id) ?? model;
      if (!model || !id || row.hidden === true || (allow.length && !allow.includes(model) && !allow.includes(id))) return [];
      const efforts = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map(record) : [];
      return [{
        model, id, name: message(row.displayName) ?? model,
        default: row.isDefault === true, default_effort: message(row.defaultReasoningEffort),
        efforts: efforts.map((effort) => message(effort.reasoningEffort)).filter((effort): effort is string => Boolean(effort)),
      }];
    });
    return { models, cursor: message(result.nextCursor) ?? null };
  }

  private async selectModel(cwd: string, requested?: string, effort?: string) {
    if (!requested && !effort) return;
    const config = requested ? {} : record((await this.codex.request("config/read", { cwd, includeLayers: false })).config);
    const target = requested ?? message(config.model);
    let cursor: string | undefined;
    do {
      const page = await this.models(cursor, 50);
      const match = page.models.find((model) => target ? [model.model, model.id].includes(target) : model.default);
      if (match) {
        if (effort && match.efforts.length && !match.efforts.includes(effort)) {
          throw new ToolError("unsupported_effort", `${match.model} offers: ${match.efforts.join(", ")}.`);
        }
        return requested ? match.model : undefined;
      }
      cursor = page.cursor && page.cursor !== cursor ? page.cursor : undefined;
    } while (cursor);
    if (requested) throw new ToolError("model_not_available", "Call codex_models and select a model offered by this Codex account and server.");
    return undefined;
  }

  private checkCapacity(group: string) {
    if (this.state.countActive(group) >= this.settings.max_parallel) {
      throw new ToolError("concurrency_limit", "Wait for a task to finish or interrupt an agent before starting another.");
    }
  }

  private owned(group: string, id: string) {
    const agent = this.state.require(group, id);
    if (agent.owner !== ownerId || agent.status === "closed" || !agent.thread || !this.byThread.has(agent.thread)) {
      throw new ToolError("agent_detached", "Use codex_resume to attach this saved agent before sending work.");
    }
    return agent;
  }

  private view(agent: Agent) {
    const active = ownerAlive(agent.owner);
    return {
      group_id: agent.group, agent_id: agent.id, role: agent.role, parent_id: agent.parent,
      model: agent.model, effort: agent.effort,
      status: !active && busy(agent) ? "interrupted" : active && agent.approvals?.length ? "needs_approval" : agent.status,
      attached: active, generation: agent.generation, queued_messages: agent.queue.length,
      task: output(agent.followup_task ?? agent.task, 500), question: active ? agent.question : undefined, result: agent.last,
      approvals: active ? agent.approvals : undefined,
      workspace: agent.workspace, worktree_path: agent.worktree?.path, base_commit: agent.worktree?.base,
      network: Boolean(agent.network || this.settings.sandbox_network),
    };
  }

  private approvalPolicy() {
    if (!approvalsEnabled(this.settings)) return "never";
    if (this.settings.approval_policy === "granular") {
      return {
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: false,
          request_permissions: true,
          mcp_elicitations: false,
        },
      };
    }
    return this.settings.approval_policy;
  }

  private sandboxPolicy(agent: Agent) {
    const networkAccess = Boolean(agent.network || this.settings.sandbox_network);
    if (agent.worktree) {
      const writableRoots = [...new Set([
        agent.worktree.path,
        ...(agent.worktree.git_dir ? [agent.worktree.git_dir] : []),
        ...this.settings.extra_writable_roots,
      ])];
      return {
        type: "workspaceWrite" as const,
        writableRoots,
        networkAccess,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    }
    return {
      type: "readOnly" as const,
      networkAccess,
    };
  }

  private async threadOptions(agent: Agent) {
    // The user's Codex login still applies; the delegation thread must not
    // launch the user's or repository's unrelated plugins and MCP servers.
    const effective = record((await this.codex.request("config/read", { cwd: agent.cwd, includeLayers: false })).config);
    const disable = (value: unknown) => Object.fromEntries(
      Object.keys(record(value)).map((key) => [key, { enabled: false }]),
    );
    const developerInstructions = [
      roles[agent.role],
      "You are a subagent delegated by Antigravity. Use report_to_parent for meaningful interim findings and ask_parent for a blocking clarification.",
      "The parent reviews your result. Report concrete evidence and tests run. Follow the workspace instructions.",
      agent.worktree ? "Work in the assigned isolated Git worktree. Leave changes for the parent to review." : "This is a read-only task.",
    ].join("\n");
    return {
      cwd: agent.cwd,
      approvalPolicy: this.approvalPolicy(),
      ...(this.settings.approvals_reviewer ? { approvalsReviewer: this.settings.approvals_reviewer } : {}),
      sandbox: agent.worktree ? "workspace-write" : "read-only",
      model: agent.model, developerInstructions, ephemeral: false,
      config: { mcp_servers: disable(effective.mcp_servers), plugins: disable(effective.plugins) },
    };
  }

  private dynamicTools() {
    const tools = mailboxTools.map(({ name, description, field }) => ({
      name, description, inputSchema: {
        type: "object", properties: { [field]: { type: "string", minLength: 1, maxLength: 6_000 } },
        required: [field], additionalProperties: false,
      },
    }));
    return [
      ...tools,
      {
        name: "message_peer", description: "Send context to a known peer agent ID in this group.",
        inputSchema: {
          type: "object", properties: { agent_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 6_000 } },
          required: ["agent_id", "text"], additionalProperties: false,
        },
      },
      ...(this.settings.max_depth > 1 ? [{
        name: "delegate_child", description: "Start a read-only child agent in this group. The parent can inspect it and its result.",
        inputSchema: {
          type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 6_000 } },
          required: ["task"], additionalProperties: false,
        },
      }] : []),
    ];
  }

  private async startTurn(agent: Agent, task: string, context?: string) {
    const queued = [...agent.queue];
    const text = [itemText("Assigned task", task), ...(context ? [itemText("Parent context", context)] : []),
      ...(queued.length ? [itemText("Queued messages from Antigravity", queued.join("\n\n"))] : [])].join("\n\n");
    let result: Record<string, unknown>;
    try {
      result = await this.codex.request("turn/start", {
        threadId: agent.thread, input: inputs(text), effort: agent.effort,
        sandboxPolicy: this.sandboxPolicy(agent),
        clientUserMessageId: randomUUID(),
      });
    } catch (error) {
      // A timeout does not prove that Codex did not start the turn.
      if (error instanceof ToolError && error.code === "codex_timeout") this.codex.stop();
      throw error;
    }
    const current = this.state.require(agent.group, agent.id);
    if (current.owner !== ownerId || current.generation !== agent.generation) return;
    const turn = message(record(result.turn).id);
    if (!turn) {
      this.codex.stop();
      throw new ToolError("missing_turn", "Codex did not return the new turn ID.");
    }
    current.queue.splice(0, queued.length);
    this.state.save(current);
    if (current.status === "starting") this.markStarted(current, turn);
  }

  private activeTurn(agent: Agent) {
    const current = this.state.find(agent.id);
    if (current?.owner === ownerId && current.generation === agent.generation && busy(current)) return current;
  }

  private async launch(
    agent: Agent,
    start: (agent: Agent, decision?: Decision) => Promise<void>,
    approval?: { kind: string; summary: string; details: Record<string, unknown>; options: ApprovalOption[] },
  ) {
    const run = async (decision?: Decision) => {
      const current = this.activeTurn(agent);
      if (!current) return this.view(this.state.require(agent.group, agent.id));
      try {
        await start(current, decision);
        return this.view(this.state.require(agent.group, agent.id));
      } catch (error) {
        const failed = this.activeTurn(agent);
        if (failed) {
          this.finish(failed, "failed", this.describe(error));
        }
        throw error;
      }
    };
    if (!approval) return run();
    void this.askApproval(agent, approval.kind, approval.summary, approval.details, approval.options).then(async (decision) => {
      const current = this.activeTurn(agent);
      if (!current) return;
      if (isApprovedDecision(decision)) await run(decision);
      else this.finish(current, "interrupted", `${approval.kind} approval ${decision}. No turn started.`);
    }).catch(() => {
      const current = this.activeTurn(agent);
      if (current) this.finish(current, "failed", "The upfront approval could not be processed.");
    });
    return this.view(this.state.require(agent.group, agent.id));
  }

  private async askApproval(
    agent: Agent,
    kind: string,
    summary: string,
    details: Record<string, unknown>,
    options: ApprovalOption[],
    rpc?: Id,
  ): Promise<Decision> {
    const seconds = this.settings.approval_timeout_seconds;
    const notice: ApprovalNotice = {
      id: randomUUID(),
      kind,
      summary,
      details,
      options,
      expires_at: new Date(Date.now() + seconds * 1_000).toISOString(),
    };
    const cancel = new AbortController();
    const dialogCancel = new AbortController();
    const abortDialog = () => dialogCancel.abort();
    if (cancel.signal.aborted) dialogCancel.abort();
    else cancel.signal.addEventListener("abort", abortDialog, { once: true });

    let resolvePanel!: (choice: ApprovalChoice) => void;
    let settledPanel = false;
    const panelPromise = new Promise<Decision>((resolve) => {
      resolvePanel = (choice) => {
        if (settledPanel) return;
        settledPanel = true;
        dialogCancel.abort();
        resolve(choice === "decline" ? "declined" : choice);
      };
    });

    this.approvals.set(notice.id, {
      agent: agent.id,
      group: agent.group,
      rpc,
      cancel,
      options,
      resolve: resolvePanel,
    });
    this.pauseDeadline(agent.id);
    const current = this.state.require(agent.group, agent.id);
    current.approvals = [...(current.approvals ?? []), notice];
    this.state.save(current);
    const mode = effectiveApprovalMode(this.settings);
    const waitHint = mode === "panel"
      ? "Waiting for a human decision in the Codex side panel."
      : mode === "dialog"
        ? "Waiting for a human decision in the local desktop dialog."
        : "Waiting for a human decision in the Codex side panel or local desktop dialog.";
    this.state.event(current, "approval_requested", `${kind} · ${notice.id} · ${summary} · ${waitHint}`);

    let decision: Decision = "unavailable";
    const startedAt = Date.now();
    const waitPanel = (ms: number) => {
      const expires = AbortSignal.timeout(Math.max(1, ms));
      return Promise.race([
        panelPromise,
        waitAbort(cancel.signal, "cancelled" as const),
        waitAbort(expires, "expired" as const),
      ]);
    };

    try {
      if (mode === "panel") {
        decision = await waitPanel(seconds * 1_000);
      } else if (mode === "dialog") {
        const result = await this.dialogs.ask({
          审批编号: notice.id, 审批类别: kind, 代理: agent.id, 项目: agent.workspace, 工作目录: agent.cwd, ...details,
        }, seconds, dialogCancel.signal);
        decision = result.decision;
        if (result.decision === "unavailable" && result.detail) {
          const updated = this.activeTurn(agent);
          if (updated) this.state.event(updated, "approval_dialog_unavailable", `${kind} · ${notice.id} · ${result.detail}`);
        }
      } else if (mode === "panel_or_dialog") {
        if (!this.settings.approval_dialog || this.isPanelActive()) {
          decision = await waitPanel(seconds * 1_000);
        } else {
          const dialogPromise = this.dialogs.ask({
            审批编号: notice.id, 审批类别: kind, 代理: agent.id, 项目: agent.workspace, 工作目录: agent.cwd, ...details,
          }, seconds, dialogCancel.signal);
          const raceResult = await Promise.race([
            panelPromise.then((value) => ({ source: "panel" as const, decision: value })),
            waitAbort(cancel.signal, { source: "cancel" as const, decision: "cancelled" as const }),
            dialogPromise.then((outcome) => ({ source: "dialog" as const, outcome })),
          ]);
          if (raceResult.source === "panel" || raceResult.source === "cancel") {
            dialogCancel.abort();
            decision = raceResult.decision;
          } else if (raceResult.outcome.decision !== "unavailable") {
            decision = raceResult.outcome.decision;
          } else {
            const updated = this.activeTurn(agent);
            if (updated) {
              this.state.event(
                updated,
                "approval_dialog_unavailable",
                `${kind} · ${notice.id} · ${raceResult.outcome.detail ?? "Approval dialog unavailable; waiting for side panel decision."}`,
              );
            }
            const remainingMs = Math.max(1_000, seconds * 1_000 - (Date.now() - startedAt));
            decision = await waitPanel(remainingMs);
          }
        }
      }
    } finally {
      cancel.signal.removeEventListener("abort", abortDialog);
      dialogCancel.abort();
      this.approvals.delete(notice.id);
      const updated = this.activeTurn(agent);
      if (updated) {
        const remaining = updated.approvals?.filter((entry) => entry.id !== notice.id);
        updated.approvals = remaining?.length ? remaining : undefined;
        this.state.save(updated);
        const eventKind = decision === "once" ? "approval_approved" : `approval_${decision}`;
        this.state.event(updated, eventKind, `${kind} · ${notice.id}`);
        if (!updated.approvals?.length) this.resumeDeadline(agent.id);
      }
    }
    return decision;
  }

  private markStarted(agent: Agent, turn: string) {
    agent.turn = turn;
    agent.status = "running";
    this.state.save(agent);
    this.state.event(agent, "running", "Codex started the turn.");
    this.clearDeadline(agent.id);
    this.startDeadline(agent.id, this.settings.max_turn_seconds * 1_000);
  }

  private startDeadline(id: string, remainingMs: number) {
    if (remainingMs <= 0) return;
    const timer = setTimeout(() => {
      const current = this.state.find(id);
      if (!current || !busy(current)) return;
      this.state.event(current, "time_limit", "The configured turn deadline elapsed.");
      void this.stopTurn(current).catch(() => this.codex.stop());
    }, remainingMs);
    this.deadlines.set(id, { timer, remainingMs, startedAt: Date.now() });
  }

  private pauseDeadline(id: string) {
    const entry = this.deadlines.get(id);
    if (!entry?.timer) return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const elapsed = entry.startedAt ? Date.now() - entry.startedAt : 0;
    entry.remainingMs = Math.max(1_000, entry.remainingMs - elapsed);
    entry.startedAt = undefined;
  }

  private resumeDeadline(id: string) {
    const entry = this.deadlines.get(id);
    if (!entry || entry.timer) return;
    this.startDeadline(id, entry.remainingMs);
  }

  private async stopTurn(agent: Agent, waitForDone = false) {
    if (!busy(agent)) return this.view(agent);
    if (!agent.turn) {
      if (!agent.approvals?.length) throw new ToolError("agent_starting", "The turn is still being started. Retry after the running event.");
      this.finish(agent, "interrupted", "Upfront approval cancelled before the turn started.");
      return this.view(agent);
    }
    this.interrupting.add(agent.id);
    this.cancelApprovals(agent.id);
    try {
      await this.codex.request("turn/interrupt", { threadId: agent.thread, turnId: agent.turn });
    } catch (error) {
      this.interrupting.delete(agent.id);
      const current = this.state.require(agent.group, agent.id);
      if (!busy(current)) return this.view(current);
      throw error;
    }
    if (waitForDone) {
      const deadline = Date.now() + 5_000;
      while (busy(this.state.require(agent.group, agent.id))) {
        if (Date.now() >= deadline) throw new ToolError("interrupt_pending", "Codex acknowledged the interrupt. Wait for its terminal event before closing.");
        await delay(100);
      }
    }
    return this.view(this.state.require(agent.group, agent.id));
  }

  private enqueue(agent: Agent, value: string) {
    if (agent.queue.length >= 12) throw new ToolError("mailbox_full", "Start a follow-up turn before queuing more messages.");
    agent.queue.push(output(value));
    this.state.save(agent);
    this.state.event(agent, "queued", output(value, 1_000));
  }

  private answer(agent: Agent, text: string, success: boolean) {
    const pending = this.questions.get(agent.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.questions.delete(agent.id);
    agent.question = undefined;
    if (agent.status === "needs_input") agent.status = "running";
    this.state.save(agent);
    this.codex.reply(pending.rpc, { success, contentItems: [{ type: "inputText", text }] });
  }

  private async serverRequest(id: Id, method: string, params: Record<string, unknown>) {
    const agent = this.findThread(params.threadId);
    if (method !== "item/tool/call") {
      if (method === "item/tool/requestUserInput") {
        this.codex.fail(id, "This desktop bridge handles parent questions through ask_parent.");
        return;
      }
      const item = agent ? this.approvalItems.get(agent.id)?.get(message(params.itemId) ?? "") : undefined;
      const handler = codexApproval(method, params, item, Boolean(agent?.worktree), {
        allowReadonlyCommandApproval: this.settings.allow_readonly_command_approval,
        fallbackCwd: agent?.cwd ?? this.settings.state_dir,
      });
      if (!handler) {
        if (agent) this.state.event(agent, "unhandled_request", `Unhandled Codex server request: ${method}`);
        this.codex.fail(id, `Unsupported Codex server request: ${method}`);
        return;
      }
      if (!agent || !agent.turn || agent.turn !== params.turnId || !busy(agent) || this.interrupting.has(agent.id)) {
        this.codex.reply(id, handler.respond("decline"));
        return;
      }
      if (!handler.offer || !approvalsEnabled(this.settings)) {
        const reason = handler.declineReason ?? "approvals_disabled";
        this.state.event(agent, "approval_auto_declined", `${method} · ${reason}`);
        this.codex.reply(id, handler.respond("decline"));
        return;
      }
      const decision = await this.askApproval(
        agent,
        handler.offer.kind,
        handler.offer.summary,
        handler.offer.details,
        handler.offer.options,
        id,
      );
      const current = this.activeTurn(agent);
      if (current?.turn === agent.turn && !this.stopping) {
        this.codex.reply(
          id,
          isApprovedDecision(decision) && !this.interrupting.has(agent.id)
            ? handler.respond(decision)
            : handler.respond("decline"),
        );
      }
      return;
    }
    const args = record(params.arguments);
    const reply = (text: string, success = true) => this.codex.reply(id, { success, contentItems: [{ type: "inputText", text }] });
    if (!agent || !busy(agent) || (agent.turn && params.turnId !== agent.turn)) {
      reply("This turn is no longer attached to an active agent.", false);
      return;
    }
    const tool = params.tool;
    const text = message(tool === "ask_parent" ? args.question : tool === "delegate_child" ? args.task : args.text)?.trim();
    if (!text || text.length > 6_000) { reply("Provide 1 to 6000 characters.", false); return; }
    if (tool === "report_to_parent") {
      this.state.event(agent, "report", text);
      reply("Delivered to the parent's mailbox.");
    } else if (tool === "ask_parent") {
      if (this.questions.has(agent.id)) { reply("One question is already waiting for a reply.", false); return; }
      const questionId = randomUUID();
      const timer = setTimeout(() => {
        const current = this.state.find(agent.id);
        if (!current || this.questions.get(agent.id)?.id !== questionId) return;
        this.answer(current, "The parent did not answer before the clarification deadline. Report the blocker or continue only where assumptions are safe.", false);
        this.state.event(current, "question_expired", "The clarification deadline elapsed.", questionId);
      }, this.settings.question_timeout_seconds * 1_000);
      this.questions.set(agent.id, { id: questionId, rpc: id, timer });
      agent.status = "needs_input";
      agent.question = { id: questionId, text };
      this.state.save(agent);
      this.state.event(agent, "question", text, questionId);
    } else if (tool === "message_peer") {
      try {
        const peer = this.owned(agent.group, message(args.agent_id) ?? "");
        if (peer.id === agent.id) throw new ToolError("same_agent", "Select a different agent.");
        const result = await this.send({
          group_id: agent.group, agent_id: peer.id, text: `From peer ${agent.id}: ${text}`,
          delivery: peer.question ? "queue" : "steer",
        });
        reply(`Message ${result.delivery === "queued" ? "queued" : "delivered"} for ${peer.id}.`);
      } catch (error) { reply(this.describe(error), false); }
    } else if (tool === "delegate_child") {
      try {
        const child = await this.spawn({
          group_id: agent.group, task: text, workspace: agent.workspace, role: "explorer", mode: "read_only",
        }, agent);
        reply(`Started child ${child.agent_id}. Its final result will be sent to your mailbox.`);
      } catch (error) { reply(this.describe(error), false); }
    } else {
      reply("Unknown coordination tool.", false);
    }
  }

  private notify(method: string, params: Record<string, unknown>) {
    const agent = this.findThread(params.threadId);
    if (!agent || !busy(agent)) return;
    const turn = record(params.turn);
    if (method === "turn/started" && agent.status === "starting") {
      const id = message(turn.id);
      if (id) this.markStarted(agent, id);
      return;
    }
    if (agent.turn && (params.turnId ?? turn.id) && (params.turnId ?? turn.id) !== agent.turn) return;
    if (method === "item/started") {
      const item = record(params.item);
      const id = message(item.id);
      if (id && (item.type === "fileChange" || item.type === "commandExecution")) {
        const items = this.approvalItems.get(agent.id) ?? new Map<string, Record<string, unknown>>();
        items.set(id, item);
        this.approvalItems.set(agent.id, items);
      }
    } else if (method === "item/completed") {
      const item = record(params.item);
      this.approvalItems.get(agent.id)?.delete(message(item.id) ?? "");
      const text = message(item.text);
      if (item.type === "agentMessage" && text) {
        if (item.phase === "commentary") this.state.event(agent, "commentary", output(text, 2_000));
        else {
          agent.last = output(text);
          this.state.save(agent);
        }
      }
    } else if (method === "turn/completed") {
      const status = turn.status === "interrupted" ? "interrupted" : turn.status === "completed" ? "completed" : "failed";
      const description = agent.last ?? message(record(turn.error).message) ?? `Codex turn ${status}.`;
      this.finish(agent, status, output(description));
      if (agent.parent) {
        const parent = this.state.find(agent.parent);
        if (parent?.owner === ownerId && parent.thread && parent.status !== "closed") {
          void this.send({
            group_id: agent.group, agent_id: parent.id,
            text: `Child ${agent.id} ${status}: ${output(description, 3_000)}`,
            delivery: parent.question ? "queue" : "steer",
          }).catch(() => undefined);
        }
      }
    } else if (method === "serverRequest/resolved") {
      for (const pending of this.approvals.values()) {
        if (pending.agent === agent.id && pending.rpc === params.requestId) pending.cancel.abort();
      }
      const question = this.questions.get(agent.id);
      if (question && question.rpc === params.requestId) {
        clearTimeout(question.timer);
        this.questions.delete(agent.id);
        agent.question = undefined;
        if (agent.status === "needs_input") agent.status = "running";
        this.state.save(agent);
      }
    }
  }

  private findThread(thread: unknown) {
    const id = typeof thread === "string" ? this.byThread.get(thread) : undefined;
    return id ? this.state.find(id) : undefined;
  }

  private finish(agent: Agent, status: "completed" | "failed" | "interrupted", text: string) {
    this.cancelApprovals(agent.id);
    this.approvalItems.delete(agent.id);
    this.interrupting.delete(agent.id);
    const question = this.questions.get(agent.id);
    if (question) clearTimeout(question.timer);
    this.questions.delete(agent.id);
    this.clearDeadline(agent.id);
    agent.question = undefined;
    agent.approvals = undefined;
    agent.turn = undefined;
    agent.last = text;
    agent.status = status;
    if (!agent.thread) agent.owner = undefined;
    agent.settled = agent.generation;
    this.state.save(agent);
    this.state.event(agent, status, text);
  }

  private cancelApprovals(agent: string) {
    for (const pending of this.approvals.values()) {
      if (pending.agent === agent) pending.cancel.abort();
    }
  }

  private recoverOwned() {
    for (const agent of this.state.owned()) {
      agent.owner = undefined;
      if (busy(agent)) this.finish(agent, "interrupted", "The Codex connection closed. Resume the saved session before starting another turn.");
      else this.state.save(agent);
    }
    this.byThread.clear();
  }

  private clearDeadline(id: string) {
    const entry = this.deadlines.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.deadlines.delete(id);
  }

  private describe(error: unknown) {
    return output(error instanceof ToolError ? error.message : "The local Codex operation failed. Check the connection and agent state.", 500);
  }

  private async exclusive<T>(id: string, action: () => Promise<T>) {
    if (this.changing.has(id)) throw new ToolError("operation_pending", "Another operation is changing this agent. Retry after it returns.");
    this.changing.add(id);
    try { return await action(); }
    finally { this.changing.delete(id); }
  }
}
