#!/usr/bin/env node
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const cliConfigOverrides = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "-c" && i + 1 < process.argv.length) {
    cliConfigOverrides.push(process.argv[++i]);
  }
}

const turns = new Map();
const models = new Map();
const threadOptions = new Map();
const newEffort = "fixture-next-effort";
const questions = new Map();
const approvals = new Map();
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
function finish(threadId, status, text) {
  const turn = turns.get(threadId);
  if (text) emit({ method: "item/completed", params: {
    threadId, turnId: turn.id, item: { type: "agentMessage", phase: "final_answer", text },
  } });
  emit({ method: "turn/completed", params: { threadId, turn: { id: turn.id, status } } });
  turns.delete(threadId);
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (!method && approvals.has(id)) {
    const { threadId, kind, variant } = approvals.get(id);
    approvals.delete(id);
    if (!turns.has(threadId)) continue;
    let summary;
    if (kind === "permissions") {
      if (variant === "read_entries") {
        const hasNullNetwork = Object.prototype.hasOwnProperty.call(result?.permissions ?? {}, "network") && result.permissions.network === null;
        const access = result?.permissions?.fileSystem?.entries?.[0]?.access ?? "none";
        summary = `${result?.scope}:${hasNullNetwork ? "nullNet" : "clean"}:${access}`;
      } else {
        summary = result?.scope === "turn" && result?.permissions?.network?.enabled === true ? "accept" : "decline";
      }
    } else if (typeof result?.decision === "string") {
      summary = result.decision;
    } else if (result?.decision && typeof result.decision === "object") {
      summary = JSON.stringify(result.decision);
    } else {
      summary = "unknown";
    }
    finish(threadId, "completed", `${kind}: ${summary}`);
    continue;
  }
  if (!method && questions.has(id)) {
    const threadId = questions.get(id);
    questions.delete(id);
    if (turns.has(threadId)) finish(threadId, "completed", `answer: ${result?.contentItems?.[0]?.text}`);
    continue;
  }
  if (id == null) continue;
  const respond = (value) => emit({ id, result: value });
  if (method === "initialize") respond({});
  else if (method === "model/list") respond({ data: [{
    id: "fixture-sol", model: "fixture-sol", displayName: "Fixture Sol", isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["medium", "high", newEffort].map((reasoningEffort) => ({ reasoningEffort })),
  }], nextCursor: null });
  else if (method === "config/read") respond({ config: { mcp_servers: { background: {} }, plugins: {} } });
  else if (method === "thread/start" || method === "thread/fork" || method === "thread/resume") {
    if (params.config?.mcp_servers.background?.enabled !== false) {
      emit({ id, error: { message: "Unexpected enabled external MCP" } });
      continue;
    }
    const threadId = method === "thread/resume" ? params.threadId : randomUUID();
    models.set(threadId, params.model);
    threadOptions.set(threadId, { approvalPolicy: params.approvalPolicy, sandbox: params.sandbox });
    respond({ thread: { id: threadId } });
  } else if (method === "thread/unsubscribe") respond({ status: "unsubscribed" });
  else if (method === "turn/start") {
    const { threadId } = params;
    const content = params.input[0].text;
    if (content.includes("CHECK_MODEL") && (models.get(threadId) !== "fixture-sol" || params.effort !== newEffort)) {
      emit({ id, error: { message: "The requested model and effort were not applied." } });
      continue;
    }
    const turn = { id: randomUUID(), status: "inProgress" };
    turns.set(threadId, turn);
    emit({ method: "turn/started", params: { threadId, turn } });
    respond({ turn });

    if (content.includes("CHECK_SANDBOX")) {
      finish(threadId, "completed", `sandbox:${JSON.stringify(params.sandboxPolicy)}|thread:${JSON.stringify(threadOptions.get(threadId))}`);
      continue;
    }
    if (content.includes("CHECK_CONFIG")) {
      finish(threadId, "completed", `config:${JSON.stringify(cliConfigOverrides)}`);
      continue;
    }

    const reviewMatch = /FIXTURE_REVIEW_(command_amend|command_session|command|file|permissions_read_entries|permissions)/u.exec(content);
    if (reviewMatch) {
      const token = reviewMatch[1];
      const kind = token.startsWith("command") ? "command" : token.startsWith("permissions") ? "permissions" : "file";
      const variant = token.includes("_") ? token.slice(token.indexOf("_") + 1) : undefined;
      const rpc = randomUUID();
      const itemId = randomUUID();
      const turnId = turn.id;
      const reason = content.includes("HOLD_DIALOG")
        ? "HOLD_DIALOG"
        : content.includes("CRASH_DIALOG")
          ? "CRASH_DIALOG"
          : content.includes("QUEUE_HOLD_DIALOG")
            ? "QUEUE_HOLD_DIALOG"
            : content.includes("DENY_COMMAND")
              ? "DENY_COMMAND"
              : "fixture review";
      const cwd = "/fixture/cwd";
      approvals.set(rpc, { threadId, kind, variant });
      if (kind === "file") {
        emit({ method: "item/started", params: {
          threadId, turnId, item: { type: "fileChange", id: itemId, changes: [{ path: "/fixture/cwd/a.txt", diff: "+fixture" }] },
        } });
      }
      const requests = {
        command: {
          method: "item/commandExecution/requestApproval",
          params: {
            cwd,
            command: "printf fixture",
            availableDecisions: variant === "session" || variant === "amend"
              ? ["accept", "acceptForSession", "decline"]
              : ["accept", "decline"],
            ...(variant === "amend" ? { proposedExecpolicyAmendment: ["printf", "fixture"] } : {}),
          },
        },
        file: { method: "item/fileChange/requestApproval", params: { grantRoot: cwd } },
        permissions: variant === "read_entries"
          ? {
            method: "item/permissions/requestApproval",
            params: {
              cwd,
              permissions: {
                network: null,
                fileSystem: {
                  read: null,
                  write: null,
                  entries: [{ path: { type: "path", path: cwd }, access: "read" }],
                },
              },
            },
          }
          : { method: "item/permissions/requestApproval", params: { cwd, permissions: { network: { enabled: true } } } },
      };
      const request = requests[kind];
      emit({ id: rpc, method: request.method, params: { ...request.params, itemId, threadId, turnId, reason } });
    } else if (content.includes("FIXTURE_QUESTION")) {
      const question = randomUUID();
      questions.set(question, threadId);
      emit({ id: question, method: "item/tool/call", params: {
        threadId, turnId: turn.id, tool: "ask_parent", arguments: { question: "Which protocol version?" },
      } });
    } else if (!content.includes("FIXTURE_HOLD")) {
      finish(threadId, "completed", content.includes("QUEUED_NOTE") ? "continued with queued note" : "finished");
    }
  } else if (method === "turn/steer") {
    respond({ turnId: params.expectedTurnId });
    emit({ method: "item/completed", params: {
      threadId: params.threadId, turnId: params.expectedTurnId,
      item: { type: "agentMessage", phase: "commentary", text: params.input[0].text },
    } });
  } else if (method === "turn/interrupt") {
    respond({});
    finish(params.threadId, "interrupted");
  } else emit({ id, error: { message: `Unhandled fixture method: ${method}` } });
}
