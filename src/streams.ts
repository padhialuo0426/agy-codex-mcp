import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type AgentActivity = {
  kind: "command" | "file_change" | "thinking" | "waiting_input";
  detail: string;
  started_at: string;
  steps: number;
};

export type StreamChanges = {
  tracked: string;
  untracked: string;
  diff: string;
  diff_truncated: boolean;
  diff_stat?: string;
  patch_file?: string;
  base?: string;
  worktree_path?: string;
};

export type StreamEvent = {
  seq: number;
  at: string;
  kind: "started" | "activity" | "report" | "question" | "answered" | "question_expired" | "steered" | "completed" | "failed" | "interrupted" | "closed";
  status: string;
  session_closed?: boolean;
  owner_pid?: number;
  text?: string;
  question_id?: string;
  activity?: AgentActivity;
  result?: string;
  worktree_path?: string;
  changes?: StreamChanges;
};

export function streamsDir(stateDir: string): string {
  return join(stateDir, "streams");
}

export function streamPath(stateDir: string, agentId: string): string {
  return join(streamsDir(stateDir), `${agentId}.ndjson`);
}

export function appendStream(stateDir: string, agentId: string, event: StreamEvent): void {
  mkdirSync(streamsDir(stateDir), { recursive: true, mode: 0o700 });
  appendFileSync(streamPath(stateDir, agentId), JSON.stringify(event) + "\n", { mode: 0o600 });
}

export function removeStream(stateDir: string, agentId: string): void {
  try {
    rmSync(streamPath(stateDir, agentId), { force: true });
  } catch { /* Ignore missing stream file. */ }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function buildWatchCommand(stateDir: string, agentId: string, afterSeq: number): string {
  const watchScript = fileURLToPath(new URL("./watch.js", import.meta.url));
  return [
    shellQuote(process.execPath),
    shellQuote(watchScript),
    "--state",
    shellQuote(stateDir),
    "--agent",
    shellQuote(agentId),
    "--after",
    String(Math.max(0, afterSeq)),
  ].join(" ");
}
