import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, prepare } from "./support.mjs";

async function settle(bridge, { group_id, agent_id }, after = 0, maxAttempts = 8) {
  for (let count = 0; count < maxAttempts; count++) {
    const result = await bridge.call("wait", { group_id, agent_ids: [agent_id], mode: "all_finished", seconds: 5, after });
    if (result.reason === "all_finished") return result.agents[0];
    after = result.cursor;
  }
  assert.fail("Agent did not settle");
}

test("stdio group lifecycle, same-turn questions, worktree and persistent resumption", { timeout: 35_000 }, async (t) => {
  const fixture = await prepare(fileURLToPath(new URL("./fixture-codex.mjs", import.meta.url)));
  let bridge = await connect(fixture.config);
  t.after(async () => { await bridge.close(); await fixture.cleanup(); });
  const tools = await bridge.client.listTools();
  assert.equal(tools.tools.length, 13);
  assert.equal(tools.tools.find((tool) => tool.name === "codex_panel")._meta.ui.resourceUri, "ui://agy-codex-mcp/agents.html");
  assert.deepEqual(tools.tools.find((tool) => tool.name === "codex_panel_state")._meta.ui.visibility, ["app"]);
  assert.deepEqual(tools.tools.find((tool) => tool.name === "codex_approval_decide")._meta.ui.visibility, ["app"]);
  const ui = await bridge.client.readResource({ uri: "ui://agy-codex-mcp/agents.html" });
  assert.match(ui.contents[0].text, /Codex 子代理/);

  const nativeModels = await bridge.call("models", {});
  assert.deepEqual(nativeModels.models[0].efforts, ["medium", "high", "fixture-next-effort"]);
  assert.match(await bridge.call("spawn", {
    workspace: fixture.repository, task: "CHECK_MODEL", model: "fixture-sol", effort: "unadvertised-effort",
  }, true), /unsupported_effort/);
  assert.match(await bridge.call("spawn", {
    workspace: fixture.repository, task: "CHECK_MODEL", model: "invalid-model",
  }, true), /model_not_available/);

  const request_id = randomUUID();
  const task = {
    workspace: fixture.repository, task: "FIXTURE_QUESTION CHECK_MODEL",
    model: "fixture-sol", effort: nativeModels.models[0].efforts[2], request_id,
  };
  const first = await bridge.call("spawn", task);
  const again = await bridge.call("spawn", task);
  assert.equal(again.agent_id, first.agent_id);
  const group_id = first.group_id;
  const second = await bridge.call("spawn", { group_id, workspace: fixture.repository, task: "FIXTURE_HOLD" });
  const rejected = await bridge.call("spawn", { group_id, workspace: fixture.repository, task: "Overflow" }, true);
  assert.match(rejected, /concurrency_limit/);

  const question = await bridge.call("wait", { group_id, mode: "all_finished", seconds: 4 });
  assert.equal(question.reason, "needs_input");
  const query = question.agents.find((value) => value.agent_id === first.agent_id).question;
  assert.equal(query.text, "Which protocol version?");
  await bridge.call("send", { group_id, agent_id: first.agent_id, text: "stdio v2", reply_to: query.id });
  await bridge.call("send", { group_id, agent_id: second.agent_id, text: "Updated instructions." });
  await bridge.call("interrupt", { group_id, agent_id: second.agent_id });
  const done = await bridge.call("wait", { group_id, after: question.cursor, mode: "all_finished", seconds: 5 });
  assert.equal(done.reason, "all_finished");
  assert.match(done.agents.find((value) => value.agent_id === first.agent_id).result, /answer: stdio v2/);
  assert.equal(done.agents.find((value) => value.agent_id === second.agent_id).status, "interrupted");
  assert.ok(done.events.every((event) => event.seq > question.cursor));
  assert.ok(done.events.some((event) => event.kind === "commentary"));
  const closed = await bridge.call("close", { group_id, agent_id: second.agent_id });
  assert.equal(closed.status, "closed");
  await bridge.close();
  bridge = await connect(fixture.config);
  await bridge.call("resume", { group_id, agent_id: second.agent_id });
  await bridge.call("send", { group_id, agent_id: second.agent_id, text: "QUEUED_NOTE" });
  await bridge.call("followup", { group_id, agent_id: second.agent_id, task: "Recheck" });
  const followed = await bridge.call("wait", { group_id, agent_ids: [second.agent_id], mode: "all_finished", seconds: 6 });
  assert.equal(followed.agents[0].result, "continued with queued note");

  const blocked = join(fixture.repository, "escape");
  await symlink("/tmp", blocked);
  assert.notEqual(await realpath(blocked), fixture.repository);
  assert.match(await bridge.call("spawn", { workspace: blocked, task: "Out of scope" }, true), /workspace_out_of_scope/);
  const worker = await bridge.call("spawn", {
    group_id, workspace: fixture.repository, task: "Read repo in an isolated worker", role: "worker", mode: "worktree",
    fork_from: first.agent_id,
  });
  await writeFile(join(worker.worktree_path, "readme.txt"), "Changed isolated worktree.\n");
  await writeFile(join(worker.worktree_path, "new.txt"), "New\n");
  const changes = await bridge.call("changes", { group_id, agent_id: worker.agent_id });
  assert.match(changes.diff, /Changed isolated worktree/);
  assert.match(changes.untracked, /new.txt/);
  assert.equal(await readFile(join(fixture.repository, "readme.txt"), "utf8"), "Initial repository.\n");
  assert.match(await bridge.call("changes", { group_id, agent_id: worker.agent_id, path: "../other" }, true), /invalid_path/);
});

