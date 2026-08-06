# 打包完成提醒功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `gwwy-online` 与 `patch` 两个打包命令在结束（成功或失败）时弹出 macOS 系统通知，离开终端也能第一时间知道结果。

**Architecture:** 新增独立模块 `src/services/notify-service.ts`，导出纯函数式的 `notify(info)`；内部完成开关读取、平台判断、AppleScript 转义与拼装、`osascript` 调用。两个 example 脚本各自在成功 / 失败处调用它。不侵入 `JenkinsClient` 核心。

**Tech Stack:** TypeScript（ESM）、Node.js `child_process.execFileSync`、macOS `osascript`、复用 `src/utils/helpers.ts` 的 `formatDuration`。

## Global Constraints

（取自 spec，每个 task 隐含遵循）

- **零额外依赖**：只用 `child_process` + `osascript` + 已有 `formatDuration`，不引入新 npm 包。
- **仅 darwin 生效**：`process.platform !== "darwin"` 时静默 return。
- **NOTIFY 开关默认开**：未设置=开；值为 `0` / `false`（不区分大小写）=关。
- **不侵入 SDK 核心**：通知逻辑只存在于 `notify-service.ts` 与 example 脚本，`JenkinsClient` 不变。
- **通知失败不影响主流程**：`osascript` 调用包在 `try/catch`，失败仅 `console.warn`。
- **成败区分**：标题前缀 `✅`/`❌` + 提示音 `Glass`/`Basso`；不改标题颜色（系统不支持）。
- **不引入测试框架**：项目无 vitest/jest；验证用 `npm run type-check` + 手动清单。

## File Structure

| 文件 | 责任 | 改动 |
|------|------|------|
| `src/services/notify-service.ts` | 通知模块：`NotifyInfo` 接口、`notify()`、开关/平台判断、AppleScript 转义与拼装 | 新增 |
| `src/index.ts` | SDK 统一再导出 | 追加导出 `notify`、`NotifyInfo` |
| `examples/04-build-gwwy-uniapp-online.ts` | gwwy-online 工作流 | 成功 + 失败两处接入 |
| `examples/build-patch-workflow.ts` | patch 工作流 | 成功接入 + 失败 `.catch` 接入 |
| `.env.example` | 环境变量示例 | 补 `NOTIFY` 说明 |
| `README.md` | 使用文档 | 两个命令段落各补一句提醒说明 |

每个文件单一职责；`notify-service.ts` 内部把"纯逻辑"（转义、拼装、开关）与"副作用"（`execFileSync`）分开，便于将来加测试。

---

## Task 1: 新建 notify-service 模块并再导出

**Files:**
- Create: `src/services/notify-service.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `formatDuration(ms: number): string` from `src/utils/helpers.ts`（已存在）
- Produces: `notify(info: NotifyInfo): void`、`NotifyInfo`、`buildAppleScript(title, message, sound): string`

- [ ] **Step 1: 创建 `src/services/notify-service.ts`，写入完整实现**

```ts
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
```

- [ ] **Step 2: 在 `src/index.ts` 追加再导出**

在文件末尾（`bandzip-service` 导出之后）追加：

```ts
// Notify service
export { notify, buildAppleScript } from './services/notify-service';
export type { NotifyInfo } from './services/notify-service';
```

- [ ] **Step 3: type-check 验证**

Run: `npm run type-check`
Expected: 无错误退出（tsc --noEmit 通过）。

- [ ] **Step 4: 纯函数一次性自检（确认转义/拼装正确，不弹窗）**

Run（一行命令，验证 buildAppleScript 对含 `"` 的内容正确转义）:

```bash
npx tsx -e "import {buildAppleScript} from './src/services/notify-service'; console.log(buildAppleScript('✅ test 打包完成', '构建 #42；产物 a\"b.zip', 'Glass'));"
```

Expected: 输出形如
`display notification "构建 #42；产物 a\"b.zip" with title "✅ test 打包完成" sound name "Glass"`
即正文里的 `"` 已转义为 `\"`。

- [ ] **Step 5: commit**

```bash
git add src/services/notify-service.ts src/index.ts
git commit -m "新增打包完成通知模块 notify-service（macOS 系统通知 + NOTIFY 开关）"
```

---

## Task 2: 接入 gwwy-online（成功 + 失败）

**Files:**
- Modify: `examples/04-build-gwwy-uniapp-online.ts`

**Interfaces:**
- Consumes: `notify(info: NotifyInfo)` from Task 1；`BuildFailedError.buildNumber`、`BuildFailedError.message`、`TimeoutError.message`、`BuildCompleteResult.buildNumber/duration`（均已存在）。

- [ ] **Step 1: 引入 notify**

把第 2 行 import：

```ts
import { JenkinsClient, LogLevel, BuildFailedError, TimeoutError } from "../src";
```

改为：

```ts
import { JenkinsClient, LogLevel, BuildFailedError, TimeoutError, notify } from "../src";
```

- [ ] **Step 2: 成功路径接入**

在「已下载」日志之后（即 `console.log(\`  ✅ 已下载: ${outputPath}\`);` 这一行之后、`} else {` 之前）插入通知调用：

```ts
        notify({
          command: "gwwy-online",
          success: true,
          buildNumber: result.buildNumber,
          duration: result.duration,
          artifactPath: outputPath,
        });
```

（`result`、`outputPath` 均在该作用域内可见。）

- [ ] **Step 3: 失败路径接入**

把 `catch` 块：

