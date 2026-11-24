import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { message, record } from "./codex.js";
import type { ApprovalChoice, ApprovalOption } from "./state.js";

const execute = promisify(execFile);
export type Decision = "once" | "session" | "amend" | "declined" | "expired" | "cancelled" | "unavailable";
export type DialogOutcome = { decision: "once" | "declined" | "expired" | "cancelled" | "unavailable"; detail?: string };

export type ApprovalOffer = {
  kind: string;
  summary: string;
  details: Record<string, unknown>;
  options: ApprovalOption[];
};

export type ApprovalHandler = {
  offer?: ApprovalOffer;
  declineReason?: string;
  respond: (choice: ApprovalChoice | "decline") => Record<string, unknown>;
};

export class ApprovalDialogs {
  private next: Promise<unknown> = Promise.resolve();

  constructor(private readonly command?: string) {}

  async ask(details: Record<string, unknown>, timeout: number, cancel: AbortSignal): Promise<DialogOutcome> {
    if (!this.command) return { decision: "unavailable", detail: "approval_dialog not configured" };
    const command = this.command;
    const text = JSON.stringify(details, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
    if (text.length > 256_000) return { decision: "unavailable", detail: "approval details exceed dialog size limit" };
    const show = async (): Promise<DialogOutcome> => {
      if (cancel.aborted) return { decision: "cancelled" };
      const expires = AbortSignal.timeout(timeout * 1_000);
      const signal = AbortSignal.any([expires, cancel]);
      const dialog = execute(command, [
        "--text-info", "--title=Codex 子代理审批", "--width=880", "--height=560",
        "--checkbox=我已查看请求详情，同意这一次操作", "--ok-label=批准一次", "--cancel-label=拒绝",
      ], { signal, maxBuffer: 8_192 });
      const stdin = dialog.child.stdin;
      stdin?.on("error", () => undefined);
      stdin?.end("请核对下面的请求范围。只有勾选确认并点击「批准一次」才会授权。\n\n" + text + "\n");
      try {
        await dialog;
        return signal.aborted ? { decision: cancel.aborted ? "cancelled" : "expired" } : { decision: "once" };
      } catch (error) {
        if (cancel.aborted) return { decision: "cancelled" };
        if (expires.aborted) return { decision: "expired" };
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === 1) return { decision: "declined" };
        const stderr = typeof error === "object" && error !== null && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr.trim().slice(0, 300) : "";
        return {
          decision: "unavailable",
          detail: `dialog exit ${String(code ?? "unknown")}${stderr ? `: ${stderr}` : ""}`,
        };
      }
    };
    const response = this.next.then(show);
    this.next = response.catch(() => undefined);
    return response;
  }
}

function sanitizePermissions(raw: Record<string, unknown>) {
  const granted: Record<string, unknown> = {};
  if (raw.network && typeof raw.network === "object") {
    const net = record(raw.network);
    if (typeof net.enabled === "boolean") granted.network = { enabled: net.enabled };
  }
  if (raw.fileSystem && typeof raw.fileSystem === "object") {
    const fsPerm = record(raw.fileSystem);
    const cleanFs: Record<string, unknown> = {};
    if (Array.isArray(fsPerm.read)) cleanFs.read = fsPerm.read;
    if (Array.isArray(fsPerm.write)) cleanFs.write = fsPerm.write;
    if (typeof fsPerm.globScanMaxDepth === "number") cleanFs.globScanMaxDepth = fsPerm.globScanMaxDepth;
    if (Array.isArray(fsPerm.entries)) cleanFs.entries = fsPerm.entries;
    if (Object.keys(cleanFs).length > 0) granted.fileSystem = cleanFs;
  }
  return granted;
}

