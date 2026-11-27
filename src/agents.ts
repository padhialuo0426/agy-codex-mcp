import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Codex, message, output, record } from "./codex.js";
import { reapAgentProcesses, reapBridgeProcesses } from "./processes.js";
import { State, busy, ownerAlive, ownerId, type Agent, type AgentMode, type Role } from "./state.js";
import { ToolError, workspace, type Settings } from "./settings.js";
import { appendStream, buildWatchCommand, removeStream, type AgentActivity, type StreamChanges, type StreamEvent } from "./streams.js";
import { makeWorktree, planWorktree, readChanges, removePatch, removeWorktree, resolveInputPatch } from "./worktrees.js";

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
type RunArgs = {
  agent_id?: string;
  workspace?: string;
  task: string;
  context?: string;
  mode: AgentMode;
  role: Role;
  network?: boolean;
  model?: string;
  effort?: string;
  base?: string;
  input_patch?: string;
  input_patch_file?: string;
  fork_from?: string;
  background: boolean;
  keep_session?: boolean;
  wait_seconds: number;
  max_turn_seconds?: number;
  question_timeout_seconds?: number;
};
type SendArgs = {
  agent_id: string;
  text: string;
  mode: "auto" | "answer" | "steer" | "followup";
  wait: boolean;
  wait_seconds: number;
};
type ManageArgs = {
  action: "status" | "list" | "changes" | "interrupt" | "close" | "cleanup";
  agent_id?: string;
  path?: string;
  output_patch_path?: string;
  limit?: number;
};
export type ProgressCallback = (elapsedSec: number, activity?: AgentActivity) => void;

function itemText(label: string, text: string) {
  return `${label}:\n${text}`;
}

export class Agents {
  private readonly state: State;
  private readonly codex: Codex;
  private readonly byThread = new Map<string, string>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly interrupting = new Set<string>();
  private readonly pendingAbort = new Map<string, Promise<number>>();
  private readonly settling = new Map<string, Promise<void>>();
  private readonly lastReaped = new Map<string, number>();
  private readonly lastSeq = new Map<string, number>();
  private readonly deadlines = new Map<string, NodeJS.Timeout>();
  private readonly changing = new Set<string>();
  private readonly statusPolls = new Map<string, { lastAt: number; lastSeq: number; count: number }>();
  private stopping = false;

  constructor(private readonly settings: Settings) {
    this.state = new State(settings.state_dir);
    this.codex = new Codex(settings);
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
    void reapBridgeProcesses(this.codex.pid());
    this.codex.stop();
  }

  async run(args: RunArgs, signal?: AbortSignal, onProgress?: ProgressCallback) {
    if (this.stopping) throw new ToolError("server_stopping", "The MCP server is shutting down.");
    const startCursor = this.state.latestSeq();
    const agent = args.agent_id
      ? await this.continueAgent(
        args.agent_id,
        args.task,
        args.context,
        args.keep_session,
        args.max_turn_seconds,
        args.question_timeout_seconds,
      )
      : await this.spawnNew(args);
    if (args.background || args.wait_seconds === 0) {
      const latest = this.state.require(agent.agent_id);
      const cursor = startCursor;
      return {
        ...agent,
        cursor,
        watch_command: buildWatchCommand(this.settings.state_dir, agent.agent_id, cursor),
        recommended_notification_timeout_seconds: this.recommendedWatchTimeout(latest),
      };
    }
    return this.waitUntilSettled(agent.agent_id, args.wait_seconds, startCursor, signal, onProgress);
  }

  async send(args: SendArgs, signal?: AbortSignal, onProgress?: ProgressCallback) {
    const startCursor = this.currentSeq(args.agent_id, 0);
    const outcome = await this.exclusive(args.agent_id, async () => {
      const agent = this.state.require(args.agent_id);
      if (args.mode === "answer" || (args.mode === "auto" && agent.question)) {
        if (!agent.question) {
          throw new ToolError("question_not_pending", "This agent has no pending ask_parent question to answer.");
        }
        const ownedAgent = this.owned(agent.id);
        const pending = this.questions.get(ownedAgent.id);
        if (!pending) {
          throw new ToolError("question_not_pending", "This agent has no pending ask_parent question to answer.");
        }
        const answered_question = agent.question.text;
        this.answer(ownedAgent, args.text, true);
        this.emitEvent(ownedAgent, "answered", output(args.text, 1_000), { questionId: pending.id });
        return { delivery: "answer" as const, answered_question, waitable: true, view: this.view(this.state.require(ownedAgent.id)) };
      }
      if (args.mode === "steer" || (args.mode === "auto" && agent.status === "running" && agent.turn)) {
        const ownedAgent = this.owned(agent.id);
        if (ownedAgent.status === "running" && ownedAgent.turn) {
          await this.codex.request("turn/steer", {
            threadId: ownedAgent.thread, expectedTurnId: ownedAgent.turn, input: inputs(args.text),
          });
          this.emitEvent(ownedAgent, "steered", output(args.text, 1_000));
          return { delivery: "steer" as const, waitable: false, view: this.view(this.state.require(ownedAgent.id)) };
        }
        const pending_question = ownedAgent.question?.text;
        this.enqueue(ownedAgent, args.text);
        return {
          delivery: "queued" as const,
          ...(pending_question ? { pending_question } : {}),
          waitable: false,
          view: this.view(this.state.require(ownedAgent.id)),
        };
      }
      if (busy(agent)) {
        throw new ToolError("agent_busy", "This agent is currently running. Use mode='steer' or wait for it to settle.");
      }
      await this.resumeIfNeeded(agent.id);
      const started = await this.startFollowupUnlocked(agent.id, args.text);
      return { delivery: "followup" as const, waitable: true, view: started };
    });

    if (args.wait && outcome.waitable) {
      return this.waitUntilSettled(args.agent_id, args.wait_seconds, startCursor, signal, onProgress);
    }
    const latest = this.state.require(args.agent_id);
    const cursor = this.currentSeq(args.agent_id, startCursor);
    return {
      delivery: outcome.delivery,
      ...("answered_question" in outcome && outcome.answered_question ? { answered_question: outcome.answered_question } : {}),
      ...("pending_question" in outcome && outcome.pending_question ? { pending_question: outcome.pending_question } : {}),
      ...this.view(latest),
      ...(busy(latest) ? {
        cursor,
        watch_command: buildWatchCommand(this.settings.state_dir, args.agent_id, cursor),
        recommended_notification_timeout_seconds: this.recommendedWatchTimeout(latest),
      } : {}),
    };
  }