test("human approval gates a new worktree and one-turn Codex escalation", { timeout: 25_000 }, async (t) => {
  const fixture = await prepare(fileURLToPath(new URL("./fixture-codex.mjs", import.meta.url)));
  const config = JSON.parse(await readFile(fixture.config, "utf8"));
  config.writable_roots = [];
  config.approval_dialog = fileURLToPath(new URL("./fixture-approval.mjs", import.meta.url));
  config.approval_timeout_seconds = 5;
  await writeFile(fixture.config, JSON.stringify(config));
  const bridge = await connect(fixture.config);
  t.after(async () => { await bridge.close(); await fixture.cleanup(); });
  const args = { workspace: fixture.repository, mode: "worktree", role: "worker" };

  const denied = await bridge.call("spawn", { ...args, task: "DENY_DIALOG" });
  assert.equal(denied.status, "needs_approval");
  assert.equal(denied.worktree_path, undefined);
  const failed = await settle(bridge, denied);
  assert.equal(failed.status, "interrupted");
  assert.equal(failed.worktree_path, undefined);
  assert.match(failed.result, /declined/);

  const paused = await bridge.call("spawn", { ...args, task: "HOLD_DIALOG" });
  assert.equal(paused.status, "needs_approval");
  await bridge.call("interrupt", { group_id: paused.group_id, agent_id: paused.agent_id });
  const interrupted = await settle(bridge, paused);
  assert.equal(interrupted.status, "interrupted");
  assert.equal(interrupted.worktree_path, undefined);

  const worker = await bridge.call("spawn", { ...args, task: "FIXTURE_REVIEW_command DENY_COMMAND" });
  const finished = await settle(bridge, worker);
  assert.ok(finished.worktree_path);
  assert.equal(finished.result, "command: decline");
  const key = { group_id: worker.group_id, agent_id: worker.agent_id };
  for (const kind of ["command", "file", "permissions"]) {
    const follow = await bridge.call("followup", { ...key, task: `FIXTURE_REVIEW_${kind}` });
    assert.equal(follow.status, "needs_approval");
    const completed = await settle(bridge, key);
    assert.equal(completed.result, `${kind}: accept`);
  }

  const hold = await bridge.call("followup", { ...key, task: "FIXTURE_REVIEW_command HOLD_DIALOG" });
  assert.equal(hold.status, "needs_approval");
  const pending = await bridge.call("wait", { group_id: key.group_id, agent_ids: [key.agent_id], mode: "all_finished", seconds: 4 });
  let cursor = pending.cursor;
  let review = pending.agents[0];
  for (let attempt = 0; attempt < 4 && review.approvals?.[0]?.kind !== "command"; attempt++) {
    const next = await bridge.call("wait", { group_id: key.group_id, agent_ids: [key.agent_id], after: cursor, seconds: 4 });
    cursor = next.cursor;
    review = next.agents[0];
    assert.notEqual(review.status, "completed", "Command should be waiting for the human dialog");
  }
  assert.equal(review.approvals?.[0]?.kind, "command");
  await bridge.call("send", { ...key, text: "I approve" });
  assert.equal((await bridge.call("list", { group_id: key.group_id })).agents[0].status, "needs_approval");
  await bridge.call("interrupt", key);
  assert.equal((await settle(bridge, key, cursor)).status, "interrupted");

  const repo = await readFile(join(fixture.repository, "readme.txt"), "utf8");
  assert.equal(repo, "Initial repository.\n");
});

