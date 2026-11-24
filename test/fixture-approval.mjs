#!/usr/bin/env node
import { setTimeout } from "node:timers/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
if (!process.argv.some((arg) => arg.startsWith("--checkbox="))) process.exit(2);
const details = JSON.parse(input.slice(input.indexOf("{")));
if (details.任务 === "CRASH_DIALOG" || details.原因 === "CRASH_DIALOG") {
  process.stderr.write("Zen error: cannot open display\n");
  process.exit(2);
}
const delayMs = (details.任务 === "HOLD_DIALOG" || details.原因 === "HOLD_DIALOG")
  ? 7_000
  : (details.任务 === "QUEUE_HOLD_DIALOG" || details.原因 === "QUEUE_HOLD_DIALOG")
    ? 3_200
    : 450;
await setTimeout(delayMs);
if (details.审批类别 === "worktree" || details.审批类别 === "spawn_permissions") {
  if (details.审批类别 === "worktree" && (!details.仓库.endsWith("/repo") || !/^[0-9a-f]{40}$/u.test(details.基线提交))) process.exit(2);
} else if (details.审批类别 === "command") {
  if (details.命令 !== "printf fixture" || details.工作目录 !== "/fixture/cwd") process.exit(2);
} else if (details.审批类别 === "file_change") {
  if (details.文件改动?.[0]?.diff !== "+fixture") process.exit(2);
} else if (details.审批类别 === "permissions") {
  const hasNetwork = details.本轮请求权限?.network?.enabled === true;
  const hasReadEntry = details.本轮请求权限?.fileSystem?.entries?.[0]?.access === "read";
  if (!hasNetwork && !hasReadEntry) process.exit(2);
} else process.exit(2);

process.exit(details.任务 === "DENY_DIALOG" || details.原因 === "DENY_COMMAND" ? 1 : 0);
