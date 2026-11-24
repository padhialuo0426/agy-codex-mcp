import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Codex 子代理", version: "0.1.0" });
const get = (id) => document.getElementById(id);
const status = {
  starting: "启动中", running: "运行中", needs_approval: "等待审批", needs_input: "等待回复", idle: "空闲",
  completed: "已完成", interrupted: "已中断", closed: "已关闭", failed: "失败",
};
const kinds = {
  starting: "派工", running: "开始", question: "提问", answered: "回复",
  report: "汇报", commentary: "进展", queued: "待发送", steered: "补充指令",
  completed: "完成", failed: "失败", interrupted: "中断", resumed: "恢复",
  approval_requested: "请求审批", approval_approved: "已批准", approval_session: "本会话放行",
  approval_amend: "已按规则放行", approval_declined: "已拒绝",
  approval_expired: "审批超时", approval_cancelled: "审批已取消", approval_unavailable: "审批不可用",
  approval_auto_declined: "策略自动拒绝", approval_dialog_unavailable: "桌面弹窗不可用",
  unhandled_request: "未处理请求", closed: "关闭", time_limit: "超时", question_expired: "问题超时",
};
const approvalKindLabels = {
  worktree: "可写工作树",
  spawn_permissions: "派工权限",
  command: "命令执行",
  file_change: "文件改动",
  permissions: "额外权限",
  network: "网络访问",
};

let group;
let cursor = 0;
let agents = [];
let watch = 0;
let pollTimer;
const inFlightApprovals = new Set();
const feedback = (text) => { get("feedback").textContent = text; };
const selected = () => agents.find((agent) => agent.agent_id === get("agent").value);

function applyTheme(ctx) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
}

async function call(name, args) {
  const result = await app.callServerTool({ name: `codex_${name}`, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (result.isError) throw new Error(text ?? "调用失败");
  return result.structuredContent ?? JSON.parse(text ?? "{}");
}

function renderRecentGroups(groups) {
  const select = get("recent-groups");
  if (!groups?.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "无历史代理组";
    select.replaceChildren(empty);
    return;
  }
  select.replaceChildren(...groups.map((item) => {
    const option = document.createElement("option");
    option.value = item.group_id;
    const flags = [
      item.pending_approvals ? `${item.pending_approvals} 待审批` : "",
      item.active ? `${item.active} 运行中` : "",
    ].filter(Boolean).join(" · ");
    option.textContent = `${item.group_id.slice(0, 8)}${flags ? ` (${flags})` : ""}`;
    return option;
  }));
  if (group && groups.some((item) => item.group_id === group)) select.value = group;
}

function renderApprovals(list) {
  const section = get("approvals");
  const container = get("approval-list");
  const pending = list.flatMap((agent) => (agent.approvals ?? []).map((approval) => ({ agent, approval })));
  if (!pending.length) {
    section.hidden = true;
    container.replaceChildren();
    return;
  }
  section.hidden = false;
  container.replaceChildren(...pending.map(({ agent, approval }) => {
    const card = document.createElement("div");
    card.className = "approval-card";

    const badges = document.createElement("div");
    badges.className = "badges";
    const agentBadge = document.createElement("span");
    agentBadge.className = "badge";
    agentBadge.textContent = `${agent.role} · ${agent.agent_id.slice(0, 8)}`;
    const kindBadge = document.createElement("span");
    kindBadge.className = "badge";
    kindBadge.textContent = approvalKindLabels[approval.kind] ?? approval.kind;
    const expiryBadge = document.createElement("span");
    expiryBadge.className = "badge";
    const expiresAt = new Date(approval.expires_at);
    expiryBadge.textContent = Number.isNaN(expiresAt.getTime()) ? "" : `截止 ${expiresAt.toLocaleTimeString()}`;
    badges.append(agentBadge, kindBadge, expiryBadge);

    const summary = document.createElement("p");
    summary.textContent = approval.summary ?? approval.kind;

    const details = document.createElement("details");
    const detailSummary = document.createElement("summary");
    detailSummary.textContent = "查看请求详情";
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(approval.details ?? {}, null, 2);
    details.append(detailSummary, pre);

    const actions = document.createElement("div");
    actions.className = "row";
    const busyApproval = inFlightApprovals.has(approval.id);
    for (const option of approval.options ?? []) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.label;
      button.className = option.choice === "decline" ? "danger" : "primary";
      button.disabled = busyApproval;
      button.addEventListener("click", async () => {
        if (inFlightApprovals.has(approval.id)) return;
        inFlightApprovals.add(approval.id);
        renderApprovals(agents);
        try {
          await call("approval_decide", {
            group_id: group,
            agent_id: agent.agent_id,
            approval_id: approval.id,
            decision: option.choice,
          });
          feedback(`已提交审批决定：${option.label}`);
        } catch (error) {
          feedback(error.message);
        } finally {
          inFlightApprovals.delete(approval.id);
          await refreshOnce();
        }
      });
      actions.append(button);
    }

    card.append(badges, summary, details, actions);
    return card;
  }));
}

function render(next) {
  const previous = get("agent").value;
  agents = next;
  get("agents").replaceChildren(...agents.map((agent) => {
    const line = document.createElement("li");
    line.textContent = `${agent.role} · ${status[agent.status] ?? agent.status} · ${agent.task}`;
    return line;
  }));
  get("agent").replaceChildren(...agents.map((agent) => {
    const option = document.createElement("option");
    option.value = agent.agent_id;
    option.textContent = `${agent.role} · ${agent.agent_id.slice(0, 8)}`;
    return option;
  }));
  if (agents.some((agent) => agent.agent_id === previous)) get("agent").value = previous;
  renderApprovals(agents);
  showQuestion();
}

function showQuestion() {
  const agent = selected();
  get("question").textContent = agent?.question?.text ?? (agent?.approvals?.length ? "请在本面板上方或本地审批窗口确认请求。" : "");
  get("text").placeholder = agent?.question ? "回复当前问题" : "发消息或续派任务";
  document.querySelectorAll("[data-action], [data-mode]").forEach((button) => {
    button.disabled = !agent || (button.dataset.action === "changes" && !agent.worktree_path);
  });
}

function append(events) {
  const feed = get("messages");
  const pinned = feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 12;
  for (const event of events) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const text = document.createElement("p");
    label.textContent = `${event.agent_id.slice(0, 8)} · ${kinds[event.kind] ?? event.kind}`;
    text.textContent = event.text;
    item.append(label, text);
    feed.append(item);
  }
  while (feed.children.length > 100) feed.firstElementChild.remove();
  if (pinned) feed.scrollTop = feed.scrollHeight;
}

