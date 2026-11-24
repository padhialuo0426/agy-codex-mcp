---
name: codex-subagent
description: >-
  Delegate coding, review, or repository tasks to local Codex via the agy-codex-mcp
  tools (`codex_run`, `codex_wait`, `codex_send`, `codex_manage`, `codex_models`),
  wrap long Codex tasks inside a lightweight native background subagent for reactive
  wakeup, or bridge Codex into an active `/swarm` session as a proxy worker.
---

# Codex Subagent Delegation (`agy-codex-mcp`)

Use this skill when delegating tasks to local Codex (`agy-codex-mcp`) or bridging Codex into Antigravity's native subagents and `/swarm`.

## Available MCP Tools (5 Total)

- `codex_run`: Start a new Codex agent (`workspace` + `task`) or continue an existing one (`agent_id` + `task`).
  - `mode`: `"read_only"` (default), `"worktree"` (isolated Git worktree + auto diff on finish), or `"workspace"` (direct edit inside `workspace`).
  - `background`: `false` (default, waits until completion or `needs_input`) or `true` (returns `agent_id` immediately).
- `codex_wait`: Wait on background Codex agents. Omit `agent_ids` and `after` to watch all active agents from the automatic cursor.
- `codex_send`: Answer a pending `ask_parent` question directly (no `reply_to` needed), steer a running turn, or start a follow-up (`wait: true` blocks until settled).
- `codex_manage`: `action: "list" | "changes" | "interrupt" | "close"`.
- `codex_models`: List available Codex models and supported reasoning `efforts`.

## Pattern 1: Short or Synchronous Task (1 Tool Call)

For quick analysis, code review, or focused edits, call `codex_run` directly with `background: false`:

- Read-only review: `codex_run({ workspace, mode: "read_only", role: "reviewer", task })`
- Isolated edit: `codex_run({ workspace, mode: "worktree", role: "worker", task })`
- If it returns `status: "needs_input"`, answer via `codex_send({ agent_id, text, wait: true })`.

## Pattern 2: Native-Style Background Execution (Zero Manual Polling)

When running a multi-minute Codex task in parallel with other work, avoid polling `codex_wait` in the main conversation:

1. Define a lightweight proxy subagent once per conversation:
   - `define_subagent({ Name: "codex-runner", EnableMCPTools: true, EnableWriteTools: false, Description: "Runs a bounded task via agy-codex-mcp and returns the final result and diff.", SystemPrompt: "Call mcp:agy-codex-mcp:codex_run with the given parameters. If status is needs_input and you cannot safely answer from the prompt, ask the parent or report the question; otherwise use codex_send(wait: true) or wait with codex_wait until finished, then return the verified result and changes." })`
2. Launch it with a fast model:
   - `invoke_subagent({ TypeName: "codex-runner", Model: "flash_lite", Role: "Codex Task Runner", Prompt: "..." })`
3. Stop calling tools or continue unrelated work — the system wakes the main conversation automatically when `codex-runner` finishes.

## Pattern 3: Bridging Codex into `/swarm`

In an active `/swarm` session (only when `/swarm` is already active or explicitly requested by the user):

1. Spawn a lightweight Swarm proxy worker on a shared work copy (`workspace: "share"` for writers, default `inherit` for reviewers):
   - `swarm({ action: "add", name: "codex-worker", model: "flash", workspace: "share", brief: "You are a Codex proxy worker. Use pwd to get your assigned working copy path, then delegate your implementation task via codex_run(workspace: <pwd>, mode: 'workspace', role: 'worker', task: ..., background: false). If Codex returns needs_input, forward the question on the Swarm board to @coordinator and pass the answer back via codex_send(wait: true). Once finished, inspect git diff/status in your working copy and report verified results and test output on the board." })`
2. The proxy worker runs Codex directly inside its isolated Swarm working copy (`mode: "workspace"`), keeps the Swarm board updated, and lets the coordinator review/merge its branch cleanly.