  async manage(args: ManageArgs) {
    if (args.action === "list") {
      return {
        agents: this.state.listRecent(args.limit ?? 20).map((agent) => {
          const v = this.view(agent);
          return {
            agent_id: v.agent_id,
            role: v.role,
            mode: v.mode,
            status: v.status,
            elapsed_seconds: v.elapsed_seconds,
            activity: v.activity,
            worktree_path: v.worktree_path,
            question: v.question,
            task: output(agent.followup_task ?? agent.task, 160),
          };
        }),
      };
    }
    if (args.action === "cleanup") {
      return this.cleanupSettled();
    }
    const agentId = args.agent_id;
    if (!agentId) {
      throw new ToolError("agent_required", `Action '${args.action}' requires agent_id.`);
    }
    if (args.action === "status") {
      const pending = this.settling.get(agentId);
      if (pending) await pending.catch(() => undefined);
      const agent = this.state.require(agentId);
      const recent_events = this.state.recentForAgents([agentId], 0, 15);
      const view = this.view(agent);
      const cursor = this.currentSeq(agentId, recent_events.at(-1)?.seq ?? 0);
      let polling_warning: string | undefined;
      if (busy(agent)) {
        const now = Date.now();
        const prev = this.statusPolls.get(agentId);
        const count = prev && now - prev.lastAt <= 60_000 && prev.lastSeq === cursor ? prev.count + 1 : 1;
        this.statusPolls.set(agentId, { lastAt: now, lastSeq: cursor, count });
        if (count >= 2) {
          polling_warning = "Repeated status polling detected with no new events. Stop polling codex_manage(status); run watch_command in a background shell task and end your turn for zero-token wakeup.";
        }
      } else {
        this.statusPolls.delete(agentId);
      }
      return {
        ...view,
        recent_events,
        ...(agent.last_changes ? { changes: agent.last_changes } : {}),
        ...(polling_warning ? { polling_warning } : {}),
        ...(busy(agent) ? {
          cursor,
          watch_command: buildWatchCommand(this.settings.state_dir, agentId, cursor),
          recommended_notification_timeout_seconds: this.recommendedWatchTimeout(agent),
        } : {}),
      };
    }
    if (args.action === "changes") {
      return readChanges(this.settings, this.state.require(agentId), {
        path: args.path,
        exportPatch: true,
        outputPatchPath: args.output_patch_path,
      });
    }
    if (args.action === "interrupt") {
      return this.exclusive(agentId, async () => {
        const reaped = await this.abortTurnAndReap(this.owned(agentId).id, "Codex turn interrupted.");
        const pending = this.settling.get(agentId);
        if (pending) await pending.catch(() => undefined);
        return { ...this.view(this.state.require(agentId)), reaped_processes: reaped };
      });
    }
    return this.close(agentId);
  }

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

  private currentSeq(agentId: string, fallback = 0): number {
    return this.lastSeq.get(agentId) ?? fallback;
  }

  private recommendedWatchTimeout(agent: Agent): number {
    return Math.min(3_600, Math.max(1_800, agent.max_turn_seconds ?? this.settings.max_turn_seconds));
  }

  private emitEvent(
    agent: Agent,
    kind: StreamEvent["kind"],
    text: string,
    extra?: {
      sqlKind?: string;
      questionId?: string;
      result?: string;
      worktree_path?: string;
      changes?: StreamChanges;
      owner_pid?: number;
      statusOverride?: string;
      session_closed?: boolean;
    },
  ): number {
    const seq = this.state.event(agent, extra?.sqlKind ?? kind, text, extra?.questionId);
    this.lastSeq.set(agent.id, seq);
    appendStream(this.settings.state_dir, agent.id, {
      seq,
      at: new Date().toISOString(),
      kind,
      status: extra?.statusOverride ?? agent.status,
      ...(extra?.session_closed !== undefined ? { session_closed: extra.session_closed } : {}),
      ...(extra?.owner_pid !== undefined ? { owner_pid: extra.owner_pid } : {}),
      text,
      ...(extra?.questionId ? { question_id: extra.questionId } : {}),
      ...(agent.activity ? { activity: agent.activity } : {}),
      ...(extra?.result !== undefined ? { result: extra.result } : {}),
      ...(extra?.worktree_path ? { worktree_path: extra.worktree_path } : {}),
      ...(extra?.changes ? { changes: extra.changes } : {}),
    });
    return seq;
  }

