# Antigravity 的 Codex 子代理 (agy-codex-mcp)

专为 Antigravity（`agy`）与 `/swarm` 打造的极简 Codex CLI MCP 桥接服务：无侧栏 GUI、无人工弹窗拦截、超时自动回收残留子进程、交付后自动清理临时会话，通过 5 个核心工具即可像原生子代理一样调用本地 Codex。

## 核心工具（仅 5 个）

1. **`codex_run`**：派工并等待完成（支持 `mode: "read_only" | "worktree" | "workspace"`）；交付后默认自动释放临时会话与空工作树；若需多轮续聊可传 `keep_session: true`；传入 `background: true` 可立即返回并在后台并行运行。
2. **`codex_wait`**：等待后台子代理，省略 `agent_ids` 与 `after` 时自动监听所有活跃子代理并从内部游标续读事件。
3. **`codex_send`**：向子代理发消息（`mode: "auto"` 自动识别：若有待答问题则直接回复，无需 `reply_to`；运行中则转向 `turn/steer`；保留会话已结束时自动续派）。
4. **`codex_manage`**：统一管理接口（`action: "list" | "changes" | "interrupt" | "close" | "cleanup"`）。其中 `cleanup` 会删除历史持久化 Codex 会话、移除残留工作树并清理本地状态库。
5. **`codex_models`**：查询当前 Codex 账号可用的模型 ID 与推理档位。

## 会话不堆积与进程树回收

- **不污染 ChatGPT Desktop 历史**：默认 `persist_threads: false`，所有子代理线程均以 `ephemeral: true` 启动，且在向主代理交付结果后（`keep_session` 默认 `false`）自动 `thread/unsubscribe` 并释放空工作树（保留有实际改动的 worktree 供主代理验收）。
- **彻底回收超时/中断脚本**：每个子代理线程会注入 `AGY_CODEX_AGENT_ID` 与 `AGY_CODEX_BRIDGE_PID` 环境变量标签；当 `codex_run` 超时、请求被取消、`interrupt`、`close`、`turn/completed` 或桥接退出时，会扫描 `/proc` 环境变量与父子进程树，对关联进程组先发 `SIGTERM` 再升级 `SIGKILL`，防止脚本在子代理退出后继续残留。

## 沙箱与免审批策略

- 桥接对 Codex 线程固定传入 `approvalPolicy: "never"`，并默认继承完整环境变量（`shell_environment_policy.inherit="all"`）与开启联网（`sandbox_network: true`），消除构建工具找不到 PATH、缓存不可写或中途审批卡死的问题。
- `workspace_roots` 默认为空 `[]`，允许任意已存在的绝对路径（便于直接接入 `/swarm` 的 `share` / `branch` 临时工作副本）。
- `sandbox_mode` 控制可写任务（`worktree` / `workspace`）的沙箱级别：
  - `"workspace-write"`：限制写入目标目录、worktree 的 `.git/worktrees/<id>` 以及 `extra_writable_roots`。
  - `"danger-full-access"`：对可写任务完全放开文件系统与工具链限制（适合高度信任的本地环境）；`read_only` 任务仍保持只读沙箱。

## 配套 Skill（原生异步唤醒 + `/swarm` 接入）

仓库内置 [skills/codex-subagent/SKILL.md](skills/codex-subagent/SKILL.md)，可复制到 `~/.gemini/config/skills/codex-subagent/SKILL.md`：

- **非阻塞后台代理**：由主代理用 `define_subagent(EnableMCPTools: true)` + `invoke_subagent(Model: "flash_lite")` 托管 `codex_run`，主对话直接获得系统级完成唤醒，免去手动轮询 `codex_wait`。
- **`/swarm` 接入**：在 `/swarm` 会话中拉起轻量化代理成员（如 `workspace: "share"`），通过 `codex_run(workspace: <成员工作目录>, mode: "workspace")` 让 Codex 作为 Swarm 团队成员在独立副本中编码并向看板汇报。

## 安装与验证

1. 在项目目录运行 `pnpm install --frozen-lockfile && pnpm build`。
2. 复制 `desktop.example.json` 为 `desktop.json` 并修改 `state_dir` 等本机路径。
3. 运行 `node scripts/cc-switch.mjs --open` 导入 Antigravity MCP 配置，或将 `node dist/server.js --config /path/to/desktop.json` 写入 `mcp_config.json`。
4. 若升级前曾在 ChatGPT Desktop 堆积了旧子代理会话，重启 MCP 后执行一次 `codex_manage({ action: "cleanup" })` 即可批量清理。
5. 本地验证：`pnpm test`（使用模拟 Codex App Server）。