```ts
  } catch (error) {
    if (error instanceof BuildFailedError) {
      console.error(`❌ 构建失败: #${error.buildNumber}`);
    } else if (error instanceof TimeoutError) {
      console.error(`❌ 构建超时: ${error.message}`);
    } else {
      throw error;
    }
  }
```

改为（在每个分支补 `notify`，兜底分支通知后再 throw）：

```ts
  } catch (error) {
    if (error instanceof BuildFailedError) {
      console.error(`❌ 构建失败: #${error.buildNumber}`);
      notify({
        command: "gwwy-online",
        success: false,
        buildNumber: error.buildNumber,
        error: error.message,
      });
    } else if (error instanceof TimeoutError) {
      console.error(`❌ 构建超时: ${error.message}`);
      notify({
        command: "gwwy-online",
        success: false,
        error: error.message,
      });
    } else {
      notify({
        command: "gwwy-online",
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
```

- [ ] **Step 4: type-check 验证**

Run: `npm run type-check`
Expected: 通过。

- [ ] **Step 5: commit**

```bash
git add examples/04-build-gwwy-uniapp-online.ts
git commit -m "gwwy-online 打包结束接入系统通知（成功/失败）"
```

---

## Task 3: 接入 patch（成功 + 失败）

**Files:**
- Modify: `examples/build-patch-workflow.ts`

**Interfaces:**
- Consumes: `notify(info: NotifyInfo)` from Task 1；`BuildCompleteResult.buildNumber/duration`（已存在）。

- [ ] **Step 1: 引入 notify**

把第 2 行 import：

```ts
import { JenkinsClient, LogLevel } from "../src";
```

改为：

```ts
import { JenkinsClient, LogLevel, notify } from "../src";
```

- [ ] **Step 2: 成功路径接入**

在「Downloaded」日志之后（`console.log(\`  Downloaded: ${outputPath}\`);` 这一行之后）插入：

```ts
          notify({
            command: "patch",
            success: true,
            buildNumber: patchResult.buildNumber,
            duration: patchResult.duration,
            artifactPath: outputPath,
          });
```

（`patchResult`、`outputPath` 均在 `if ("buildNumber" in patchResult)` 块作用域内可见。）

- [ ] **Step 3: 失败路径接入**

把文件结尾：

```ts
main().catch(console.error);
```

改为：

```ts
main().catch((error) => {
  notify({
    command: "patch",
    success: false,
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(error);
});
```

- [ ] **Step 4: type-check 验证**

Run: `npm run type-check`
Expected: 通过。

- [ ] **Step 5: commit**

```bash
git add examples/build-patch-workflow.ts
git commit -m "patch 打包结束接入系统通知（成功/失败）"
```

---

## Task 4: 文档（.env.example + README）

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: `.env.example` 补 NOTIFY 说明**

在文件末尾追加：

```dotenv

# 打包完成提醒 (macOS 系统通知)：默认开；设为 0 或 false 关闭
# NOTIFY=0
```

- [ ] **Step 2: README 的 patch 段落补一句**

在 [README.md](README.md) `### patch 命令（灵活模块打包）` 段落、`**流程**：...` 那行之后，新增一行：

```markdown

> 打包结束会弹 macOS 系统通知（成功/失败）。临时关闭：`NOTIFY=0 npm run patch -- ...`。
```

- [ ] **Step 3: README 的 gwwy-online 段落补一句**

在 `### gwwy-online 命令（线上打包）` 段落、`**流程**：...` 那行之后，新增一行：

```markdown

> 打包结束会弹 macOS 系统通知（成功/失败）。临时关闭：`NOTIFY=0 npm run gwwy-online -- ...`。
```

- [ ] **Step 4: commit**

```bash
git add .env.example README.md
git commit -m "文档补充打包完成提醒说明（NOTIFY 开关）"
```

---

## 端到端手动验证（全部 task 完成后，需可用的 Jenkins 环境）

参考 spec 第 6 节，按需执行：

1. **成功**：`npm run gwwy-online -- --branch <真实分支>` → 下载完成后收到 `✅` 通知，提示音 `Glass`，正文含 `构建 #..；耗时 ..；产物 downloads/...zip`。
2. **成功（patch）**：`npm run patch -- --project vOrange-gwzc-530` → 收到 `✅ patch 打包完成` 通知。
3. **失败**：用错误分支 / 错误参数触发 → 收到 `❌` 通知，提示音 `Basso`，正文含 `原因 ..`。
4. **开关关闭**：`NOTIFY=0 npm run gwwy-online -- --branch <分支>` → 全程无通知。
5. **类型回归**：`npm run type-check` 全绿。

## Self-Review

- **Spec 覆盖**：R1（osascript 系统通知）→ Task1；R2（成功失败都提醒）→ Task2/3 成功+失败分支；R3（仅 gwwy-online+patch）→ Task2/3；R4（NOTIFY 默认开）→ Task1 `isNotifyEnabled` + Task4 文档。非目标（不侵入核心、不改标题颜色、仅 darwin、不推送手机）→ Global Constraints + Task1 实现。✓ 无遗漏。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码。✓
- **类型一致性**：`notify(info: NotifyInfo)` 在 Task1 定义，Task2/3 调用签名一致（command/success/buildNumber?/duration?/artifactPath?/error?）；`buildAppleScript(title,message,sound)` 签名前后一致；`patchResult.duration`、`result.duration` 均为 `BuildCompleteResult` 已有字段。✓
