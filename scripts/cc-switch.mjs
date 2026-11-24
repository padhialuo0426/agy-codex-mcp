import { accessSync, constants, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../dist/server.js", import.meta.url));
const config = process.argv.slice(2).find((arg) => arg !== "--open");
const settings = config ? realpathSync(config) : fileURLToPath(new URL("../desktop.json", import.meta.url));
accessSync(entry, constants.R_OK);
accessSync(settings, constants.R_OK);
const server = {
  type: "stdio",
  command: process.env.AGY_CODEX_NODE ?? process.execPath,
  args: [entry, "--config", settings],
};
const value = { mcpServers: { "agy-codex-mcp": server } };
const url = "ccswitch://v1/import?" + new URLSearchParams({
  resource: "mcp", apps: "agy", config: Buffer.from(JSON.stringify(value)).toString("base64"),
});
if (process.argv.includes("--open")) {
  const launched = spawnSync("xdg-open", [url], { stdio: "inherit" });
  if (launched.status !== 0) process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