test("side panel approval flow, session reuse, execpolicy amendment, and read-only policies", { timeout: 30_000 }, async (t) => {
  const fixture = await prepare(fileURLToPath(new URL("./fixture-codex.mjs", import.meta.url)));
  const config = JSON.parse(await readFile(fixture.config, "utf8"));
  config.writable_roots = [];
  config.approval_mode = "panel";
  config.approval_timeout_seconds = 10;
  await writeFile(fixture.config, JSON.stringify(config));
  const bridge = await connect(fixture.config);
  t.after(async () => { await bridge.close(); await fixture.cleanup(); });

  const worker = await bridge.call("spawn", {
    workspace: fixture.repository,
    mode: "worktree",
    role: "worker",
    task: "FIXTURE_REVIEW_command_session",
  });
  assert.equal(worker.status, "needs_approval");
  assert.ok(worker.approvals[0].options.some((opt) => opt.choice === "session"));

  const initialPanel = await bridge.call("panel_state", {});
  assert.equal(initialPanel.group_id, worker.group_id);
  assert.equal(initialPanel.recent_groups[0].pending_approvals, 1);

  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: worker.agent_id,
    approval_id: worker.approvals[0].id,
    decision: "session",
  });

  const cmdWait = await bridge.call("wait", {
    group_id: worker.group_id,
    agent_ids: [worker.agent_id],
    after: initialPanel.cursor,
    mode: "all_finished",
    seconds: 5,
  });
  assert.equal(cmdWait.reason, "needs_approval");
  const cmdApproval = cmdWait.agents[0].approvals[0];
  assert.equal(cmdApproval.kind, "command");
  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: worker.agent_id,
    approval_id: cmdApproval.id,
    decision: "session",
  });
  const done1 = await settle(bridge, worker, cmdWait.cursor);
  assert.equal(done1.result, "command: acceptForSession");
  const afterDone1 = (await bridge.call("wait", { group_id: worker.group_id, agent_ids: [worker.agent_id], seconds: 0 })).cursor;

  // Because worktree was approved with "session", followup should NOT re-prompt for worktree!
  const followAmend = await bridge.call("followup", {
    group_id: worker.group_id,
    agent_id: worker.agent_id,
    task: "FIXTURE_REVIEW_command_amend",
  });
  assert.ok(followAmend.status === "starting" || followAmend.status === "running");
  assert.equal(followAmend.approvals, undefined);
  const amendWait = await bridge.call("wait", {
    group_id: worker.group_id,
    agent_ids: [worker.agent_id],
    after: afterDone1,
    mode: "all_finished",
    seconds: 5,
  });
  assert.equal(amendWait.reason, "needs_approval");
  const amendApproval = amendWait.agents[0].approvals[0];
  assert.ok(amendApproval.options.some((opt) => opt.choice === "amend"));
  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: worker.agent_id,
    approval_id: amendApproval.id,
    decision: "amend",
  });
  const done2 = await settle(bridge, worker, amendWait.cursor);
  assert.deepEqual(JSON.parse(done2.result.replace("command: ", "")), {
    acceptWithExecpolicyAmendment: { execpolicy_amendment: ["printf", "fixture"] },
  });
  const afterDone2 = (await bridge.call("wait", { group_id: worker.group_id, agent_ids: [worker.agent_id], seconds: 0 })).cursor;

  // Read-only agent can approve command and read-only entries permissions (with null stripped)
  const roCmd = await bridge.call("spawn", {
    group_id: worker.group_id,
    workspace: fixture.repository,
    mode: "read_only",
    task: "FIXTURE_REVIEW_command",
  });
  const roCmdWait = await bridge.call("wait", {
    group_id: worker.group_id,
    agent_ids: [roCmd.agent_id],
    after: afterDone2,
    mode: "all_finished",
    seconds: 5,
  });
  assert.equal(roCmdWait.reason, "needs_approval");
  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: roCmd.agent_id,
    approval_id: roCmdWait.agents[0].approvals[0].id,
    decision: "once",
  });
  const roCmdDone = await settle(bridge, roCmd, roCmdWait.cursor);
  assert.equal(roCmdDone.result, "command: accept");
  const afterRoCmd = (await bridge.call("wait", { group_id: worker.group_id, agent_ids: [roCmd.agent_id], seconds: 0 })).cursor;

  const roPerm = await bridge.call("followup", {
    group_id: worker.group_id,
    agent_id: roCmd.agent_id,
    task: "FIXTURE_REVIEW_permissions_read_entries",
  });
  const roPermWait = await bridge.call("wait", {
    group_id: worker.group_id,
    agent_ids: [roPerm.agent_id],
    after: afterRoCmd,
    mode: "all_finished",
    seconds: 5,
  });
  assert.equal(roPermWait.reason, "needs_approval");
  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: roPerm.agent_id,
    approval_id: roPermWait.agents[0].approvals[0].id,
    decision: "session",
  });
  const roPermDone = await settle(bridge, roPerm, roPermWait.cursor);
  assert.equal(roPermDone.result, "permissions: session:clean:read");

  // Read-only agent requesting file_change is declined with explicit audit event
  const roFile = await bridge.call("followup", {
    group_id: worker.group_id,
    agent_id: roCmd.agent_id,
    task: "FIXTURE_REVIEW_file",
  });
  const roFileDone = await settle(bridge, roFile, roPermWait.cursor);
  assert.equal(roFileDone.result, "file: decline");
  const panelEvents = await bridge.call("panel_state", { group_id: worker.group_id });
  assert.ok(panelEvents.events.some((ev) => ev.kind === "approval_auto_declined" && ev.text.includes("readonly_file_change_blocked")));
});