export function codexApproval(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  writable: boolean,
  options: { allowReadonlyCommandApproval: boolean; fallbackCwd: string },
): ApprovalHandler | undefined {
  const base = { 原因: message(params.reason) };
  if (method === "item/commandExecution/requestApproval") {
    const network = record(params.networkApprovalContext);
    const destination = message(network.host);
    const command = message(params.command) ?? message(item?.command);
    const directory = message(params.cwd) ?? message(item?.cwd) ?? options.fallbackCwd;
    const available = params.availableDecisions;
    const canAccept = !Array.isArray(available) || available.includes("accept");
    const canAcceptSession = !Array.isArray(available) || available.includes("acceptForSession");
    const execAmendment = Array.isArray(params.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.length > 0
      && params.proposedExecpolicyAmendment.every((entry) => typeof entry === "string")
      ? params.proposedExecpolicyAmendment : undefined;
    const networkAmendments = Array.isArray(params.proposedNetworkPolicyAmendments)
      ? params.proposedNetworkPolicyAmendments.map(record) : [];
    const allowNetworkAmendment = networkAmendments.find((entry) => message(entry.action) === "allow" && message(entry.host));
    const hasAmendment = Boolean(execAmendment || allowNetworkAmendment);

    let declineReason: string | undefined;
    let offer: ApprovalOffer | undefined;
    if (!canAccept) {
      declineReason = "accept_unavailable";
    } else if (destination) {
      const choices: ApprovalOption[] = [{ choice: "once", label: "批准一次" }];
      if (canAcceptSession) choices.push({ choice: "session", label: "本会话放行" });
      if (hasAmendment) choices.push({ choice: "amend", label: "按规则放行" });
      choices.push({ choice: "decline", label: "拒绝" });
      offer = {
        kind: "network",
        summary: `允许访问网络 ${destination}`,
        details: { ...base, 目标: destination, 协议: network.protocol },
        options: choices,
      };
    } else if (!command) {
      declineReason = "missing_command";
    } else if (!writable && !options.allowReadonlyCommandApproval) {
      declineReason = "readonly_command_blocked";
    } else {
      const choices: ApprovalOption[] = [{ choice: "once", label: "批准一次" }];
      if (canAcceptSession) choices.push({ choice: "session", label: "本会话放行" });
      if (hasAmendment) choices.push({ choice: "amend", label: "按规则放行" });
      choices.push({ choice: "decline", label: "拒绝" });
      offer = {
        kind: "command",
        summary: `执行命令: ${command}`,
        details: {
          ...base,
          命令: command,
          工作目录: directory,
          模式: writable ? "worktree" : "read_only",
          ...(params.additionalPermissions ? { 请求权限: params.additionalPermissions } : {}),
        },
        options: choices,
      };
    }
    return {
      offer,
      declineReason,
      respond: (choice) => {
        if (choice === "once") return { decision: "accept" };
        if (choice === "session") return { decision: "acceptForSession" };
        if (choice === "amend") {
          if (execAmendment) return { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: execAmendment } } };
          if (allowNetworkAmendment) {
            return {
              decision: {
                applyNetworkPolicyAmendment: {
                  network_policy_amendment: { host: message(allowNetworkAmendment.host), action: "allow" },
                },
              },
            };
          }
          return { decision: "acceptForSession" };
        }
        return { decision: "decline" };
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const changes = item?.changes;
    let declineReason: string | undefined;
    let offer: ApprovalOffer | undefined;
    if (!writable) {
      declineReason = "readonly_file_change_blocked";
    } else if (!Array.isArray(changes) || changes.length === 0) {
      declineReason = "missing_file_changes";
    } else {
      offer = {
        kind: "file_change",
        summary: `修改 ${changes.length} 个文件`,
        details: { ...base, 额外授权目录: params.grantRoot, 文件改动: changes },
        options: [
          { choice: "once", label: "批准一次" },
          { choice: "session", label: "本会话允许改动" },
          { choice: "decline", label: "拒绝" },
        ],
      };
    }
    return {
      offer,
      declineReason,
      respond: (choice) => {
        if (choice === "once") return { decision: "accept" };
        if (choice === "session" || choice === "amend") return { decision: "acceptForSession" };
        return { decision: "decline" };
      },
    };
  }
  if (method === "item/permissions/requestApproval") {
    const permissions = record(params.permissions);
    const fileSystem = record(permissions.fileSystem);
    const writes = Array.isArray(fileSystem.write) && fileSystem.write.length > 0;
    const writeEntries = Array.isArray(fileSystem.entries) && fileSystem.entries.some((entry) => record(entry).access === "write");
    const granted = sanitizePermissions(permissions);
    let declineReason: string | undefined;
    let offer: ApprovalOffer | undefined;
    if (!writable && (writes || writeEntries)) {
      declineReason = "readonly_write_permission_blocked";
    } else if (Object.keys(granted).length === 0) {
      declineReason = "empty_permissions";
    } else {
      offer = {
        kind: "permissions",
        summary: "申请额外文件系统或网络权限",
        details: { ...base, 工作目录: params.cwd ?? options.fallbackCwd, 本轮请求权限: granted },
        options: [
          { choice: "once", label: "本轮放行" },
          { choice: "session", label: "本会话放行" },
          { choice: "decline", label: "拒绝" },
        ],
      };
    }
    return {
      offer,
      declineReason,
      respond: (choice) => {
        if (choice === "once") return { permissions: granted, scope: "turn" };
        if (choice === "session" || choice === "amend") return { permissions: granted, scope: "session" };
        return { permissions: {}, scope: "turn" };
      },
    };
  }
  return undefined;
}
