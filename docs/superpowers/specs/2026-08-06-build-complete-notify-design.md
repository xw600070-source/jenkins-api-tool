# 打包完成提醒功能 设计文档

- 日期：2026-08-06
- 状态：待实现
- 关联命令：`npm run gwwy-online`、`npm run patch`

## 1. 背景与目标

`gwwy-online`（线上 uniapp 打包）和 `patch`（灵活模块打包）两个命令都会等待 Jenkins 构建完成并下载产物，整个流程通常耗时十几分钟到一小时。当前流程结束后只在终端打印 `console.log`，用户一旦离开终端窗口（切去干别的事、开会、吃饭）就感知不到"包已经打完了"，往往要回来逐行翻日志确认。

**目标**：这两个命令在打包结束（无论成功还是失败）时，主动弹出一个 macOS 系统通知，让用户即使不看终端也能第一时间知道结果。

## 2. 需求

| # | 需求 | 说明 |
|---|------|------|
| R1 | 通知方式：macOS 系统通知 | 桌面弹窗 + 提示音，使用系统自带 `osascript`，零额外依赖 |
| R2 | 成功与失败都提醒 | 失败时用 `❌` 图标 + 低沉提示音，比成功更醒目 |
| R3 | 仅覆盖线上耗时命令 | 只接入 `gwwy-online` 与 `patch`；`pcx`、`gwwy`（本地、用户通常在盯着）暂不加 |
| R4 | 环境变量开关，默认开 | `NOTIFY=0`（或 `false`，不区分大小写）临时关闭；不设置时默认提醒 |

## 3. 非目标（约束）

- **不侵入 SDK 核心**：通知是本地 CLI 行为，`JenkinsClient` 不应依赖本地通知能力，因此不把通知塞进 `build()` / `getStatus()` 等核心方法。
- **不支持自定义标题颜色**：macOS 原生 `display notification` 不支持自定义标题颜色；改用图标前缀（✅/❌）+ 不同提示音区分成败。
- **仅 macOS（darwin）生效**：其他平台静默跳过（工具主要在 mac 跑，做兜底即可）。
- **不推送手机**：本期不做钉钉 / 企业微信 webhook，如后续需要可再扩展为多通道。

## 4. 架构

新增独立通知模块 `src/services/notify-service.ts`，与现有 `download-service.ts` / `bandzip-service.ts` 同级。两个 example 脚本各自在结果处调用它。

```
examples/04-build-gwwy-uniapp-online.ts ──┐
                                          ├──▶ src/services/notify-service.ts ──▶ osascript(系统通知)
examples/build-patch-workflow.ts ─────────┘
```

复用既有 `src/utils/helpers.ts` 的 `formatDuration(ms)`，不在 notify-service 内重复实现耗时格式化。

从 `src/index.ts` 再导出 `notify` 与 `NotifyInfo`，与现有 services 导出风格一致。

## 5. 详细设计

### 5.1 notify-service 接口

```ts
// src/services/notify-service.ts
export interface NotifyInfo {
  command: string;        // 命令名，如 "gwwy-online" | "patch"
  success: boolean;       // true=成功，false=失败
  buildNumber?: number;   // 构建号（成功/失败时尽量带上）
  duration?: number;      // 耗时(ms)，内部用 formatDuration 转成 "12m 30s"
  artifactPath?: string;  // 成功时下载到本地的产物路径
  error?: string;         // 失败原因（取自 error.message 等）
}

export function notify(info: NotifyInfo): void;
```

所有可选字段由各脚本"尽力填写"，缺省字段自动从正文里省略。

### 5.2 notify 行为

1. **读开关**：`process.env.NOTIFY`。值为 `"0"` / `"false"`（不区分大小写）→ 直接 return，不发；未设置或其他值 → 继续。
2. **平台判断**：`process.platform !== "darwin"` → 直接 return。
3. **拼标题**：
   - 成功：`✅ ${command} 打包完成`
   - 失败：`❌ ${command} 打包失败`
