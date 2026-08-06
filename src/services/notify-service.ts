import { execFileSync } from "child_process";
import { formatDuration } from "../utils/helpers";

/**
 * 打包完成通知信息
 */
export interface NotifyInfo {
  /** 命令名，如 "gwwy-online" | "patch" */
  command: string;
  /** true=成功，false=失败 */
  success: boolean;
  /** 构建号（尽量带上） */
  buildNumber?: number;
  /** 耗时(ms)，内部用 formatDuration 转成 "12m 30s" */
  duration?: number;
  /** 成功时下载到本地的产物路径 */
  artifactPath?: string;
  /** 失败原因 */
  error?: string;
}

/**
 * NOTIFY 开关是否启用。
 * 未设置 = 默认开；值为 "0"/"false"（不区分大小写）= 关。
 */
function isNotifyEnabled(): boolean {
  const raw = process.env.NOTIFY;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return v !== "0" && v !== "false";
}

/**
 * AppleScript 字符串转义：\ → \\、 " → \"
 */
function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 拼装 osascript 脚本（导出以便将来单测）。
 */
export function buildAppleScript(
  title: string,
  message: string,
  sound: string
): string {
  return `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "${sound}"`;
}

/**
 * 拼正文：各字段用中文分号 ； 连接成单行
 * （macOS 通知正文不渲染换行）。
 */
function buildMessage(info: NotifyInfo): string {
  const parts: string[] = [];
  if (info.buildNumber !== undefined) parts.push(`构建 #${info.buildNumber}`);
  if (info.duration !== undefined) parts.push(`耗时 ${formatDuration(info.duration)}`);
  if (info.success && info.artifactPath) parts.push(`产物 ${info.artifactPath}`);
  if (!info.success && info.error) parts.push(`原因 ${info.error}`);
  return parts.join("；");
}

/**
 * 发送 macOS 系统通知。
 * - NOTIFY 未关闭 且平台为 darwin 时才发送；
 * - 调用失败仅 console.warn，不影响主流程退出码。
 */
export function notify(info: NotifyInfo): void {
  if (!isNotifyEnabled()) return;
  if (process.platform !== "darwin") return;

  const title = `${info.success ? "✅" : "❌"} ${info.command} 打包${info.success ? "完成" : "失败"}`;
  const message = buildMessage(info);
  const sound = info.success ? "Glass" : "Basso";
  const script = buildAppleScript(title, message, sound);

  try {
    execFileSync("osascript", ["-e", script], { stdio: "ignore" });
  } catch (err) {
    console.warn(`⚠️ 发送通知失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
