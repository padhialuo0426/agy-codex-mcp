import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { parseArgs } from "node:util";
import { buildWatchCommand, streamPath, streamsDir, type AgentActivity, type StreamEvent } from "./streams.js";

function ownerAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endComm = stat.lastIndexOf(")");
    if (endComm === -1) return false;
    const state = stat.slice(endComm + 2).split(" ")[0];
    return state !== "Z";
  } catch {
    return false;
  }
}

function readEvents(file: string): StreamEvent[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as StreamEvent);
    } catch {
      /* Ignore incomplete trailing line while writer flushes. */
    }
  }
  return events;
}

const TERMINAL = new Set(["completed", "failed", "interrupted", "closed"]);

function evaluate(
  stateDir: string,
  agentId: string,
  afterSeq: number,
  includeReport: boolean,
): Record<string, unknown> | undefined {
  const file = streamPath(stateDir, agentId);
  const events = readEvents(file);
  if (events.length === 0) return undefined;

  let latestActivity: AgentActivity | undefined;
  let latestStatus = "starting";
  let maxSeq = afterSeq;
  for (const ev of events) {
    if (ev.activity) latestActivity = ev.activity;
    if (ev.status) latestStatus = ev.status;
    if (ev.seq > maxSeq) maxSeq = ev.seq;
  }

  const fresh = events.filter((ev) => ev.seq > afterSeq);
  const terminals = fresh.filter((ev) => TERMINAL.has(ev.kind));
  if (terminals.length > 0) {
    const terminal = terminals[terminals.length - 1];
    return {
      wakeup_reason: terminal.kind,
      agent_id: agentId,
      cursor: terminal.seq,
      status: terminal.status,
      result: terminal.result,
      worktree_path: terminal.worktree_path,
      changes: terminal.changes,
      activity: latestActivity,
    };
  }

  const questions = fresh.filter((ev) => ev.kind === "question");
  if (questions.length > 0) {
    const latestQuestion = questions[questions.length - 1];
    const answered = fresh.some(
      (ev) => ev.kind === "answered" && (ev.seq > latestQuestion.seq || (latestQuestion.question_id && ev.question_id === latestQuestion.question_id)),
    );
    if (!answered) {
      return {
        wakeup_reason: "needs_input",
        agent_id: agentId,
        cursor: latestQuestion.seq,
        status: "needs_input",
        question: { id: latestQuestion.question_id, text: latestQuestion.text },
        activity: latestActivity,
        next_watch_command: buildWatchCommand(stateDir, agentId, latestQuestion.seq),
      };
    }
  }

  if (includeReport) {
    const reports = fresh.filter((ev) => ev.kind === "report");
    if (reports.length > 0) {
      const lastReport = reports[reports.length - 1];
      return {
        wakeup_reason: "report",
        agent_id: agentId,
        cursor: lastReport.seq,
        status: latestStatus,
        report: reports.map((r) => r.text).filter(Boolean).join("\n\n"),
        activity: latestActivity,
        next_watch_command: buildWatchCommand(stateDir, agentId, lastReport.seq),
      };
    }
  }

  return undefined;
}

function snapshotMetadata(stateDir: string, agentId: string, afterSeq: number) {
  const events = readEvents(streamPath(stateDir, agentId));
  let ownerPid: number | undefined;
  let latestActivity: AgentActivity | undefined;
  let latestStatus = "running";
  let maxSeq = afterSeq;
  for (const ev of events) {
    if (typeof ev.owner_pid === "number") ownerPid = ev.owner_pid;
    if (ev.activity) latestActivity = ev.activity;
    if (ev.status) latestStatus = ev.status;
    if (ev.seq > maxSeq) maxSeq = ev.seq;
  }
  return { ownerPid, latestActivity, latestStatus, maxSeq };
}

async function main() {
  const { values } = parseArgs({
    options: {
      state: { type: "string" },
      agent: { type: "string" },
      after: { type: "string", default: "0" },
      timeout: { type: "string", default: "0" },
      "no-report": { type: "boolean", default: false },
    },
  });
  const stateDir = values.state;
  const agentId = values.agent;
  if (!stateDir || !agentId) {
    process.stderr.write("Usage: watch.js --state <state_dir> --agent <agent_id> [--after <seq>] [--timeout <seconds>] [--no-report]\n");
    process.exit(2);
  }
  const afterSeq = Math.max(0, Number(values.after) || 0);
  const timeoutSec = Math.max(0, Number(values.timeout) || 0);
  const includeReport = !values["no-report"];

  const immediate = evaluate(stateDir, agentId, afterSeq, includeReport);
  if (immediate) {
    process.stdout.write(JSON.stringify(immediate) + "\n");
    return;
  }

  const dir = streamsDir(stateDir);
  const targetName = `${agentId}.ndjson`;
  let watcher: FSWatcher | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let ownerTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let finished = false;

  const done = (payload: Record<string, unknown>) => {
    if (finished) return;
    finished = true;
    watcher?.close();
    if (pollTimer) clearInterval(pollTimer);
    if (ownerTimer) clearInterval(ownerTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    process.stdout.write(JSON.stringify(payload) + "\n");
    process.exit(0);
  };

  const check = () => {
    const match = evaluate(stateDir, agentId, afterSeq, includeReport);
    if (match) done(match);
  };

  try {
    if (existsSync(dir)) {
      watcher = watch(dir, (_eventType, filename) => {
        if (!filename || filename === targetName) check();
      });
    }
  } catch { /* Fallback to interval polling if fs.watch is unavailable. */ }

  pollTimer = setInterval(check, 400);
  ownerTimer = setInterval(() => {
    check();
    if (finished) return;
    const meta = snapshotMetadata(stateDir, agentId, afterSeq);
    if (meta.ownerPid && !ownerAlive(meta.ownerPid)) {
      done({
        wakeup_reason: "owner_exited",
        agent_id: agentId,
        cursor: meta.maxSeq,
        status: "interrupted",
        activity: meta.latestActivity,
      });
    }
  }, 2_000);

  if (timeoutSec > 0) {
    timeoutTimer = setTimeout(() => {
      const meta = snapshotMetadata(stateDir, agentId, afterSeq);
      done({
        wakeup_reason: "timeout",
        agent_id: agentId,
        cursor: meta.maxSeq,
        status: meta.latestStatus,
        activity: meta.latestActivity,
        next_watch_command: buildWatchCommand(stateDir, agentId, meta.maxSeq),
      });
    }, timeoutSec * 1_000);
  }
}

void main();
