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
  - `mode`: `"read_only"` (default), `"worktree"` (isolated Git worktree + auto diff on finish), or `"workspace"` (direct edit inside `workspace`).
  - `wait_seconds`: Synchronous wait window (default `90`, `0` = immediate return). If a healthy script takes longer, `codex_run` returns `still_running: true`, live `activity`, `cursor`, and a `watch_command` **without killing the script**.
  - `max_turn_seconds`: Optional hard execution ceiling (up to `14400`s) for long builds/simulations. Exceeding `max_turn_seconds` (or calling `interrupt` / `close`) terminates the turn and reaps all child scripts.
  - `keep_session`: `false` by default — threads run `ephemeral: true` and auto-close after delivering results (preventing history pile-up in ChatGPT Desktop). Pass `keep_session: true` only for multi-turn follow-ups or `fork_from`.
- `codex_send`: Real-time communication with Codex:
  - `mode: "steer"` (or `"auto"` while running): injects new constraints/instructions directly into an active Codex turn (`turn/steer`).
  - Answers a pending `ask_parent` question directly (no `reply_to` needed).
  - `wait: true` blocks up to `wait_seconds` after answering or following up.
- `codex_manage`: `action: "status" | "list" | "changes" | "interrupt" | "close" | "cleanup"`.
  - Use `status` to inspect live `activity` (current command/file change & elapsed time) and recent events.
  - Use `cleanup` to delete old persisted Codex threads, remove leftover worktrees, and clear stream files.
- `codex_models`: List available Codex models and supported reasoning `efforts`.

## Pattern 1: Short Task (1 Tool Call)

For quick analysis, reviews, or small edits, call `codex_run` directly (`wait_seconds: 90`):

- Read-only review: `codex_run({ workspace, mode: "read_only", role: "reviewer", task })`
- Isolated edit: `codex_run({ workspace, mode: "worktree", role: "worker", task })`
- If it returns `status: "needs_input"`, answer via `codex_send({ agent_id, text, wait: true })`.

## Pattern 2: Long Task + Bidirectional Real-Time Communication (Zero Polling!)

NEVER poll `codex_manage` in a loop! Whenever `codex_run` returns `still_running: true` (or `background: true`), use the returned `watch_command` with Antigravity's native background `run_command` for **0-token reactive wakeup**:

1. Define a lightweight proxy subagent once per conversation (with `EnableMCPTools: true` and `EnableWriteTools: true`, restricted ONLY to running `watch_command` via `run_command`):
   - `define_subagent({ Name: "codex-runner", EnableMCPTools: true, EnableWriteTools: true, Description: "Runs a Codex task via agy-codex-mcp, watches long runs via watch_command with zero polling, and relays bidirectional messages in real time.", SystemPrompt: "1. Start or monitor the task with mcp:agy-codex-mcp:codex_run. 2. NEVER poll in a loop. Whenever codex_run returns still_running: true or background: true, run the exact returned watch_command via run_command (WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: 600) and STOP calling tools so the system sleeps at 0 tokens until watch.js exits. 3. When watch.js wakes you: if wakeup_reason is completed/failed/interrupted/closed, report the final result and changes; if needs_input or report, send_message to the parent (or answer if unambiguous) using codex_send, then run next_watch_command in the background and sleep again. 4. If a message arrives from the parent while watching, call codex_send({ agent_id, text, mode: 'steer', wait: false }) immediately to steer the active Codex turn, and leave the running background watch_command running. Only use run_command to execute watch_command — never edit files yourself." })`
2. Launch it with a fast model (`flash_lite` or `flash`):
   - `invoke_subagent({ TypeName: "codex-runner", Model: "flash_lite", Role: "Codex Task Runner", Prompt: "..." })`
3. While `codex-runner` sleeps on `watch_command`, the parent can send mid-turn corrections anytime with `send_message(Recipient: <subagentId>, Message: "...")` — `codex-runner` wakes immediately and steers the live Codex turn!

## Pattern 3: Bridging Codex into `/swarm`

In an active `/swarm` session (only when `/swarm` is already active or explicitly requested by the user):

1. Spawn a lightweight Swarm proxy worker on a shared work copy (`workspace: "share"` for writers, default `inherit` for reviewers):
   - `swarm({ action: "add", name: "codex-worker", model: "flash", workspace: "share", brief: "You are a Codex proxy worker. Use pwd to get your assigned working copy path, then start the task via codex_run(workspace: <pwd>, mode: 'workspace', role: 'worker', task: ..., wait_seconds: 60). If it returns still_running: true, run the returned watch_command in the background (WaitMsBeforeAsync: 5000, NotificationTimeoutSeconds: 600) and end your turn to sleep. When woken by watch.js: forward 'report' or 'needs_input' on the Swarm board to @coordinator, pass any reply via codex_send({ agent_id, text, wait: false }), and resume watching with next_watch_command. If @coordinator or a peer posts new guidance while you are watching, immediately call codex_send({ agent_id, text, mode: 'steer' }) without restarting watch_command. On completion, verify git diff/status and post the verified result on the board." })`
2. The proxy worker runs Codex directly inside its isolated Swarm working copy (`mode: "workspace"`), keeps the Swarm board updated in real time, and lets the coordinator review/merge its branch cleanly.
