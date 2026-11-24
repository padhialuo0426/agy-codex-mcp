import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ToolError } from "./settings.js";

export type AgentStatus = "starting" | "running" | "needs_input" | "idle" | "completed" | "failed" | "interrupted" | "closed";
export type Role = "default" | "explorer" | "reviewer" | "worker";
export type ApprovalChoice = "once" | "session" | "amend" | "decline";
export type ApprovalOption = { choice: ApprovalChoice; label: string };
export type ApprovalNotice = {
  id: string;
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  options: ApprovalOption[];
  expires_at: string;
};
export type RecentGroup = {
  group_id: string;
  pending_approvals: number;
  active: number;
  last_at?: string;
};
export type Agent = {
  id: string;
  group: string;
  role: Role;
  task: string;
  followup_task?: string;
  workspace: string;
  cwd: string;
  status: AgentStatus;
  owner?: string;
  thread?: string;
  turn?: string;
  generation: number;
  settled: number;
  queue: string[];
  last?: string;
  question?: { id: string; text: string };
  approvals?: ApprovalNotice[];
  worktree?: { repository: string; path: string; base: string; git_dir?: string };
  worktree_approved?: boolean;
  network?: boolean;
  parent?: string;
  depth: number;
  model?: string;
  effort?: string;
};

type Row = { data: string };
export type AgentEvent = {
  seq: number; agent_id: string; generation: number; kind: string; text: string; question_id?: string; at: string;
};

export const busy = (agent: Agent) => ["starting", "running", "needs_input"].includes(agent.status);

function processStart(pid: number) {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
    if (fields[0] !== "Z") return fields[19];
  } catch { /* The process exited. */ }
}

export const ownerId = `${process.pid}:${processStart(process.pid)}`;
export function ownerAlive(owner?: string) {
  if (!owner) return false;
  const [pid, start] = owner.split(":");
  return Boolean(start && start === processStart(Number(pid)));
}

export class State {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(join(path, "agents.sqlite"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, agent_group TEXT NOT NULL, data TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agents_group ON agents(agent_group);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY, agent_group TEXT NOT NULL, agent_id TEXT NOT NULL,
        generation INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, question_id TEXT, at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_group_seq ON events(agent_group, seq);
    `);
  }

  find(id: string) {
    const row = this.db.prepare("SELECT data FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? JSON.parse(row.data) as Agent : undefined;
  }

  group(group: string) {
    return (this.db.prepare("SELECT data FROM agents WHERE agent_group = ? ORDER BY rowid").all(group) as Row[])
      .map((row) => JSON.parse(row.data) as Agent);
  }

  owned() {
    return (this.db.prepare("SELECT data FROM agents WHERE json_extract(data, '$.owner') = ?").all(ownerId) as Row[])
      .map((row) => JSON.parse(row.data) as Agent);
  }

  change(action: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      action();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  save(agent: Agent) {
    this.db.prepare(`INSERT INTO agents(id,agent_group,data) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(agent.id, agent.group, JSON.stringify(agent));
  }

  event(agent: Agent, kind: string, text: string, questionId?: string) {
    this.db.prepare("INSERT INTO events(agent_group,agent_id,generation,kind,text,question_id,at) VALUES(?,?,?,?,?,?,?)")
      .run(agent.group, agent.id, agent.generation, kind, text, questionId ?? null, new Date().toISOString());
  }

  recent(group: string, ids: string[], after: number, limit: number) {
    const filter = ids.length ? ` AND agent_id IN (${ids.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT seq,agent_id,generation,kind,text,question_id,at
      FROM events WHERE agent_group = ? AND seq > ?${filter} ORDER BY seq LIMIT ?`)
      .all(group, after, ...ids, limit) as unknown as AgentEvent[];
    let chars = 0;
    return rows.filter((row) => {
      chars += row.text.length + 300;
      return chars <= 20_000;
    });
  }

  countActive(group: string) {
    return this.group(group).filter((agent) => busy(agent) && ownerAlive(agent.owner)).length;
  }

  require(group: string, id: string) {
    const agent = this.find(id);
    if (!agent || agent.group !== group) throw new ToolError("agent_not_found", "Use an agent ID from this group.");
    return agent;
  }

  recentGroups(limit = 10): RecentGroup[] {
    const latest = new Map<string, { seq: number; at: string }>();
    for (const row of this.db.prepare("SELECT agent_group, MAX(seq) AS seq, MAX(at) AS at FROM events GROUP BY agent_group").all() as Array<{ agent_group: string; seq: number; at: string }>) {
      latest.set(row.agent_group, { seq: row.seq, at: row.at });
    }
    const groups = new Map<string, RecentGroup & { last_seq: number }>();
    for (const row of this.db.prepare("SELECT data FROM agents").all() as Row[]) {
      const agent = JSON.parse(row.data) as Agent;
      const alive = ownerAlive(agent.owner);
      const entry = groups.get(agent.group) ?? {
        group_id: agent.group,
        pending_approvals: 0,
        active: 0,
        last_seq: latest.get(agent.group)?.seq ?? 0,
        last_at: latest.get(agent.group)?.at,
      };
      if (alive && agent.approvals?.length) entry.pending_approvals += agent.approvals.length;
      if (alive && busy(agent)) entry.active++;
      groups.set(agent.group, entry);
    }
    return [...groups.values()]
      .sort((a, b) => Number(b.pending_approvals > 0) - Number(a.pending_approvals > 0)
        || Number(b.active > 0) - Number(a.active > 0)
        || b.last_seq - a.last_seq)
      .slice(0, limit)
      .map(({ group_id, pending_approvals, active, last_at }) => ({ group_id, pending_approvals, active, last_at }));
  }
}
