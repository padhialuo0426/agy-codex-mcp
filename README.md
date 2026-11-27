# Antigravity 的 Codex 子代理 (agy-codex-mcp)

专为 Antigravity（`agy`）与 `/swarm` 打造的极简事件驱动 Codex CLI MCP 桥接服务：仅 **4 个 MCP 工具**、无侧栏 GUI、无轮询空转（通过独立只读事件监听脚本 `dist/watch.js` 实现 0 Token 系统级唤醒）、支持运行中实时活动观测与双向沟通。

## 核心工具（仅 4 个）

1. **`codex_run`**：派工并同步等待最多 `wait_seconds`（默认 90 秒；`0` 表示立即后台返回；支持 `mode: "read_only" | "worktree" | "workspace"`）。支持 `input_patch_file` 直接读取本地 `.patch` 文件，以及 `question_timeout_seconds` 按任务调整提问超时（默认 900 秒）。若长脚本仍在正常执行，返回 `still_running: true`、实时 `activity`、`watch_command` 与 `recommended_notification_timeout_seconds`（不会误杀脚本）；交付后默认自动关闭临时会话与空工作树（多轮续聊可传 `keep_session: true`）。
2. **`codex_send`**：实时双向沟通——支持显式 `mode: "answer"` 回答 `ask_parent` 阻塞提问、`mode: "steer"` 向运行中的 Codex 插入补充指令、`mode: "followup"` 续派，或用默认 `mode: "auto"` 自动分派。
3. **`codex_manage`**：统一管理接口（`action: "status" | "list" | "changes" | "interrupt" | "close" | "cleanup"`）。`status` 查看当前活动与耗时（重复轮询会给出纠偏警告）；`changes` 自动导出完整未截断补丁到 `patch_file`（支持 `output_patch_path` 指定导出路径）并返回 `diff_stat`；`cleanup` 批量删除历史持久化会话、移除残留工作树与事件流/补丁文件。
4. **`codex_models`**：查询当前 Codex 账号可用的模型 ID 与推理档位。

## 零轮询后台唤醒与双向实时沟通

- **彻底告别 `codex_wait` 轮询空转**：桥接服务为每个子代理维护只读 NDJSON 事件流（`<state_dir>/streams/<agent_id>.ndjson`）。当 `codex_run` 返回 `still_running: true` 或 `background: true` 时，Antigravity 代理只需在原生 `run_command` 后台任务中运行返回的 `watch_command`（`node dist/watch.js ...`）即可零 Token 休眠。
- **Codex → 主代理实时回传**：一旦子代理完成、调用 `ask_parent` 提问或调用 `report_to_parent` 汇报关键发现，`watch.js` 立刻退出并唤醒代理，同时给出 `next_watch_command` 以便答复后继续监听。
- **主代理 → Codex 实时插话**：当代理（或 `/swarm` Proxy Worker）休眠等待 `watch.js` 时，主代理发来的 `send_message` 或 `@mention` 会立刻唤醒代理，调用 `codex_send(mode: "steer")` 把新要求实时注入正在执行的 Codex 轮次中，无需重启 `watch.js`。

## 会话不堆积与进程树回收

- **不污染 ChatGPT Desktop 历史**：默认 `persist_threads: false`，所有子代理线程均以 `ephemeral: true` 启动，交付后（`keep_session` 默认 `false`）自动 `thread/unsubscribe` 并释放空工作树（保留有实际改动的 worktree 供主代理验收）。
- **区分等待窗口与硬超时，绝不误杀长脚本**：`wait_seconds` 只是同步等待窗口；仅当到达硬上限 `max_turn_seconds`（最高 14400 秒）、显式 `interrupt`/`close`、`turn/completed`、Codex 异常断开或桥接退出时，才通过 `/proc` 环境标签（`AGY_CODEX_AGENT_ID` / `AGY_CODEX_BRIDGE_PID`）与父子进程树执行 `SIGTERM` → `SIGKILL` 进程回收。

## 沙箱与免审批策略

- 固定传入 `approvalPolicy: "never"`，默认完整继承环境变量（`shell_environment_policy.inherit="all"`）与开启联网（`sandbox_network: true`）。
- `workspace_roots` 默认为空 `[]`，允许任意已存在绝对路径（直接兼容 `/swarm` 的 `share` / `branch` 临时副本）。
- `sandbox_mode` 可选 `"workspace-write"` 或 `"danger-full-access"`（`read_only` 任务仍保持只读沙箱）。

## 配套 Skill（原生零轮询代理 + `/swarm` 接入）

仓库内置 [skills/codex-subagent/SKILL.md](skills/codex-subagent/SKILL.md)，可复制到 `~/.gemini/config/skills/codex-subagent/SKILL.md`：

- **非阻塞后台代理**：用 `define_subagent(EnableMCPTools: true, EnableWriteTools: true)` + `invoke_subagent(Model: "flash")` 托管长任务——以 `wait_seconds: 0` 派工并在后台运行 `watch_command`（`NotificationTimeoutSeconds: 1800`）休眠等待系统唤醒，全程零轮询。
- **`/swarm` 接入**：在 `/swarm` 会话中拉起轻量化代理成员（`workspace: "share"`），通过 `codex_run(workspace: <成员工作目录>, mode: "workspace")` 让 Codex 在独立副本中执行并借助 `watch.js` 与 `codex_send(mode: "steer")` 在看板上实时沟通。

## 安装与验证

1. 在项目目录运行 `pnpm install --frozen-lockfile && pnpm build`。
2. 复制 `desktop.example.json` 为 `desktop.json` 并修改 `state_dir` 等本机路径。
3. 运行 `node scripts/cc-switch.mjs --open` 导入 Antigravity MCP 配置，或将 `node dist/server.js --config /path/to/desktop.json` 写入 `mcp_config.json`。
4. 本地验证：`pnpm test`（使用模拟 Codex App Server）。
