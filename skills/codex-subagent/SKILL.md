---
name: codex-subagent
description: >-
  Delegate coding, review, or repository tasks to local Codex via the 4 agy-codex-mcp
  tools (`codex_run`, `codex_send`, `codex_manage`, `codex_models`), watch long
  tasks with zero-polling `watch_command` background wakeup, communicate bidirectionally
  in real time (`turn/steer` + `ask_parent` + `report_to_parent`), or bridge Codex
  into an active `/swarm` session.
---

# Codex Subagent Delegation (`agy-codex-mcp`)

Use this skill when delegating tasks to local Codex (`agy-codex-mcp`) or bridging Codex into Antigravity's native subagents and `/swarm`.

## Available MCP Tools (4 Total — Zero Polling)

- `codex_run`: Start a new Codex agent (`workspace` + `task`) or continue a kept session (`agent_id` + `task`).
  - `mode`: `"read_only"` (default), `"worktree"` (isolated Git worktree + auto diff & `patch_file` on finish), or `"workspace"` (direct edit inside `workspace`).
  - `input_patch_file`: Preferred way to pass a local `.patch` file when creating a worktree (absolute path, no 120KB inline limit). Use `input_patch` only for a raw Git diff string (NOT a file path).
  - `wait_seconds`: Synchronous wait window (default `90`, `0` = immediate return). If a healthy script takes longer, `codex_run` returns `still_running: true`, live `activity`, `cursor`, `watch_command`, and `recommended_notification_timeout_seconds` **without killing the script**.
  - `max_turn_seconds`: Optional hard execution ceiling (up to `14400`s) for long builds/simulations. Exceeding `max_turn_seconds` (or calling `interrupt` / `close`) terminates the turn and reaps all child scripts.
  - `question_timeout_seconds`: Optional deadline (default `900`s) for `ask_parent` answers before Codex resumes with a clarification-timeout error.
  - `keep_session`: `false` by default — threads run `ephemeral: true` and auto-close after delivering results (preventing history pile-up in ChatGPT Desktop). Pass `keep_session: true` only for multi-turn follow-ups or `fork_from`.
- `codex_send`: Real-time communication with Codex:
  - `mode: "answer"`: Explicitly answers a pending `ask_parent` question (`requires_parent_answer: true`).
  - `mode: "steer"` (or `"auto"` while running): injects new constraints/instructions directly into an active Codex turn (`turn/steer`). `auto` answers if a question is pending, otherwise steers if running, otherwise starts a follow-up.
  - `wait: true` blocks up to `wait_seconds` after answering or following up.
- `codex_manage`: `action: "status" | "list" | "changes" | "interrupt" | "close" | "cleanup"`.
  - Use `status` for one-off inspection of live `activity` (current command/file change & elapsed time) and recent events (repeated polling emits a warning).
  - Use `changes` (`output_patch_path` optional) to export the full untruncated `patch_file` and `diff_stat` from a worktree without running shell `git diff`.
  - Use `cleanup` to delete old persisted Codex threads, remove leftover worktrees, and clear stream/patch files.
- `codex_models`: List available Codex models and supported reasoning `efforts`.

## Pattern 1: Short Task (1 Tool Call)

For quick analysis, reviews, or small edits, call `codex_run` directly (`wait_seconds: 90`):

- Read-only review: `codex_run({ workspace, mode: "read_only", role: "reviewer", task })`
- Isolated edit: `codex_run({ workspace, mode: "worktree", role: "worker", task })` (check `changes.patch_file` for the full untruncated diff path).
- If it returns `status: "needs_input"`, answer via `codex_send({ agent_id, text, mode: "answer", wait: true })`.

## Pattern 2: Long Task + Bidirectional Real-Time Communication (Zero Polling + Visible Subagents Sidebar)

NEVER poll (`schedule`, shell `sleep`, `manage_task(status)`, or `codex_manage(status)`) in a loop! Whenever `codex_run` returns `still_running: true` (or `background: true` / `wait_seconds: 0`), use the returned `watch_command` with Antigravity's native background `run_command` (`NotificationTimeoutSeconds: 1800` or `recommended_notification_timeout_seconds`) for **0-token reactive wakeup**:

