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
  workspace_roots: z.array(z.string()).default([]),
  sandbox_mode: z.enum(["workspace-write", "danger-full-access"]).default("workspace-write"),
  sandbox_network: z.boolean().default(true),
  extra_writable_roots: z.array(z.string()).default([]),
  persist_threads: z.boolean().default(false),
  allowed_models: z.array(z.string()).default([]),
  max_parallel: z.number().int().min(1).max(8).default(4),
  max_turn_seconds: z.number().int().min(10).max(14_400).default(600),
  question_timeout_seconds: z.number().int().min(10).max(1800).default(300),
  max_depth: z.number().int().min(1).max(3).default(1),
  codex_config: z.array(z.string()).default([]),
});

export type Settings = z.infer<typeof SettingsSchema>;

export function within(root: string, path: string) {
  const difference = relative(root, path);
  return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith("../"));
}

export function loadSettings(): Settings {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("Launch with --config /absolute/path/to/desktop.json.");
  const config = SettingsSchema.parse(JSON.parse(readFileSync(values.config, "utf8")));
  for (const path of [config.codex, config.git, config.state_dir, ...config.workspace_roots, ...config.extra_writable_roots]) {
    if (!isAbsolute(path)) throw new Error("Use absolute paths in the server configuration.");
  }
  mkdirSync(config.state_dir, { recursive: true, mode: 0o700 });
  config.state_dir = realpathSync(config.state_dir);
  config.workspace_roots = config.workspace_roots.map((path) => realpathSync(path));
  config.extra_writable_roots = config.extra_writable_roots.map((path) => {
    try { return realpathSync(path); } catch { return resolve(path); }
  });
  return config;
}

export function workspace(settings: Settings, path: string) {
  if (!isAbsolute(path)) throw new ToolError("invalid_workspace", "Provide the absolute path of the active project.");
  let actual: string;
  try {
    actual = realpathSync(resolve(path));
    if (!statSync(actual).isDirectory()) throw new Error();
  } catch {
    throw new ToolError("invalid_workspace", "The workspace path must exist and be a directory.");
  }
  if (settings.workspace_roots.length > 0 && !settings.workspace_roots.some((root) => within(root, actual))) {
    throw new ToolError("workspace_out_of_scope", "The workspace is outside this server's configured project roots.");
  }
  return actual;
}