test("sandboxPolicy writableRoots, codex_config override order, and upfront network approval", { timeout: 25_000 }, async (t) => {
  const fixture = await prepare(fileURLToPath(new URL("./fixture-codex.mjs", import.meta.url)));
  const extraCache = join(fixture.repository, "..", "extra-cache");
  await mkdir(extraCache);
  const config = JSON.parse(await readFile(fixture.config, "utf8"));
  config.extra_writable_roots = [extraCache];
  config.codex_config = ['shell_environment_policy.inherit="all"'];
  config.approval_mode = "panel";
  config.approval_policy = "granular";
  await writeFile(fixture.config, JSON.stringify(config));
  const bridge = await connect(fixture.config);
  t.after(async () => { await bridge.close(); await fixture.cleanup(); });

  const worker = await bridge.call("spawn", {
    workspace: fixture.repository,
    mode: "worktree",
    role: "worker",
    network: true,
    task: "CHECK_SANDBOX",
  });
  assert.equal(worker.status, "needs_approval");
  assert.equal(worker.approvals[0].kind, "spawn_permissions");
  await bridge.call("approval_decide", {
    group_id: worker.group_id,
    agent_id: worker.agent_id,
    approval_id: worker.approvals[0].id,
    decision: "once",
  });
  const settled = await settle(bridge, worker);
  const [sandboxPart, threadPart] = settled.result.split("|thread:");
  const sandbox = JSON.parse(sandboxPart.replace("sandbox:", ""));
  const thread = JSON.parse(threadPart);
  assert.equal(sandbox.type, "workspaceWrite");
  assert.equal(sandbox.networkAccess, true);
  assert.ok(sandbox.writableRoots.includes(settled.worktree_path));
  assert.ok(sandbox.writableRoots.some((root) => root.includes(".git/worktrees/")));
  assert.ok(sandbox.writableRoots.includes(await realpath(extraCache)));
  assert.ok(thread.approvalPolicy.granular);

  const cfgAgent = await bridge.call("spawn", {
    group_id: worker.group_id,
    workspace: fixture.repository,
    mode: "read_only",
    task: "CHECK_CONFIG",
  });
  const cfgSettled = await settle(bridge, cfgAgent);
  const overrides = JSON.parse(cfgSettled.result.replace("config:", ""));
  assert.equal(overrides.at(-1), 'shell_environment_policy.inherit="all"');
});

