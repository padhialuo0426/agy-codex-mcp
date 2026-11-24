import { execFile } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ToolError, within, workspace, type Settings } from "./settings.js";
import { output } from "./codex.js";
import type { Agent } from "./state.js";

const execute = promisify(execFile);

async function git(settings: Settings, cwd: string, args: string[], input?: string, maxBuffer = 512_000) {
  const process = execute(settings.git, ["-C", cwd, "-c", "core.hooksPath=/dev/null", ...args], {
    timeout: 20_000, maxBuffer, env: { ...globalThis.process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (input === undefined) process.child.stdin?.end();
  else {
    process.child.stdin?.on("error", () => undefined);
    process.child.stdin?.end(input);
  }
  return (await process).stdout;
}

export async function planWorktree(settings: Settings, cwd: string, baseRef?: string) {
  let repository: string;
  let base: string;
  try {
    repository = realpathSync((await git(settings, cwd, ["rev-parse", "--show-toplevel"])).trim());
    workspace(settings, repository, false);
    base = (await git(settings, repository, ["rev-parse", "--verify", "--end-of-options", `${baseRef ?? "HEAD"}^{commit}`])).trim();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("invalid_git_base", "Use a writable Git repository and an existing base commit.");
  }
  return { repository, base };
}

export async function makeWorktree(settings: Settings, agent: Agent, plan: Awaited<ReturnType<typeof planWorktree>>, patch?: string) {
  const { repository, base } = plan;
  if (workspace(settings, repository, false) !== repository || workspace(settings, agent.workspace, false) !== agent.workspace) {
    throw new ToolError("workspace_changed", "The workspace moved after the worktree request was prepared.");
  }
  const parent = join(settings.state_dir, "worktrees");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const path = join(parent, agent.id);
  try {
    await git(settings, repository, ["worktree", "add", "--detach", path, base]);
  } catch {
    throw new ToolError("worktree_failed", "Git could not create the isolated worktree.");
  }
  try {
    if (patch) await git(settings, path, ["apply", "--binary", "-"], patch);
    const cwd = realpathSync(join(path, relative(repository, agent.workspace)));
    if (!within(path, cwd)) throw new Error("Directory escapes the worktree.");
    const gitDirRaw = (await git(settings, path, ["rev-parse", "--git-dir"])).trim();
    const git_dir = realpathSync(resolve(path, gitDirRaw));
    return { worktree: { repository, path, base, git_dir }, cwd };
  } catch {
    await git(settings, repository, ["worktree", "remove", "--force", path]).catch(() => undefined);
    throw new ToolError("worktree_setup_failed", "The requested directory or input patch could not be applied to the chosen base.");
  }
}

export async function readChanges(settings: Settings, agent: Agent, path?: string) {
  if (!agent.worktree) throw new ToolError("no_worktree", "This agent has no writable worktree.");
  const { path: cwd, base } = agent.worktree;
  if (path && (isAbsolute(path) || !within(cwd, join(cwd, path)))) throw new ToolError("invalid_path", "Use a relative path inside the worktree.");
  try {
    const filter = path ? [path] : [];
    const [tracked, untracked, patch] = await Promise.all([
      git(settings, cwd, ["--literal-pathspecs", "diff", "--name-status", "--no-renames", base, "--", ...filter]),
      git(settings, cwd, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "--", ...filter]),
      git(settings, cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--binary", base, "--", ...filter])
        .catch((error: { code?: string }) => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? undefined : Promise.reject(error)),
    ]);
    return {
      base, worktree_path: cwd, tracked: output(tracked, 2_500), untracked: output(untracked, 2_500),
      diff: patch === undefined ? "" : output(patch, 12_000),
      diff_truncated: patch === undefined || patch.length > 12_000,
    };
  } catch {
    throw new ToolError("diff_failed", "Cannot read the worktree changes. Check the worktree path or request a single file.");
  }
}