  private async spawnNew(args: {
    workspace?: string; task: string; context?: string; mode: AgentMode; role: Role;
    network?: boolean; model?: string; effort?: string; base?: string; input_patch?: string; input_patch_file?: string;
    fork_from?: string; keep_session?: boolean; max_turn_seconds?: number; question_timeout_seconds?: number;
  }, parent?: Agent) {
    if (!args.workspace) {
      throw new ToolError("workspace_required", "Provide workspace when starting a new agent, or pass agent_id to continue an existing one.");
    }
    const cwd = workspace(this.settings, args.workspace);
    if ((args.base || args.input_patch || args.input_patch_file) && args.mode !== "worktree") {
      throw new ToolError("worktree_required", "A base commit or input patch requires worktree mode.");
    }
    const resolvedPatch = resolveInputPatch(args.input_patch, args.input_patch_file);
    const plan = args.mode === "worktree" ? await planWorktree(this.settings, cwd, args.base) : undefined;
    const selectedModel = await this.selectModel(cwd, args.model, args.effort);
    const id = randomUUID();
    const ephemeral = !this.settings.persist_threads;
    const agent: Agent = {
      id, group: "default", role: args.role, mode: args.mode, task: args.task, workspace: cwd, cwd,
      status: "starting", owner: ownerId, generation: 1, settled: 0, queue: [],
      parent: parent?.id, depth: parent ? parent.depth + 1 : 1, model: selectedModel, effort: args.effort,
      network: args.network, ephemeral, keep_session: args.keep_session ?? false,
      max_turn_seconds: args.max_turn_seconds,
      question_timeout_seconds: args.question_timeout_seconds,
    };
    let source: Agent | undefined;
    this.state.change(() => {
      if (agent.depth > this.settings.max_depth) throw new ToolError("depth_limit", "Nested delegation has reached its configured depth limit.");
      if (args.fork_from) {
        source = this.state.require(args.fork_from);
        if (!source.thread || busy(source) || source.workspace !== cwd || source.status === "closed") {
          throw new ToolError("fork_unavailable", "Fork a live settled Codex agent in the same workspace (pass keep_session: true on the source agent).");
        }
      }
      this.checkCapacity();
      this.state.save(agent);
      this.emitEvent(agent, "started", output(args.task, 1_000), { sqlKind: "starting", owner_pid: process.pid });
    });
    return this.launch(agent, async (current) => {
      if (plan) {
        const tree = await makeWorktree(this.settings, current, plan, resolvedPatch);
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
    });
  }

  private async continueAgent(
    agentId: string,
    task: string,
    context?: string,
    keepSession?: boolean,
    maxTurnSeconds?: number,
    questionTimeoutSeconds?: number,
  ) {
    return this.exclusive(agentId, async () => {
      const current = this.state.require(agentId);
      if (busy(current)) {
        throw new ToolError("agent_busy", "This agent is currently busy. Use codex_send or codex_manage instead.");
      }
      await this.resumeIfNeeded(agentId);
      if (keepSession !== undefined || maxTurnSeconds !== undefined || questionTimeoutSeconds !== undefined) {
        const latest = this.state.require(agentId);
        if (keepSession !== undefined) latest.keep_session = keepSession;
        if (maxTurnSeconds !== undefined) latest.max_turn_seconds = maxTurnSeconds;
        if (questionTimeoutSeconds !== undefined) latest.question_timeout_seconds = questionTimeoutSeconds;
        this.state.save(latest);
      }
      return this.startFollowupUnlocked(agentId, task, context);
    });
  }

  private async startFollowupUnlocked(agentId: string, task: string, context?: string) {
    const agent = this.owned(agentId);
    this.state.change(() => {
      if (busy(agent)) throw new ToolError("agent_busy", "This agent is currently busy.");
      this.checkCapacity();
      agent.status = "starting";
      agent.followup_task = task;
      agent.generation++;
      agent.turn = undefined;
      agent.last = undefined;
      agent.last_changes = undefined;
      agent.activity = undefined;
      this.state.save(agent);
      this.emitEvent(agent, "started", output(task, 1_000), { sqlKind: "starting", owner_pid: process.pid });
    });
    return this.launch(agent, (current) => this.startTurn(current, task, context));
  }

  private async resumeIfNeeded(id: string) {
    let agent = this.state.require(id);
    if (agent.owner === ownerId && agent.status !== "closed" && agent.thread && this.byThread.has(agent.thread)) {
      return agent;
    }
    if (agent.ephemeral) {
      throw new ToolError(
        "session_closed",
        "This ephemeral session was already closed after delivery. Start a new codex_run, or pass keep_session: true if you need multi-turn follow-ups.",
      );
    }
    if (!agent.thread) throw new ToolError("no_saved_session", "This agent did not start a Codex session. Start a new agent.");
    const savedThread = agent.thread;
    workspace(this.settings, agent.workspace);
    this.state.change(() => {
      agent = this.state.require(id);
      if (agent.owner && agent.owner !== ownerId && ownerAlive(agent.owner)) {
        throw new ToolError("other_connection", "This agent is already attached to another live connection.");
      }
      agent.owner = ownerId;
      agent.status = "idle";
      agent.settled = agent.generation;
      agent.question = undefined;
      agent.turn = undefined;
      this.state.save(agent);
    });
    try {
      await this.codex.request("thread/resume", { threadId: savedThread, excludeTurns: true, ...await this.threadOptions(agent) });
      this.byThread.set(savedThread, agent.id);
      this.state.event(agent, "resumed", "Session reattached.");
      return agent;
    } catch (error) {
      const current = this.state.require(id);
      current.owner = undefined;
      void this.settleTurn(current.id, "failed", this.describe(error));
      throw error;
    }
  }

  private async waitUntilSettled(
    agentId: string,
    waitSeconds: number,
    startCursor: number,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ) {
    const initial = this.state.require(agentId);
    const targetGen = initial.generation;
    const startedAt = Date.now();
    const deadline = startedAt + waitSeconds * 1_000;
    let lastProgressAt = startedAt;
    while (true) {
      const current = this.state.require(agentId);
      const done = current.settled >= targetGen || !ownerAlive(current.owner);
      const needsInput = Boolean(current.question && ownerAlive(current.owner));
      const timedOut = Date.now() >= deadline;
      if (timedOut && !done && !needsInput) {
        const cursor = this.currentSeq(agentId, startCursor);
        return {
          ...this.view(current),
          still_running: true,
          cursor,
          watch_command: buildWatchCommand(this.settings.state_dir, agentId, cursor),
          recommended_notification_timeout_seconds: this.recommendedWatchTimeout(current),
        };
      }
      if (done || needsInput) {
        if (done) {
          const pending = this.settling.get(agentId);
          if (pending) await pending.catch(() => undefined);
          const aborting = this.pendingAbort.get(agentId);
          if (aborting) await aborting.catch(() => 0);
        }
        const finalAgent = this.state.require(agentId);
        const events = this.state.recentForAgents([agentId], startCursor, 30);
        const reports = events.filter((ev) => ev.kind === "report").map((ev) => ev.text);
        const cursor = this.currentSeq(agentId, events.at(-1)?.seq ?? startCursor);
        return {
          ...this.view(finalAgent),
          ...(finalAgent.last_changes ? { changes: finalAgent.last_changes } : {}),
          ...(reports.length ? { reports } : {}),
          ...(needsInput ? {
            requires_parent_answer: true,
            cursor,
            watch_command: buildWatchCommand(this.settings.state_dir, agentId, cursor),
            recommended_notification_timeout_seconds: this.recommendedWatchTimeout(finalAgent),
          } : {}),
        };
      }
      if (onProgress && Date.now() - lastProgressAt >= 15_000) {
        lastProgressAt = Date.now();
        onProgress(Math.round((lastProgressAt - startedAt) / 1_000), current.activity);
      }
      await delay(Math.min(150, Math.max(1, deadline - Date.now())), undefined, { signal });
    }
  }

  private settleTurn(agentId: string, status: "completed" | "failed" | "interrupted", description: string): Promise<void> {
    const existing = this.settling.get(agentId);
    if (existing) return existing;
    const task = (async () => {
      const current = this.state.find(agentId);
      if (!current) return;
      if (busy(current)) {
        this.finish(current, status, description);
      }
      const reaped = await reapAgentProcesses(agentId, this.codex.pid());
      if (reaped > 0) {
        this.lastReaped.set(agentId, (this.lastReaped.get(agentId) ?? 0) + reaped);
      }
      const settledAgent = this.state.find(agentId);
      if (!settledAgent) return;
      let changes: StreamChanges | undefined;
      if (settledAgent.worktree) {
        try {
          changes = await readChanges(this.settings, settledAgent, { exportPatch: true });
          settledAgent.last_changes = changes;
          this.state.save(settledAgent);
        } catch { /* Ignore diff read failure on settled summary. */ }
      }
      const autoClosed = !settledAgent.keep_session;
      if (autoClosed) {
        await this.releaseAfterDelivery(settledAgent, changes);
      }
      this.statusPolls.delete(agentId);
      const finalAgent = this.state.require(agentId);
      this.emitEvent(finalAgent, status, finalAgent.last ?? description, {
        result: finalAgent.last ?? description,
        worktree_path: finalAgent.worktree?.path,
        changes: finalAgent.last_changes ?? changes,
        statusOverride: status,
        session_closed: autoClosed,
      });
    })().finally(() => {
      this.settling.delete(agentId);
    });
    this.settling.set(agentId, task);
    return task;
  }

  private async abortTurnAndReap(agentId: string, reason?: string): Promise<number> {
    const existing = this.pendingAbort.get(agentId);
    if (existing) return existing;
    const task = (async () => {
      this.lastReaped.set(agentId, 0);
      const current = this.state.find(agentId);
      if (!current) return 0;
      if (reason && !current.last) {
        current.last = reason;
        this.state.save(current);
      }
      let reaped = 0;
      if (busy(current) && current.turn && current.thread && current.owner === ownerId && this.byThread.has(current.thread)) {
        try {
          reaped = (await this.stopTurnAndReap(current, true)).reaped;
        } catch {
          await this.settleTurn(agentId, "interrupted", reason ?? current.last ?? "The turn was interrupted.");
        }
      } else {
        await this.settleTurn(agentId, "interrupted", reason ?? current.last ?? "The turn was interrupted.");
      }
      const pendingSettle = this.settling.get(agentId);
      if (pendingSettle) await pendingSettle.catch(() => undefined);
      const after = this.state.find(agentId);
      if (after && busy(after)) {
        await this.settleTurn(agentId, "interrupted", reason ?? after.last ?? "The turn was interrupted.");
      } else if (after && reason && (!after.last || after.last === "Codex turn interrupted.")) {
        after.last = reason;
        this.state.save(after);
      }
      return Math.max(reaped, this.lastReaped.get(agentId) ?? 0);
    })().finally(() => {
      this.pendingAbort.delete(agentId);
    });
    this.pendingAbort.set(agentId, task);
    return task;
  }

  private async releaseAfterDelivery(
    agent: Agent,
    precomputedChanges?: { tracked: string; untracked: string },
  ) {
    const current = this.state.find(agent.id);
    if (!current || busy(current)) return;
    if (current.owner === ownerId && current.thread && this.byThread.has(current.thread)) {
      await this.codex.request("thread/unsubscribe", { threadId: current.thread }).catch(() => undefined);
      this.byThread.delete(current.thread);
    }
    if (!current.ephemeral && !this.settings.persist_threads && current.thread) {
      await this.codex.request("thread/delete", { threadId: current.thread }).catch(() => undefined);
    }
    if (current.worktree) {
      let empty = false;
      try {
        const summary = precomputedChanges ?? await readChanges(this.settings, current);
        empty = summary.tracked.trim() === "" && summary.untracked.trim() === "";
      } catch { /* Keep worktree if diff check fails. */ }
      if (empty) {
        await removeWorktree(this.settings, current.worktree);
        current.worktree = undefined;
        current.last_changes = undefined;
      }
    }
    this.clearDeadline(current.id);
    current.status = "closed";
    current.owner = undefined;
    current.turn = undefined;
    current.question = undefined;
    current.activity = undefined;
    this.state.save(current);
  }

  private async cleanupSettled() {
    let deleted_threads = 0;
    let removed_worktrees = 0;
    let pruned_agents = 0;
    for (const agent of this.state.listAll()) {
      if (ownerAlive(agent.owner) && busy(agent)) continue;
      if (agent.owner === ownerId && agent.thread && this.byThread.has(agent.thread)) {
        await this.codex.request("thread/unsubscribe", { threadId: agent.thread }).catch(() => undefined);
        this.byThread.delete(agent.thread);
      }
      if (!agent.ephemeral && agent.thread) {
        try {
          await this.codex.request("thread/delete", { threadId: agent.thread });
          deleted_threads++;
        } catch { /* Thread may already be absent or deleted. */ }
      }
      if (agent.worktree) {
        await removeWorktree(this.settings, agent.worktree);
        removed_worktrees++;
      }
      this.clearDeadline(agent.id);
      this.lastSeq.delete(agent.id);
      this.lastReaped.delete(agent.id);
      this.statusPolls.delete(agent.id);
      removeStream(this.settings.state_dir, agent.id);
      removePatch(this.settings.state_dir, agent.id);
      this.state.deleteAgent(agent.id);
      pruned_agents++;
    }
    return { deleted_threads, removed_worktrees, pruned_agents };
  }

  private async close(id: string) {
    return this.exclusive(id, async () => {
      const agent = this.state.require(id);
      if (agent.status === "closed") {
        await reapAgentProcesses(id, this.codex.pid());
        return this.view(agent);
      }
      if (agent.owner && agent.owner !== ownerId && ownerAlive(agent.owner)) {
        throw new ToolError("other_connection", "Close this agent from its originating connection.");
      }
      if (agent.owner === ownerId && busy(agent)) await this.stopTurnAndReap(agent, true);
      else await reapAgentProcesses(id, this.codex.pid());
      const pendingSettle = this.settling.get(id);
      if (pendingSettle) await pendingSettle.catch(() => undefined);
      const current = this.state.require(id);
      if (current.owner === ownerId && current.thread) {
        await this.codex.request("thread/unsubscribe", { threadId: current.thread }).catch(() => undefined);
        this.byThread.delete(current.thread);
      }
      this.clearDeadline(id);
      this.statusPolls.delete(id);
      current.status = "closed";
      current.settled = current.generation;
      current.owner = undefined;
      current.turn = undefined;
      current.question = undefined;
      current.activity = undefined;
      this.state.save(current);
      this.emitEvent(current, "closed", "Agent closed.", {
        result: current.last,
        worktree_path: current.worktree?.path,
        changes: current.last_changes,
      });
      return this.view(current);
    });
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

  private checkCapacity() {
    if (this.state.countActive() >= this.settings.max_parallel) {
      throw new ToolError("concurrency_limit", "Wait for a task to finish or interrupt an agent before starting another.");
    }
  }

  private owned(id: string) {
    const agent = this.state.require(id);
    if (agent.owner !== ownerId || agent.status === "closed" || !agent.thread || !this.byThread.has(agent.thread)) {
      throw new ToolError("agent_detached", "This agent is not attached to the active connection.");
    }
    return agent;
  }

  private agentMode(agent: Agent): AgentMode {
    return agent.mode ?? (agent.worktree ? "worktree" : "read_only");
  }

  private view(agent: Agent) {
    const active = ownerAlive(agent.owner);
    const elapsed_seconds = agent.turn_started_at && busy(agent)
      ? Math.max(0, Math.round((Date.now() - Date.parse(agent.turn_started_at)) / 1_000))
      : undefined;
    const activity = agent.activity && busy(agent)
      ? {
        ...agent.activity,
        elapsed_seconds: Math.max(0, Math.round((Date.now() - Date.parse(agent.activity.started_at)) / 1_000)),
      }
      : undefined;
    return {
      agent_id: agent.id,
      role: agent.role,
      mode: this.agentMode(agent),
      parent_id: agent.parent,
      model: agent.model,
      effort: agent.effort,
      status: !active && busy(agent) ? "interrupted" : agent.status,
      attached: active,
      generation: agent.generation,
      queued_messages: agent.queue.length,
      task: output(agent.followup_task ?? agent.task, 500),
      question: active ? agent.question : undefined,
      result: agent.last,
      workspace: agent.workspace,
      worktree_path: agent.worktree?.path,
      base_commit: agent.worktree?.base,
      network: Boolean(agent.network ?? this.settings.sandbox_network),
      ephemeral: agent.ephemeral ?? !this.settings.persist_threads,
      keep_session: Boolean(agent.keep_session),
      ...(elapsed_seconds !== undefined ? { elapsed_seconds } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  private sandboxPolicy(agent: Agent) {
    const mode = this.agentMode(agent);
    const networkAccess = Boolean(agent.network ?? this.settings.sandbox_network);
    if (mode === "read_only") {
      return { type: "readOnly" as const, networkAccess };
    }
    if (this.settings.sandbox_mode === "danger-full-access") {
      return { type: "dangerFullAccess" as const };
    }
    const writableRoots = [...new Set([
      agent.worktree?.path ?? agent.cwd,
      ...(agent.worktree?.git_dir ? [agent.worktree.git_dir] : []),
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

  private async threadOptions(agent: Agent) {
    // The user's Codex login still applies; the delegation thread must not
    // launch the user's or repository's unrelated plugins and MCP servers.
    const effective = record((await this.codex.request("config/read", { cwd: agent.cwd, includeLayers: false })).config);
    const disable = (value: unknown) => Object.fromEntries(
      Object.keys(record(value)).map((key) => [key, { enabled: false }]),
    );
    const existingShellEnv = Object.fromEntries(
      Object.entries(record(effective.shell_environment_policy)).filter(([, value]) => value !== null && value !== undefined),
    );
    const existingSet = Object.fromEntries(
      Object.entries(record(existingShellEnv.set)).filter(([, value]) => typeof value === "string"),
    );
    const shell_environment_policy = {
      ...existingShellEnv,
      set: {
        ...existingSet,
        AGY_CODEX_AGENT_ID: agent.id,
        AGY_CODEX_BRIDGE_PID: String(process.pid),
      },
    };
    const mode = this.agentMode(agent);
    const developerInstructions = [
      roles[agent.role],
      "You are a subagent delegated by Antigravity. Use report_to_parent for meaningful interim findings and ask_parent for a blocking clarification.",
      "The parent reviews your result. Report concrete evidence and tests run. Follow the workspace instructions.",
      mode === "worktree"
        ? "Work in the assigned isolated Git worktree. Leave changes for the parent to review."
        : mode === "workspace"
          ? "Edit directly in the assigned workspace directory within your assigned scope."
          : "This is a read-only task.",
    ].join("\n");
    const sandbox = mode === "read_only"
      ? "read-only"
      : this.settings.sandbox_mode === "danger-full-access"
        ? "danger-full-access"
        : "workspace-write";
    return {
      cwd: agent.cwd,
      approvalPolicy: "never" as const,
      sandbox,
      model: agent.model,
      developerInstructions,
      ephemeral: agent.ephemeral ?? !this.settings.persist_threads,
      config: {
        mcp_servers: disable(effective.mcp_servers),
        plugins: disable(effective.plugins),
        shell_environment_policy,
      },
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
        name: "message_peer", description: "Send context to a known peer agent ID.",
        inputSchema: {
          type: "object", properties: { agent_id: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 6_000 } },
          required: ["agent_id", "text"], additionalProperties: false,
        },
      },
      ...(this.settings.max_depth > 1 ? [{
        name: "delegate_child", description: "Start a read-only child agent. The parent can inspect it and its result.",
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
    const current = this.state.require(agent.id);
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

  private async launch(agent: Agent, start: (agent: Agent) => Promise<void>) {
    const current = this.activeTurn(agent);
    if (!current) return this.view(this.state.require(agent.id));
    try {
      await start(current);
      return this.view(this.state.require(agent.id));
    } catch (error) {
      const failed = this.activeTurn(agent);
      if (failed) await this.settleTurn(failed.id, "failed", this.describe(error));
      throw error;
    }
  }

  private markStarted(agent: Agent, turn: string) {
    const now = new Date().toISOString();
    agent.turn = turn;
    agent.status = "running";
    agent.turn_started_at = now;
    agent.activity = { kind: "thinking", detail: "Starting turn...", started_at: now, steps: agent.activity?.steps ?? 0 };
    this.state.save(agent);
    this.emitEvent(agent, "started", "Codex started the turn.", { sqlKind: "running", owner_pid: process.pid });
    this.clearDeadline(agent.id);
    const limitSeconds = agent.max_turn_seconds ?? this.settings.max_turn_seconds;
    const timer = setTimeout(() => {
      const current = this.state.find(agent.id);
      if (!current || current.generation !== agent.generation || !busy(current)) return;
      this.state.event(current, "time_limit", "The configured turn deadline elapsed.");
      void this.abortTurnAndReap(current.id, "The configured turn deadline elapsed.").catch(() => this.codex.stop());
    }, limitSeconds * 1_000);
    this.deadlines.set(agent.id, timer);
  }

  private async stopTurnAndReap(agent: Agent, waitForDone = false) {
    if (!busy(agent)) {
      const reaped = await reapAgentProcesses(agent.id, this.codex.pid());
      return { view: this.view(agent), reaped };
    }
    if (!agent.turn) throw new ToolError("agent_starting", "The turn is still being started. Retry after the running event.");
    this.interrupting.add(agent.id);
    try {
      await this.codex.request("turn/interrupt", { threadId: agent.thread, turnId: agent.turn });
    } catch (error) {
      this.interrupting.delete(agent.id);
      const reaped = await reapAgentProcesses(agent.id, this.codex.pid());
      const current = this.state.require(agent.id);
      if (!busy(current)) return { view: this.view(current), reaped };
      throw error;
    }
    const reaped = await reapAgentProcesses(agent.id, this.codex.pid());
    if (reaped > 0) this.lastReaped.set(agent.id, (this.lastReaped.get(agent.id) ?? 0) + reaped);
    if (waitForDone) {
      const deadline = Date.now() + 2_000;
      while (busy(this.state.require(agent.id))) {
        if (Date.now() >= deadline) {
          const stillBusy = this.state.require(agent.id);
          if (busy(stillBusy)) await this.settleTurn(stillBusy.id, "interrupted", stillBusy.last ?? "The turn was interrupted.");
          break;
        }
        await delay(100);
      }
    }
    return { view: this.view(this.state.require(agent.id)), reaped: Math.max(reaped, this.lastReaped.get(agent.id) ?? 0) };
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
    agent.activity = { kind: "thinking", detail: "Resuming after parent reply...", started_at: new Date().toISOString(), steps: agent.activity?.steps ?? 0 };
    this.state.save(agent);
    this.codex.reply(pending.rpc, { success, contentItems: [{ type: "inputText", text }] });
  }

  private async serverRequest(id: Id, method: string, params: Record<string, unknown>) {
    const agent = this.findThread(params.threadId);
    if (method !== "item/tool/call") {
      if (method === "item/tool/requestUserInput") {
        this.codex.fail(id, "Use ask_parent to ask the parent a question.");
        return;
      }
      if (method === "item/permissions/requestApproval") {
        if (agent) this.state.event(agent, "approval_auto_declined", `${method} · approval_policy_never`);
        this.codex.reply(id, { permissions: {}, scope: "turn" });
        return;
      }
      if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        if (agent) this.state.event(agent, "approval_auto_declined", `${method} · approval_policy_never`);
        this.codex.reply(id, { decision: "decline" });
        return;
      }
      if (agent) this.state.event(agent, "unhandled_request", `Unhandled Codex server request: ${method}`);
      this.codex.fail(id, `Unsupported Codex server request: ${method}`);
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
      this.emitEvent(agent, "report", text);
      reply("Delivered to the parent's mailbox.");
    } else if (tool === "ask_parent") {
      if (this.questions.has(agent.id)) { reply("One question is already waiting for a reply.", false); return; }
      const questionId = randomUUID();
      const timeoutSec = agent.question_timeout_seconds ?? this.settings.question_timeout_seconds;
      const timer = setTimeout(() => {
        const current = this.state.find(agent.id);
        if (!current || this.questions.get(agent.id)?.id !== questionId) return;
        this.answer(current, "The parent did not answer before the clarification deadline. Report the blocker or continue only where assumptions are safe.", false);
        this.emitEvent(current, "question_expired", "The clarification deadline elapsed.", { questionId });
      }, timeoutSec * 1_000);
      this.questions.set(agent.id, { id: questionId, rpc: id, timer });
      agent.status = "needs_input";
      agent.question = { id: questionId, text };
      agent.activity = {
        kind: "waiting_input",
        detail: output(text, 200),
        started_at: new Date().toISOString(),
        steps: agent.activity?.steps ?? 0,
      };
      this.state.save(agent);
      this.emitEvent(agent, "question", text, { questionId });
    } else if (tool === "message_peer") {
      try {
        const peer = this.owned(message(args.agent_id) ?? "");
        if (peer.id === agent.id) throw new ToolError("same_agent", "Select a different agent.");
        const result = await this.send({
          agent_id: peer.id,
          text: `From peer ${agent.id}: ${text}`,
          mode: peer.question ? "steer" : "auto",
          wait: false,
          wait_seconds: 60,
        });
        reply(`Message ${"delivery" in result && result.delivery === "queued" ? "queued" : "delivered"} for ${peer.id}.`);
      } catch (error) { reply(this.describe(error), false); }
    } else if (tool === "delegate_child") {
      try {
        const child = await this.spawnNew({
          task: text, workspace: agent.workspace, role: "explorer", mode: "read_only",
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
      const type = message(item.type);
      const now = new Date().toISOString();
      if (type === "commandExecution") {
        const rawCmd = message(item.command) ?? message(record(item.command).cmd) ?? "running command";
        agent.activity = {
          kind: "command",
          detail: output(rawCmd.trim(), 200),
          started_at: now,
          steps: (agent.activity?.steps ?? 0) + 1,
        };
        this.state.save(agent);
        appendStream(this.settings.state_dir, agent.id, {
          seq: this.currentSeq(agent.id),
          at: now,
          kind: "activity",
          status: agent.status,
          activity: agent.activity,
        });
      } else if (type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
        const paths = changes.map((c) => message(c.path)).filter((p): p is string => Boolean(p)).slice(0, 3);
        const detail = paths.length
          ? `Editing ${paths.join(", ")}${changes.length > 3 ? ` (+${changes.length - 3})` : ""}`
          : "Applying file changes";
        agent.activity = {
          kind: "file_change",
          detail: output(detail, 200),
          started_at: now,
          steps: (agent.activity?.steps ?? 0) + 1,
        };
        this.state.save(agent);
        appendStream(this.settings.state_dir, agent.id, {
          seq: this.currentSeq(agent.id),
          at: now,
          kind: "activity",
          status: agent.status,
          activity: agent.activity,
        });
      }
    } else if (method === "item/completed") {
      const item = record(params.item);
      const type = message(item.type);
      const now = new Date().toISOString();
      if (type === "commandExecution" || type === "fileChange") {
        agent.activity = {
          kind: "thinking",
          detail: "Processing tool output...",
          started_at: now,
          steps: agent.activity?.steps ?? 0,
        };
        this.state.save(agent);
      } else if (type === "agentMessage") {
        const text = message(item.text);
        if (text) {
          if (item.phase === "commentary") {
            agent.activity = {
              kind: "thinking",
              detail: output(text, 200),
              started_at: now,
              steps: agent.activity?.steps ?? 0,
            };
            this.state.save(agent);
            const seq = this.state.event(agent, "commentary", output(text, 2_000));
            this.lastSeq.set(agent.id, seq);
            appendStream(this.settings.state_dir, agent.id, {
              seq,
              at: now,
              kind: "activity",
              status: agent.status,
              text: output(text, 500),
              activity: agent.activity,
            });
          } else {
            agent.last = output(text);
            this.state.save(agent);
          }
        }
      }
    } else if (method === "turn/completed") {
      const status = turn.status === "interrupted" ? "interrupted" : turn.status === "completed" ? "completed" : "failed";
      const description = agent.last ?? message(record(turn.error).message) ?? `Codex turn ${status}.`;
      void this.settleTurn(agent.id, status, output(description));
      if (agent.parent) {
        const parent = this.state.find(agent.parent);
        if (parent?.owner === ownerId && parent.thread && parent.status !== "closed") {
          void this.send({
            agent_id: parent.id,
            text: `Child ${agent.id} ${status}: ${output(description, 3_000)}`,
            mode: "steer",
            wait: false,
            wait_seconds: 60,
          }).catch(() => undefined);
        }
      }
    } else if (method === "serverRequest/resolved") {
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
    this.interrupting.delete(agent.id);
    const question = this.questions.get(agent.id);
    if (question) clearTimeout(question.timer);
    this.questions.delete(agent.id);
    this.clearDeadline(agent.id);
    agent.question = undefined;
    agent.turn = undefined;
    agent.activity = undefined;
    agent.last = text;
    agent.status = status;
    if (!agent.thread) agent.owner = undefined;
    agent.settled = agent.generation;
    this.state.save(agent);
    this.state.event(agent, status, text);
  }

  private recoverOwned() {
    for (const agent of this.state.owned()) {
      agent.owner = undefined;
      if (busy(agent)) {
        void reapAgentProcesses(agent.id);
        this.finish(agent, "interrupted", "The Codex connection closed. Continue the saved agent to start another turn.");
        this.emitEvent(agent, "interrupted", agent.last ?? "The Codex connection closed.", { result: agent.last });
      } else {
        this.state.save(agent);
      }
    }
    this.byThread.clear();
  }

  private clearDeadline(id: string) {
    const timer = this.deadlines.get(id);
    if (timer) clearTimeout(timer);
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
