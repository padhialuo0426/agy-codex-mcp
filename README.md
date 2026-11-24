# Antigravity 的 Codex 子代理

Antigravity 桌面 App 通过本地 stdio MCP 委派任务。桥接服务调用本机 `codex app-server`，沿用 Codex 登录。每个子代理有独立会话，Antigravity 主代理负责决定任务和验收结果。

## 安装与配置

在项目目录运行 `pnpm install --frozen-lockfile` 和 `pnpm build`。需要 Linux、Node.js 24 以及已登录的 Codex CLI。先将 `desktop.example.json` 复制为 `desktop.json` 并填入本机路径。运行 `node scripts/cc-switch.mjs --open` 通过 CC Switch 导入 MCP，现有条目通过 CC Switch 的 MCP 页面编辑。导入只选择 Antigravity。脚本不加 `--open` 时输出待导入的服务器 JSON。

`desktop.json` 控制 Codex 路径、项目范围、工作目录、并行度、沙箱和审批策略。当前运行状态在 `~/.local/state/agy-codex-mcp`。`workspace_roots` 允许派工，`writable_roots` 另外允许 Git worktree 模式。默认只读，工作树中的改动由主代理审核。修改启动配置后，重新连接该 MCP。

常用沙箱与配置项：

- `extra_writable_roots`：为 `worktree` 模式的 `sandboxPolicy.writableRoots` 额外追加可写目录（例如包管理器缓存目录）。此外，桥接层会自动将当前 worktree 路径及其隔离 Git 元数据目录（`.git/worktrees/<id>`）加入 `writableRoots`。
- `sandbox_network`：默认 `false`；设为 `true` 时全局允许沙箱联网。按单次任务联网可在 `codex_spawn` 传入 `network: true`（未开启全局联网时会先触发人工审批）。
- `codex_config`：追加到 `codex app-server -c` 参数列表末尾，可覆盖默认的 `shell_environment_policy` 等配置。

## 权限审批

桥接支持 **Antigravity 侧栏审批（MCP App）** 与 **本机 Zenity 弹窗审批** 双通道，通过 `approval_mode` 配置：

- `panel_or_dialog`（默认当存在 `approval_dialog` 时）：若用户已打开 `codex_panel` 侧栏，则直接在侧栏审批，不再弹出抢焦点的 Zenity 窗口；否则同时支持侧栏与 Zenity 弹窗。如果 Zenity 启动失败或崩溃，会自动记录 `approval_dialog_unavailable` 事件并保留在侧栏等待确认，不会静默失败。
- `panel`：仅使用 `codex_panel` 侧栏内嵌的人工审批卡片。
- `dialog`：仅使用 `approval_dialog` 指定的本机弹窗程序。
- `off`：关闭人工审批通道（`approvalPolicy` 为 `"never"`）。

侧栏审批通过声明了 `_meta.ui.visibility = ["app"]` 的应用专属工具（`codex_panel_state` 与 `codex_approval_decide`）实现，**模型不可见且无法调用**，确保必须由用户手动点击确认。

相关审批行为选项：

- `reuse_worktree_approval`：设为 `true` 时，在 `workspace_roots` 内的非白名单 Git 仓库一旦批准创建 worktree，同一代理后续 `codex_followup` 无需重复审批；也可在侧栏直接选择「本工作树免重复审批」。
- `allow_readonly_command_approval`：默认 `true`，允许 `read_only` 子代理在需要人工确认命令执行时弹窗/在侧栏请示，而不是直接静默拒绝。对于 `item/permissions/requestApproval` 会区分只读 `entries` 与写权限。所有策略拒绝和未知请求都会记录事件（`approval_auto_declined` / `unhandled_request`）。
- `approval_policy`：支持 `"on-request"`（默认）、`"granular"` 或 `"untrusted"`；可选 `approvals_reviewer`（`"user"` / `"auto_review"` / `"guardian_subagent"`）。
- 在运行期命令/权限审批中，侧栏支持「批准一次」、「本会话放行」（`acceptForSession` / `scope: "session"`）、「按规则放行」（`acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment`）与「拒绝」。等待人工审批期间会暂停该轮 `max_turn_seconds` 倒计时。

## 派工与对话

1. 使用 `codex_models` 查询当前 Codex 账号的模型和各自支持的思考强度。派工时将查询返回的档位原样填入 `effort`。Codex 加入新档位后，服务会按模型列表接受该值。
2. 使用 `codex_spawn` 派工，传入当前项目的绝对路径和任务。可选 `role`、`model`、`effort`、`mode`、`network` 和 `context`。省略模型或思考强度时由 Codex 取默认值。若配置了非空的 `allowed_models`，显式模型选择会限定在这些模型内。
3. 把第一个调用返回的 `group_id` 用于同一批后续子代理。通过 `codex_wait` 增量读取进展，询问需要答复时，把问题 ID 放进 `codex_send.reply_to`。当返回 `needs_approval` 时可打开 `codex_panel` 让用户确认并继续等待。
4. 用 `codex_followup` 在已有会话继续派工。`codex_interrupt` 中断当前一轮，`codex_close` 释放已加载会话，`codex_resume` 重新挂载。恢复后需要显式派工。
5. 用 `codex_panel` 给桌面侧栏传入组 ID（省略时自动载入最近或存在待审批的代理组）。若宿主声明 MCP Apps 能力，侧栏提供状态、待审批卡片、最近代理组切换与直接控制按钮。

可写任务使用独立 Git worktree。默认从当前 checkout 的 HEAD 创建，可显式指定 `base` 和 `input_patch`。用 `codex_changes` 查 diff 和未跟踪文件。关闭子代理会保留改动和会话，方便之后恢复。

## 验证

`pnpm test` 使用模拟 Codex App Server，覆盖 stdio 工具、消息、并发、中断、恢复、worktree、沙箱可写根目录以及侧栏/弹窗双通道审批。 `pnpm test:live` 用合成仓库直接调用已登录的 Codex，验证并行派工和同轮提问回复。该命令使用 Codex 用量，不启动 Antigravity 对话。
