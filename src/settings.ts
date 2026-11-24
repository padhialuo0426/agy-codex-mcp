import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as z from "zod/v4";

export class ToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const SettingsSchema = z.strictObject({
  codex: z.string().default("/usr/bin/codex"),
  git: z.string().default("/usr/bin/git"),
  state_dir: z.string(),
  workspace_roots: z.array(z.string()).min(1),
  writable_roots: z.array(z.string()).default([]),
  extra_writable_roots: z.array(z.string()).default([]),
  sandbox_network: z.boolean().default(false),
  approval_dialog: z.string().refine(isAbsolute, "Use an absolute approval dialog path.").optional(),
  approval_mode: z.enum(["off", "panel", "dialog", "panel_or_dialog"]).optional(),
  approval_policy: z.enum(["on-request", "granular", "untrusted"]).default("on-request"),
  approvals_reviewer: z.enum(["user", "auto_review", "guardian_subagent"]).optional(),
  approval_timeout_seconds: z.number().int().min(5).max(600).default(120),
  allow_readonly_command_approval: z.boolean().default(true),
  reuse_worktree_approval: z.boolean().default(false),
  allowed_models: z.array(z.string()).default([]),
  max_parallel: z.number().int().min(1).max(8).default(3),
  max_turn_seconds: z.number().int().min(10).max(3600).default(600),
  question_timeout_seconds: z.number().int().min(10).max(1800).default(180),
  max_depth: z.number().int().min(1).max(3).default(1),
  codex_config: z.array(z.string()).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function within(root: string, path: string) {
  const difference = relative(root, path);
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith("../"));
}

export function canWrite(settings: Settings, path: string) {
  return settings.writable_roots.some((root) => within(root, path));
}

export type ApprovalMode = "off" | "panel" | "dialog" | "panel_or_dialog";

export function effectiveApprovalMode(settings: Settings): ApprovalMode {
  if (settings.approval_mode) return settings.approval_mode;
  return settings.approval_dialog ? "panel_or_dialog" : "off";
}

export function approvalsEnabled(settings: Settings): boolean {
  return effectiveApprovalMode(settings) !== "off";
}

export function loadSettings(): Settings {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Launch with --config /absolute/path/to/desktop.json.");
  const config = SettingsSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
  for (const path of [config.codex, config.git, config.state_dir, ...config.workspace_roots, ...config.writable_roots, ...config.extra_writable_roots]) {
    if (!isAbsolute(path)) throw new Error("Use absolute paths in the desktop server configuration.");
  }
  if (config.approval_mode === "dialog" && !config.approval_dialog) {
    throw new Error("approval_mode 'dialog' requires approval_dialog to be configured.");
  }
  mkdirSync(config.state_dir, { recursive: true, mode: 0o700 });
  config.state_dir = realpathSync(config.state_dir);
  config.workspace_roots = config.workspace_roots.map((path) => realpathSync(path));
  config.writable_roots = config.writable_roots.map((path) => realpathSync(path));
  config.extra_writable_roots = config.extra_writable_roots.map((path) => {
    try { return realpathSync(path); } catch { return resolve(path); }
  });
  for (const root of config.writable_roots) {
    if (!config.workspace_roots.some((allowed) => within(allowed, root))) {
      throw new Error("A writable root must be inside a configured workspace root.");
    }
  }
  return config;
}

export function workspace(settings: Settings, path: string, write: boolean) {
  if (!isAbsolute(path)) throw new ToolError("invalid_workspace", "Provide the absolute path of the active project.");
  let actual: string;
  try {
    actual = realpathSync(resolve(path));
    if (!statSync(actual).isDirectory()) throw new Error();
  } catch {
    throw new ToolError("invalid_workspace", "The workspace path must exist and be a directory.");
  }
  if (!settings.workspace_roots.some((root) => within(root, actual))) {
    throw new ToolError("workspace_out_of_scope", "The workspace is outside this server's configured project roots.");
  }
  if (write && !canWrite(settings, actual)) {
    throw new ToolError("write_not_enabled", "This project has no writable worktree permission in the desktop server configuration.");
  }
  return actual;
}