async function refreshOnce() {
  try {
    const data = await call("panel_state", { ...(group ? { group_id: group } : {}), after: cursor });
    if (data.recent_groups) renderRecentGroups(data.recent_groups);
    if (!data.group_id) {
      feedback("当前没有运行中或历史的 Codex 代理组。");
      render([]);
      return;
    }
    if (group !== data.group_id) {
      group = data.group_id;
      cursor = 0;
      get("group").value = group;
      get("messages").replaceChildren();
    }
    cursor = data.cursor;
    render(data.agents);
    append(data.events);
  } catch (error) {
    feedback(error.message);
  }
}

async function poll(target, version) {
  let online = false;
  while (watch === version) {
    try {
      const data = await call("panel_state", { ...(target ? { group_id: target } : {}), after: cursor });
      if (watch !== version) return;
      if (data.recent_groups) renderRecentGroups(data.recent_groups);
      if (!data.group_id) {
        if (!online) feedback("当前没有 Codex 代理组，等待主代理派工…");
        online = true;
      } else {
        if (group !== data.group_id) {
          group = data.group_id;
          target = group;
          cursor = 0;
          get("group").value = group;
          get("messages").replaceChildren();
        }
        cursor = data.cursor;
        render(data.agents);
        append(data.events);
        if (!online) feedback("代理组已载入。");
        online = true;
      }
    } catch (error) {
      if (watch === version) feedback(error.message);
      return;
    }
    await new Promise((done) => {
      pollTimer = setTimeout(done, document.hidden ? 6_000 : 1_200);
    });
  }
}

function loadGroup(value) {
  if (value && value === group) return;
  if (pollTimer) clearTimeout(pollTimer);
  group = value || undefined;
  cursor = 0;
  get("group").value = value ?? "";
  get("messages").replaceChildren();
  get("changes").hidden = true;
  render([]);
  feedback(value ? "正在载入代理组…" : "正在查找最近代理组…");
  void poll(group, ++watch);
}

get("recent-groups").addEventListener("change", (event) => {
  const value = event.target.value;
  if (value) loadGroup(value);
});
get("group-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = get("group").value.trim();
  if (value === group) group = undefined;
  loadGroup(value);
});
get("agent").addEventListener("change", showQuestion);
get("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const agent = selected();
  if (!agent) return;
  const text = get("text").value.trim();
  if (!text) return;
  const args = { group_id: group, agent_id: agent.agent_id };
  try {
    const followup = event.submitter?.dataset.mode === "followup";
    await call(followup ? "followup" : "send", {
      ...args, ...(followup ? { task: text } : { text, reply_to: agent.question?.id }),
    });
    if (get("text").value.trim() === text) get("text").value = "";
    feedback(followup ? "已续派任务。" : "已发送。");
  } catch (error) {
    feedback(error.message);
  }
});
document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const agent = selected();
    if (!agent) return;
    button.disabled = true;
    try {
      const response = await call(button.dataset.action, { group_id: group, agent_id: agent.agent_id });
      if (button.dataset.action === "changes") {
        const details = get("changes");
        details.hidden = false;
        details.open = true;
        get("diff").textContent = [
          response.diff, response.untracked && `未跟踪文件\n${response.untracked}`,
          response.diff_truncated && "输出过长，请按文件调用 codex_changes。",
        ].filter(Boolean).join("\n\n") || "没有改动。";
      }
      feedback("操作已返回。");
    } catch (error) {
      feedback(error.message);
    } finally {
      showQuestion();
    }
  });
});

app.ontoolinput = ({ arguments: args }) => { if (args?.group_id) loadGroup(args.group_id); };
app.ontoolresult = (result) => {
  const id = result.structuredContent?.group_id;
  if (id) loadGroup(id);
};
app.onhostcontextchanged = (ctx) => applyTheme(ctx);
render([]);
app.connect()
  .then(() => {
    applyTheme(app.getHostContext());
    if (!group) loadGroup("");
  })
  .catch((error) => feedback(error.message));