1. Define a lightweight proxy subagent once per conversation (with `EnableMCPTools: true` and `EnableWriteTools: true`, restricted ONLY to managing the Codex worker and running `watch_command` via `run_command`) using a strict 4-step event-driven FSM + hard prohibitions:
   - `define_subagent({ Name: "codex-runner", EnableMCPTools: true, EnableWriteTools: true, Description: "Runs a Codex task via agy-codex-mcp, watches long runs via watch_command with zero polling, and relays bidirectional messages in real time.", SystemPrompt: "1. Start or monitor the task with mcp:agy-codex-mcp:codex_run(..., wait_seconds: 0) (use input_patch_file for patch files, never input_patch with a file path) and call update_focus with the task role. 2. Run the exact returned watch_command via run_command (WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: recommended_notification_timeout_seconds or 1800), then IMMEDIATELY stop calling tools and end your turn to sleep at 0 tokens until watch.js exits. 3. Branch strictly on wakeup_reason when woken: (a) report: call update_focus with the latest milestone, output one concise progress line, launch next_watch_command via run_command (WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: 1800), and end your turn; (b) needs_input: NEVER answer on your own — forward any unread reports plus the exact question via send_message to the parent and wait for the parent's reply, then call codex_send({ agent_id, text, mode: 'answer', wait: false }), launch next_watch_command, and end your turn; (c) completed/failed/interrupted/closed: if a worktree has changes and wasn't already exported, read/export patch_file via changes.patch_file or codex_manage({ action: 'changes', agent_id, output_patch_path }) (do NOT run shell git diff), report the final verified result, unread reports, and patch_file via send_message to the parent, and stop; (d) parent message while watching: call codex_send({ agent_id, text, mode: 'auto', wait: false }) immediately and leave the healthy background watch_command running. 4. HARD PROHIBITIONS: NEVER call schedule, NEVER run shell sleep or shell git diff, NEVER call manage_task(status) or codex_manage(status) while watch.js is running, and NEVER edit repository source files yourself." })`
2. Launch it with `Model: "flash"` (avoid `flash_lite`, which frequently violates negative constraints by adding `schedule` polling timers or answering `needs_input` itself):
   - `invoke_subagent({ TypeName: "codex-runner", Model: "flash", Role: "Codex Task Runner", Prompt: "..." })`
3. While `codex-runner` sleeps on `watch_command`, the parent can send mid-turn corrections anytime with `send_message(Recipient: <subagentId>, Message: "...")` — `codex-runner` wakes immediately and steers the live Codex turn!

## Pattern 3: Bridging Codex into `/swarm`

In an active `/swarm` session (only when `/swarm` is already active or explicitly requested by the user):

1. Spawn a lightweight Swarm proxy worker on a shared work copy (`workspace: "share"` for writers, default `inherit` for reviewers):
   - `swarm({ action: "add", name: "codex-worker", model: "flash", workspace: "share", brief: "You are a Codex proxy worker. Use pwd to get your assigned working copy path, then start the task via codex_run(workspace: <pwd>, mode: 'workspace', role: 'worker', task: ..., wait_seconds: 0). Run the returned watch_command in the background (WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: 1800) and immediately end your turn to sleep. NEVER call schedule, sleep, manage_task(status), or codex_manage(status) while watching. When woken by watch.js: on 'report', post the update and resume with next_watch_command; on 'needs_input', NEVER answer yourself — post the exact question on the Swarm board to @coordinator, relay the reply via codex_send({ agent_id, text, mode: 'answer', wait: false }), and resume watching with next_watch_command. If @coordinator or a peer posts new guidance while you are watching, immediately call codex_send({ agent_id, text, mode: 'auto', wait: false }) without restarting watch_command. On completion, verify git diff/status and post the verified result on the board." })`
2. The proxy worker runs Codex directly inside its isolated Swarm working copy (`mode: "workspace"`), keeps the Swarm board updated in real time, and lets the coordinator review/merge its branch cleanly.
