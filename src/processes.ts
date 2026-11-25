import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

type ProcEntry = {
  pid: number;
  state: string;
  ppid: number;
  pgid: number;
  env: string;
};

function readProcTable(): Map<number, ProcEntry> {
  const table = new Map<number, ProcEntry>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return table;
  }
  for (const name of entries) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const endComm = stat.lastIndexOf(")");
      if (endComm === -1) continue;
      const fields = stat.slice(endComm + 2).split(" ");
      const state = fields[0] ?? "";
      const ppid = Number(fields[1]);
      const pgid = Number(fields[2]);
      if (!Number.isFinite(ppid) || !Number.isFinite(pgid)) continue;
      let env = "";
      try {
        env = readFileSync(`/proc/${pid}/environ`, "utf8");
      } catch {
        /* Process exited or unreadable environ; ppid graph still catches descendants. */
      }
      table.set(pid, { pid, state, ppid, pgid, env });
    } catch {
      /* Process exited while scanning. */
    }
  }
  return table;
}

function hasEnvVar(environ: string, key: string, value: string): boolean {
  if (!environ) return false;
  const needle = `${key}=${value}`;
  return environ.split("\0").includes(needle);
}

function ancestorPids(table: Map<number, ProcEntry>, startPid: number): Set<number> {
  const ancestors = new Set<number>();
  let current: number | undefined = startPid;
  while (current && current > 1 && !ancestors.has(current)) {
    ancestors.add(current);
    current = table.get(current)?.ppid;
  }
  return ancestors;
}

function expandDescendants(table: Map<number, ProcEntry>, seeds: Iterable<number>, protectedPids: Set<number>): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of table.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const matched = new Set<number>();
  const queue: number[] = [];
  for (const seed of seeds) {
    if (seed > 1 && !protectedPids.has(seed) && !matched.has(seed)) {
      matched.add(seed);
      queue.push(seed);
    }
  }
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of children.get(pid) ?? []) {
      if (child > 1 && !protectedPids.has(child) && !matched.has(child)) {
        matched.add(child);
        queue.push(child);
      }
    }
  }
  return matched;
}

function signalMatches(
  table: Map<number, ProcEntry>,
  targets: Set<number>,
  protectedPgids: Set<number>,
  signal: NodeJS.Signals,
): Set<number> {
  const signaled = new Set<number>();
  const pgids = new Set<number>();
  for (const pid of targets) {
    const entry = table.get(pid);
    if (!entry || entry.state === "Z") continue;
    signaled.add(pid);
    if (entry.pgid > 1 && !protectedPgids.has(entry.pgid)) {
      pgids.add(entry.pgid);
    }
  }
  for (const pgid of pgids) {
    try { process.kill(-pgid, signal); } catch { /* Already exited. */ }
  }
  for (const pid of signaled) {
    try { process.kill(pid, signal); } catch { /* Already exited. */ }
  }
  return signaled;
}

async function reapByMatcher(
  matcher: (entry: ProcEntry, table: Map<number, ProcEntry>, protectedPids: Set<number>) => number[],
  codexPid?: number,
  includeCodexPid = false,
  graceMs = 600,
): Promise<number> {
  const reaped = new Set<number>();
  const initialTable = readProcTable();
  const protectedPids = ancestorPids(initialTable, process.pid);
  if (!includeCodexPid && codexPid) protectedPids.add(codexPid);

  const protectedPgids = new Set<number>();
  const selfPgid = initialTable.get(process.pid)?.pgid;
  if (selfPgid && selfPgid > 1) protectedPgids.add(selfPgid);
  if (!includeCodexPid && codexPid) {
    const codexPgid = initialTable.get(codexPid)?.pgid;
    if (codexPgid && codexPgid > 1) protectedPgids.add(codexPgid);
  }

  const firstSeeds = [];
  for (const entry of initialTable.values()) {
    firstSeeds.push(...matcher(entry, initialTable, protectedPids));
  }
  const firstTargets = expandDescendants(initialTable, firstSeeds, protectedPids);
  if (firstTargets.size === 0) return 0;

  for (const pid of signalMatches(initialTable, firstTargets, protectedPgids, "SIGTERM")) {
    reaped.add(pid);
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await delay(100);
    const check = readProcTable();
    const stillAlive = [...firstTargets].some((pid) => {
      const entry = check.get(pid);
      return entry !== undefined && entry.state !== "Z";
    });
    if (!stillAlive) return reaped.size;
  }

  const finalTable = readProcTable();
  const finalProtected = ancestorPids(finalTable, process.pid);
  if (!includeCodexPid && codexPid) finalProtected.add(codexPid);
  const finalSeeds = [...firstTargets].filter((pid) => {
    const entry = finalTable.get(pid);
    return entry !== undefined && entry.state !== "Z";
  });
  for (const entry of finalTable.values()) {
    finalSeeds.push(...matcher(entry, finalTable, finalProtected));
  }
  const finalTargets = expandDescendants(finalTable, finalSeeds, finalProtected);
  for (const pid of signalMatches(finalTable, finalTargets, protectedPgids, "SIGKILL")) {
    reaped.add(pid);
  }
  return reaped.size;
}

export async function reapAgentProcesses(agentId: string, codexPid?: number, graceMs = 600): Promise<number> {
  return reapByMatcher(
    (entry) => (hasEnvVar(entry.env, "AGY_CODEX_AGENT_ID", agentId) ? [entry.pid] : []),
    codexPid,
    false,
    graceMs,
  );
}

export async function reapBridgeProcesses(codexPid?: number, graceMs = 600): Promise<number> {
  const bridgePid = String(process.pid);
  return reapByMatcher(
    (entry) => {
      const out: number[] = [];
      if (hasEnvVar(entry.env, "AGY_CODEX_BRIDGE_PID", bridgePid)) out.push(entry.pid);
      if (codexPid && entry.pid === codexPid) out.push(entry.pid);
      return out;
    },
    codexPid,
    true,
    graceMs,
  );
}
