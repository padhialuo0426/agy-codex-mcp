import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const project = fileURLToPath(new URL("../", import.meta.url));
const work = process.env.AGY_CODEX_TEST_TMPDIR ?? tmpdir();

export async function prepare(codex) {
  const temp = await mkdtemp(join(work, "agy-test-"));
  const repository = join(temp, "repo");
  await mkdir(repository);
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "readme.txt"), "Initial repository.\n");
  execFileSync("git", ["-C", repository, "add", "readme.txt"]);
  execFileSync("git", ["-C", repository, "-c", "commit.gpgsign=false", "-c", "user.name=Bridge test", "-c", "user.email=bridge-test@example.invalid", "commit", "-qm", "Initial"]);
  const config = join(temp, "config.json");
  await writeFile(config, JSON.stringify({
    codex, workspace_roots: [repository], writable_roots: [repository],
    state_dir: join(temp, "state"), max_parallel: 2, max_turn_seconds: 150, question_timeout_seconds: 90,
  }));
  return { repository, config, cleanup: () => rm(temp, { force: true, recursive: true }) };
}

export async function connect(config) {
  const client = new Client({ name: "agy-bridge-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(project, "dist/server.js"), "--config", config], stderr: "pipe",
    env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  await client.connect(transport);
  const call = async (name, args, allowError = false) => {
    const result = await client.callTool({ name: `codex_${name}`, arguments: args });
    if (allowError) {
      assert.equal(result.isError, true, JSON.stringify(result));
      return result.content[0].text;
    }
    assert.notEqual(result.isError, true, `${JSON.stringify(result)}\n${stderr}`);
    return result.structuredContent;
  };
  return { client, call, close: () => client.close() };
}
