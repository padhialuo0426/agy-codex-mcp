import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ToolError } from "./settings.js";

export type AgentStatus = "starting" | "running" | "needs_input" | "idle" | "completed" | "failed" | "interrupted" | "closed";
export type AgentMode = "read_only" | "worktree" | "workspace";
export type Role = "default" | "explorer" | "reviewer" | "worker";
export type Agent = {
  id: string;
  group: string;
  role: Role;
  mode?: AgentMode;
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
  worktree?: { repository: string; path: string; base: string; git_dir?: string };
  network?: boolean;
  ephemeral?: boolean;
  keep_session?: boolean;
  max_turn_seconds?: number;
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

  require(id: string) {
    const agent = this.find(id);
    if (!agent) throw new ToolError("agent_not_found", "Use a valid agent ID.");
    return agent;
  }

  owned() {
    return (this.db.prepare("SELECT data FROM agents WHERE json_extract(data, '$.owner') = ?").all(ownerId) as Row[])
      .map((row) => JSON.parse(row.data) as Agent);
  }

  activeOwned() {
    return this.owned().filter((agent) => busy(agent));
  }

  countActive() {
    return (this.db.prepare("SELECT data FROM agents WHERE json_extract(data, '$.owner') IS NOT NULL").all() as Row[])
      .map((row) => JSON.parse(row.data) as Agent)
      .filter((agent) => busy(agent) && ownerAlive(agent.owner)).length;
  }

  listRecent(limit = 20): Agent[] {
    const all = this.listAll();
    const active: Agent[] = [];
    const settled: Agent[] = [];
    for (const agent of all) {
      if (ownerAlive(agent.owner) && busy(agent)) active.push(agent);
      else settled.push(agent);
    }
    return [...active, ...settled].slice(0, limit);
  }

  listAll(): Agent[] {
    return (this.db.prepare("SELECT data FROM agents ORDER BY rowid DESC").all() as Row[])
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

  deleteAgent(id: string) {
    this.change(() => {
      this.db.prepare("DELETE FROM events WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    });
  }

  event(agent: Agent, kind: string, text: string, questionId?: string) {
    this.db.prepare("INSERT INTO events(agent_group,agent_id,generation,kind,text,question_id,at) VALUES(?,?,?,?,?,?,?)")
      .run(agent.group, agent.id, agent.generation, kind, text, questionId ?? null, new Date().toISOString());
  }

  latestSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number };
    return row.seq;
  }

  recentForAgents(ids: string[], after: number, limit: number) {
    const filter = ids.length ? ` AND agent_id IN (${ids.map(() => "?").join(",")})` : "";
    const rows = this.db.prepare(`SELECT seq,agent_id,generation,kind,text,question_id,at
      FROM events WHERE seq > ?${filter} ORDER BY seq LIMIT ?`)
      .all(after, ...ids, limit) as unknown as AgentEvent[];
    let chars = 0;
    return rows.filter((row) => {
      chars += row.text.length + 300;
      return chars <= 20_000;
    });
  }
}
