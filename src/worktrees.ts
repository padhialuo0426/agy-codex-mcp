import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { ToolError, within, workspace, type Settings } from "./settings.js";
import { output } from "./codex.js";
import type { Agent } from "./state.js";

const execute = promisify(execFile);
const MAX_PATCH_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIFF_READ_BYTES = 16 * 1024 * 1024;

export function patchesDir(stateDir: string): string {
  return join(stateDir, "patches");
}

export function patchPath(stateDir: string, agentId: string): string {
  return join(patchesDir(stateDir), `${agentId}.patch`);
}

export function removePatch(stateDir: string, agentId: string): void {
  try {
    rmSync(patchPath(stateDir, agentId), { force: true });
  } catch { /* Ignore missing patch file. */ }
}

export function resolveInputPatch(inputPatch?: string, inputPatchFile?: string): string | undefined {
  if (inputPatch !== undefined && inputPatchFile !== undefined) {
    throw new ToolError("conflicting_patch_inputs", "Provide either input_patch or input_patch_file, not both.");
  }
  if (inputPatchFile !== undefined) {
    if (!isAbsolute(inputPatchFile)) {
      throw new ToolError("invalid_input_patch_file", "input_patch_file must be an absolute file path.");
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(inputPatchFile);
    } catch {
      throw new ToolError("invalid_input_patch_file", `Cannot access input_patch_file: ${inputPatchFile}`);
    }
    if (!stat.isFile()) {
      throw new ToolError("invalid_input_patch_file", `input_patch_file is not a regular file: ${inputPatchFile}`);
    }
    if (stat.size > MAX_PATCH_FILE_BYTES) {
      throw new ToolError("invalid_input_patch_file", `input_patch_file exceeds the 10MB limit (${stat.size} bytes).`);
    }
    const content = readFileSync(inputPatchFile, "utf8");
    if (content.trim().length === 0) {
      throw new ToolError("invalid_input_patch_file", "The input_patch_file is empty.");
    }
    return content;
  }
  if (inputPatch !== undefined) {
    const trimmed = inputPatch.trim();
    if (!trimmed.includes("\n") && (isAbsolute(trimmed) || existsSync(trimmed) || /\.(patch|diff)$/i.test(trimmed))) {
      throw new ToolError(
        "invalid_input_patch",
        "input_patch expects a raw Git diff string, not a file path. Pass a patch file path via input_patch_file instead.",
      );
    }
    return inputPatch;
  }
  return undefined;
}

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
    workspace(settings, repository);
    base = (await git(settings, repository, ["rev-parse", "--verify", "--end-of-options", `${baseRef ?? "HEAD"}^{commit}`])).trim();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("invalid_git_base", "Use a Git repository and an existing base commit.");
  }
  return { repository, base };
}

export async function makeWorktree(settings: Settings, agent: Agent, plan: Awaited<ReturnType<typeof planWorktree>>, patch?: string) {
  const { repository, base } = plan;
  if (workspace(settings, repository) !== repository || workspace(settings, agent.workspace) !== agent.workspace) {
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
    if (patch) await git(settings, path, ["apply", "--binary", "-"], patch, 2_000_000);
    const cwd = realpathSync(join(path, relative(repository, agent.workspace)));
    if (!within(path, cwd)) throw new Error("Directory escapes the worktree.");
    const gitDirRaw = (await git(settings, path, ["rev-parse", "--git-dir"])).trim();
    const git_dir = realpathSync(resolve(path, gitDirRaw));
    return { worktree: { repository, path, base, git_dir }, cwd };
  } catch (error) {
    await git(settings, repository, ["worktree", "remove", "--force", path]).catch(() => undefined);
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    const detail = stderr ? ` (${output(stderr, 400)})` : "";
    throw new ToolError("worktree_setup_failed", `The requested directory or input patch could not be applied to the chosen base.${detail}`);
  }
}

export async function readChanges(
  settings: Settings,
  agent: Agent,
  options?: { path?: string; exportPatch?: boolean; outputPatchPath?: string },
) {
  if (!agent.worktree) throw new ToolError("no_worktree", "This agent has no writable worktree.");
  const { path: cwd, base } = agent.worktree;
  const path = options?.path;
  if (path && (isAbsolute(path) || !within(cwd, join(cwd, path)))) throw new ToolError("invalid_path", "Use a relative path inside the worktree.");
  if (options?.outputPatchPath && !isAbsolute(options.outputPatchPath)) {
    throw new ToolError("invalid_path", "output_patch_path must be an absolute file path.");
  }
  try {
    const filter = path ? [path] : [];
    const [tracked, untracked, diffStat, patch] = await Promise.all([
      git(settings, cwd, ["--literal-pathspecs", "diff", "--name-status", "--no-renames", base, "--", ...filter]),
      git(settings, cwd, ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "--", ...filter]),
      git(settings, cwd, ["--literal-pathspecs", "diff", "--stat", "--no-ext-diff", base, "--", ...filter]),
      git(settings, cwd, ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--binary", base, "--", ...filter], undefined, MAX_DIFF_READ_BYTES)
        .catch((error: { code?: string }) => error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? undefined : Promise.reject(error)),
    ]);
    let patch_file: string | undefined;
    if (options?.outputPatchPath) {
      const target = options.outputPatchPath;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, patch ?? "", { mode: 0o600 });
      patch_file = target;
    } else if (patch !== undefined && patch.length > 0 && (!path || options?.exportPatch)) {
      mkdirSync(patchesDir(settings.state_dir), { recursive: true, mode: 0o700 });
      const target = patchPath(settings.state_dir, agent.id);
      writeFileSync(target, patch, { mode: 0o600 });
      patch_file = target;
    }
    return {
      base,
      worktree_path: cwd,
      tracked: output(tracked, 2_500),
      untracked: output(untracked, 2_500),
      diff_stat: output(diffStat, 2_500),
      diff: patch === undefined ? "" : output(patch, 12_000),
      diff_truncated: patch === undefined || patch.length > 12_000,
      ...(patch_file ? { patch_file } : {}),
    };
  } catch {
    throw new ToolError("diff_failed", "Cannot read the worktree changes. Check the worktree path or request a single file.");
  }
}

export async function removeWorktree(settings: Settings, worktree: { repository: string; path: string }) {
  try {
    await git(settings, worktree.repository, ["worktree", "remove", "--force", worktree.path]);
  } catch {
    /* Fallback to direct directory removal if git metadata or repo moved. */
  }
  try {
    rmSync(worktree.path, { recursive: true, force: true });
  } catch { /* Ignore cleanup failure. */ }
}