4. **拼正文**：按顺序收集 `构建 #${buildNumber}`、`耗时 ${formatDuration(duration)}`、`产物 ${artifactPath}`（成功）或 `原因 ${error}`（失败），用中文分号 `；` 连接成单行。（macOS 通知正文不渲染换行，故用 `；` 而非 `\n`。）
5. **选提示音**：成功 `Glass`，失败 `Basso`。
6. **转义与调用**：
   - 对标题 / 正文做 AppleScript 字符串转义：`\` → `\\`、`"` → `\"`。
   - 用 `execFileSync('osascript', ['-e', script], { stdio: 'ignore' })` 直传参数数组，**不经 shell**，规避引号 / 单引号注入。
   - `script` 形如：`display notification "<正文>" with title "<标题>" sound name "Glass"`。
   - `notify` 同步执行即可（只在流程末尾调用一次，阻塞可忽略）；osascript 调用失败时 `try/catch` 吞掉错误并 `console.warn`，避免通知异常影响主流程退出码。

### 5.3 接入点

**`examples/04-build-gwwy-uniapp-online.ts`**

- 成功路径：在「已下载: ${outputPath}」之后调用
  `notify({ command: "gwwy-online", success: true, buildNumber: result.buildNumber, duration: result.duration, artifactPath: outputPath })`。
- 失败路径：在现有 `catch` 的 `BuildFailedError` / `TimeoutError` / 兜底分支里调用
  `notify({ command: "gwwy-online", success: false, buildNumber: error.buildNumber, error: error.message })`。
- 未提取到下载链接（`⚠️ 控制台日志中未找到下载链接`）这种情况不算成功也不抛错，本次**不发**通知（属异常中间态，主流程仍正常退出）。

**`examples/build-patch-workflow.ts`**

- 成功路径：在 `Downloaded: ${outputPath}` 之后调用
  `notify({ command: "patch", success: true, buildNumber: patchResult.buildNumber, duration: patchResult.duration, artifactPath: outputPath })`。
- 失败路径：当前结尾为 `main().catch(console.error)`，改为
  ```ts
  main().catch((error) => {
    notify({ command: "patch", success: false, error: error instanceof Error ? error.message : String(error) });
    console.error(error);
  });
  ```
- 同理，"未找到下载链接 / 未找到 zip 包"这类 warning 不发通知。

### 5.4 开关用法

```bash
# 默认：结束自动提醒
npm run gwwy-online -- --branch Feature_xxx

# 临时关闭提醒
NOTIFY=0 npm run patch -- --project vOrange-gwzc-530
```

在 `.env.example` 末尾补一段注释，说明 `NOTIFY` 的取值与默认行为。

## 6. 测试策略

> 说明：本项目当前**未引入测试框架**（package.json 无 vitest / jest，无 test 脚本）。本功能以**手动验证**为主；如后续引入 vitest，可按下述纯函数用例补自动化测试，不作为本期交付硬性要求。

**手动验证清单：**

- 成功路径：跑 `gwwy-online` / `patch`，构建并下载成功 → 收到 `✅` 通知，提示音 `Glass`，正文含构建号 / 耗时 / 产物路径。
- 失败路径：用错误分支 / 错误参数人为触发失败 → 收到 `❌` 通知，提示音 `Basso`，正文含失败原因。
- 开关：`NOTIFY=0 npm run ...` → 全程无通知；不带 `NOTIFY` → 正常通知。
- 平台兜底：在非 mac 环境运行不报错（仅静默跳过）—— 可选验证。

**可自动化的纯函数用例（引入 vitest 后补）：**

- 开关解析：`NOTIFY=0` / `false` / `FALSE` 跳过；未设置默认开；其他值（如 `1`）视为开。
- 平台判断：`process.platform` 非 `darwin` 跳过。
- 转义 / 脚本拼装：内容含 `"`、`\` 时正确转义；`buildAppleScript(title, message, sound)` 输出符合预期。
- 正文拼装：字段缺失时正确省略、字段齐全时按 `；` 连接。
- 实际 `osascript` 调用以 spy 断言"被以正确参数调用一次"，不真正弹窗。

## 7. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/services/notify-service.ts` | 新增：接口 + `notify()` + 内部转义/拼装纯函数 |
| `src/index.ts` | 新增再导出 `notify`、`NotifyInfo` |
| `examples/04-build-gwwy-uniapp-online.ts` | 成功 + 失败两处接入 `notify` |
| `examples/build-patch-workflow.ts` | 成功接入 + 失败 `.catch` 接入 |
| `.env.example` | 补 `NOTIFY` 说明 |
| `README.md` | 在两个命令段落各补一句"结束会弹系统通知，`NOTIFY=0` 关闭" |

> 可选（需先引入 vitest，另立基建任务）：`src/services/notify-service.test.ts` —— 第 6 节列出的纯函数用例。