test("panel_or_dialog fallback when dialog crashes and non-expiring queued dialogs", { timeout: 25_000 }, async (t) => {
  const fixture = await prepare(fileURLToPath(new URL("./fixture-codex.mjs", import.meta.url)));
  const config = JSON.parse(await readFile(fixture.config, "utf8"));
  config.writable_roots = [];
  config.approval_mode = "panel_or_dialog";
  config.approval_dialog = fileURLToPath(new URL("./fixture-approval.mjs", import.meta.url));
  config.approval_timeout_seconds = 5;
  await writeFile(fixture.config, JSON.stringify(config));
  const bridge = await connect(fixture.config);
  t.after(async () => { await bridge.close(); await fixture.cleanup(); });

  // Case 1: Dialog crashes -> logs approval_dialog_unavailable and remains approvable via panel
  const crashed = await bridge.call("spawn", {
    workspace: fixture.repository,
    mode: "worktree",
    role: "worker",
    task: "CRASH_DIALOG",
  });
  assert.equal(crashed.status, "needs_approval");
  let diagFound = false;
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const w = await bridge.call("wait", { group_id: crashed.group_id, agent_ids: [crashed.agent_id], after: cursor, seconds: 2 });
    cursor = w.cursor;
    if (w.events.some((ev) => ev.kind === "approval_dialog_unavailable")) {
      diagFound = true;
      break;
    }
  }
  assert.equal(diagFound, true);
  await bridge.call("approval_decide", {
    group_id: crashed.group_id,
    agent_id: crashed.agent_id,
    approval_id: crashed.approvals[0].id,
    decision: "once",
  });
  const crashSettled = await settle(bridge, crashed, cursor);
  assert.equal(crashSettled.result, "finished");

  // Case 2: Two concurrent slow dialogs (3.2s each > 5s total) both succeed because timeout starts when shown
  const bridge2 = await connect(fixture.config);
  t.after(bridge2.close);
  const q1 = await bridge2.call("spawn", {
    workspace: fixture.repository,
    mode: "worktree",
    role: "worker",
    task: "QUEUE_HOLD_DIALOG",
  });
  const q2 = await bridge2.call("spawn", {
    group_id: q1.group_id,
    workspace: fixture.repository,
    mode: "worktree",
    role: "worker",
    task: "QUEUE_HOLD_DIALOG",
  });
  const [r1, r2] = await Promise.all([settle(bridge2, q1), settle(bridge2, q2)]);
  assert.equal(r1.result, "finished");
  assert.equal(r2.result, "finished");
});
