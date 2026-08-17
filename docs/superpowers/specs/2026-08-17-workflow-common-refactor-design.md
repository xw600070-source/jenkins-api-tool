# 工作流公共化重构与修复 设计文档

- 日期：2026-08-17
- 状态：已实现（实现与《统一 CLI 与 SDK 扩展》合并落地，工作流实现直接迁入 src/workflows/）
- 关联命令：`npm run patch`、`pcx`、`pty-pcx`、`gwwy`、`gwwy-online`

## 1. 背景与问题

5 个打包工作流脚本（`examples/` 下）各自维护了四段几乎相同的样板代码：

| 样板 | 位置 | 行数/次 |
|------|------|--------|
| `new JenkinsClient({...})` 环境变量组装 | 01/02/03/04/patch 各一份 | ~8 行 |
| `verifyAuth()` 预检 + 失败退出 | 04/patch（01/02/03 没做预检） | ~7 行 |
| 从控制台日志正则提取 URL → axios stream 下载到 `downloads/` | 02/04/patch 三份 | ~25 行 |
| 顶层 catch 错误处理 | 各一份，行为不一致 | ~8 行 |

同时存在以下具体问题：

1. **`verifyAuth()` 运算符优先级 bug**（`src/client/jenkins-client.ts:157`）：
   `data.version || data._class ? 'Connected' : undefined` 实际语义是
   `(data.version || data._class) ? 'Connected' : undefined`，真实版本号永远不会显示。
2. **失败退出码为 0**：`patch` 的 `main().catch` 只打印 + 通知、不 `process.exit(1)`；
   `04` 捕获 `BuildFailedError` 后也不再抛出。在 CI / 串联 shell 脚本里会误判为成功。
3. **硬编码散落**：job 名（`web/job/orange-aliyun` 等）与文件服务器地址
   （`http://223.223.178.68:2004`）写死在各脚本里，换环境要改多处。
4. **`src/config/index.ts` 的 `loadConfig()` 无人使用**：它就是为"从环境变量组装客户端配置"而写的，
   但所有 example 都在手写 `process.env.XXX || ''`。
5. **裸 axios stream 下载**：无进度显示、无重试、无大小校验，大包下载失败即整个流程作废。
6. **`npm run gwwy`（03）分支写死**：`TARGET_BRANCH` 是常量，切分支要改代码；线上版 04 已支持 `--branch`。

## 2. 需求

| # | 需求 | 说明 |
|---|------|------|
| R1 | 修复 `verifyAuth` 优先级 bug | 版本号真实显示：`data.version \|\| (data._class ? 'Connected' : undefined)` |
| R2 | 失败退出码统一为非 0 | 所有工作流脚本：任何失败路径 `process.exit(1)`，成功 `exit(0)`（现状是 0，属行为变更，README 注明） |
| R3 | 抽公共层 `src/workflow/` | `createClientFromEnv()`（复用 `loadConfig`）、`precheckAuth()`、`downloadToFile()`（进度 + 重试 + 大小校验）、`runWorkflow()`（统一顶层 catch + 失败通知 + 退出码） |
| R4 | job 名 / 文件服务器集中 | `src/workflow/jobs.ts`：`JOBS` 常量 + `FILE_SERVER_BASE`（可用环境变量 `FILE_SERVER_BASE` 覆盖）+ `DOWNLOADS_DIR` |
| R5 | `gwwy`（03）支持 `--branch` | 不传时保持现有默认分支常量，行为向后兼容 |
| R6 | examples 全部改用公共层 | 5 个脚本瘦身，`npm run xxx` 用法与参数完全不变 |
| R7 | 01/02 保留 | 作为 SDK 用法示例与历史命令保留（`pty-pcx`、`pcx` 仍是有效 npm script），仅重构不删除 |

## 3. 非目标（约束）

- **不删 01/02**：是否淘汰等使用者确认，本期只重构。
- **不改 SDK 核心 API 行为**：`build/getStatus/download/...` 签名与语义不动（R1 的 bug 修复除外）。
- **不做统一 CLI / 交互式选择 / 流式日志 / 测试基建**：见配套设计文档《2026-08-17-cli-and-sdk-extensions-design.md》。
- **不做断点续传**：下载重试是整文件重下，不做 Range 续传。

## 4. 架构

新增 `src/workflow/` 目录，与 `src/services/` 平级，定位是"工作流脚本用的 CLI 层工具"（不进 SDK 导出面，
与 `notify-service` 一样属于本地 CLI 行为，但因其尚未稳定，暂不从 `src/index.ts` 再导出）：

```
examples/*.ts（5 个脚本，瘦身为"解析参数 → 调公共层 + 业务编排"）
      │
      ├──▶ src/workflow/client-factory.ts   createClientFromEnv() / precheckAuth()
      ├──▶ src/workflow/download.ts         downloadToFile()（进度/重试/校验）
      ├──▶ src/workflow/run.ts              runWorkflow()（顶层 catch + notify + 退出码）
      └──▶ src/workflow/jobs.ts             JOBS / FILE_SERVER_BASE / DOWNLOADS_DIR
                │
                └──▶ src/config/index.ts loadConfig()（既有，本期开始真正使用）
```

## 5. 详细设计

### 5.1 `src/workflow/jobs.ts`

```ts
/** Jenkins job 名集中管理（支持多级路径） */
export const JOBS = {
  orangeAliyun: 'web/job/orange-aliyun',
  orangePatch: 'web/job/orange-patch',
  gwwyUniapp: 'web/job/gwwy-uniapp',
  ptyPcx: 'server/job/pex/job/pty-pcx',
} as const;

/** 产物文件服务器根地址，可用环境变量 FILE_SERVER_BASE 覆盖 */
export const FILE_SERVER_BASE = process.env.FILE_SERVER_BASE || 'http://223.223.178.68:2004';

/** 工作流产物统一下载目录 */
export const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
```

URL 提取正则由 `FILE_SERVER_BASE` 动态拼出（新增 `escapeRegExp()` 到 `src/utils/helpers.ts`），
不再把 IP 写死在正则字面量里。

### 5.2 `src/workflow/client-factory.ts`

```ts
/** 从环境变量创建客户端（复用 loadConfig，校验必填项） */
export function createClientFromEnv(): JenkinsClient;
// - url / username 缺失或未配置凭据 → 抛 JenkinsError，提示检查 .env
// - 内部等价于 new JenkinsClient(loadConfig())，失败时给出中文可操作提示

/** 认证预检：成功打印 ✅ 认证成功，失败打印原因并 exit(1) */
export async function precheckAuth(client: JenkinsClient): Promise<void>;
```

### 5.3 `src/workflow/download.ts`

```ts
export interface DownloadToFileOptions {
  /** 网络错误重试次数，默认 3 */
  retries?: number;
  /** 重试间隔(ms)，默认 2000 */
  retryDelayMs?: number;
  /** 进度回调（已下载字节, 总字节|0） */
  onProgress?: (downloaded: number, total: number) => void;
}
export interface DownloadToFileResult {
  outputPath: string;
  size: number;       // 字节
  duration: number;   // ms
}

export async function downloadToFile(
  url: string,
  outputDir: string,
  options?: DownloadToFileOptions
): Promise<DownloadToFileResult>;
```

行为：

1. `mkdirSync(outputDir, { recursive: true })`，文件名取 `path.basename(url 解码后)`。
2. axios stream 下载，写入临时名 `<文件名>.part`，**成功后 rename 成正式名**
   （避免下载中断留下半截文件被误当作成品；重试前也无需手动清理）。
3. 进度：默认在终端打印（同一行 `\r` 刷新），节流至每 1s 一次，格式
   `  下载中 45.2% (12.3 MB / 27.2 MB)`；结束时打印 `  ✅ 已下载: <路径> (<大小>)`。`onProgress` 可替换默认显示。
4. 重试：网络错误 / 流中断 / 大小校验失败 → 等待 `retryDelayMs` 后整文件重下，最多 `retries` 次；耗尽后抛 `NetworkError`。
5. 大小校验：响应含 `content-length` 时，最终字节数不一致视为失败（触发重试逻辑）。

### 5.4 `src/workflow/run.ts`

```ts
export interface RunWorkflowOptions {
  /** 命令名，用于失败通知（notify） */
  command: string;
  main: () => Promise<void>;
}

export function runWorkflow(options: RunWorkflowOptions): void;
```

统一顶层兜底，替代各脚本手写的 `main().catch(...)`：

```
try await main()
catch error:
  notify({ command, success: false, error })   // NOTIFY=0 / 非 darwin 时自动跳过（既有逻辑）
  console.error(❌ <command> 失败: error)
  process.exit(1)
```

成功路径自然结束（exit 0）。**行为变更**：04 原来捕获 `BuildFailedError` / `TimeoutError` 后只打印、
退出码 0；重构后这些错误统一交给 `runWorkflow` 兜底 → 通知 + 退出码 1。各工作流内部不再自行 catch 业务错误。

### 5.5 `verifyAuth` 修复（`src/client/jenkins-client.ts`）

```ts
// 修复前
version: data.version || data._class ? 'Connected' : undefined,
// 修复后
version: data.version || (data._class ? 'Connected' : undefined),
```

### 5.6 各脚本重构要点

| 脚本 | 改动 |
|------|------|
| `build-patch-workflow.ts` | 手写 client/预检/下载 → `createClientFromEnv + precheckAuth + downloadToFile`；job 名/正则 → `JOBS` / `FILE_SERVER_BASE`；顶层 → `runWorkflow({ command: 'patch' })` |
| `04-build-gwwy-uniapp-online.ts` | 同上（command: `gwwy-online`）；去掉内部 try/catch，让 `BuildFailedError`/`TimeoutError` 冒泡到 `runWorkflow` |
| `02-build-pcx-full-workflow.ts` | 同 patch（它是 patch 的固定模块前身，逻辑保留，command: `pcx`）；版本清单路径保持 `examples/vOrange-wl-hxh` 不变 |
| `01-build-pty-pcx-full-workflow.ts` | client → `createClientFromEnv`；顶层 → `runWorkflow`（补上退出码与失败通知，command: `pty-pcx`） |
| `03-build-gwwy-full-workflow.ts` | client → `createClientFromEnv`；新增 `--branch` 参数（默认现有 `TARGET_BRANCH` 常量值），`checkAndSwitchBranch` 等函数改用该值；顶层 → `runWorkflow`（command: `gwwy`） |

### 5.7 退出码矩阵（重构后）

| 结局 | 退出码 | 通知 |
|------|--------|------|
| 工作流完整成功（含下载完成） | 0 | ✅ 成功通知 |
| 构建 FAILED / ABORTED / 超时 / 认证失败 / 下载重试耗尽 / 任何未捕获异常 | 1 | ❌ 失败通知 |
| 未提取到下载链接等 warning（主流程仍正常走完） | 0 | 不发（沿用现状） |

## 6. 测试策略

本期（本文档范围）以 `npm run type-check` + 手动验证为主；`downloadToFile` 的重试 / 校验逻辑、
`runWorkflow` 退出码在配套设计文档的 vitest 基建落地后补自动化测试。

**手动验证清单（不需要真打包）：**

- `npm run patch`（缺 `--project`）→ 打印用法并以退出码 1 结束（`echo $?` 验证）。
- `npm run gwwy-online`（缺 `--branch`）→ 同上。
- 故意配错 `JENKINS_URL` 后 `npm run patch -- --project x` → 认证预检报错、退出码 1、（macOS）弹失败通知。
- `npm run gwwy`（无参数）→ 走默认分支，与重构前行为一致（Windows 环境验证）。

## 7. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/client/jenkins-client.ts` | 修复 `verifyAuth` 优先级 bug（R1） |
| `src/utils/helpers.ts` | 新增 `escapeRegExp()` |
| `src/workflow/jobs.ts` | 新增：JOBS / FILE_SERVER_BASE / DOWNLOADS_DIR |
| `src/workflow/client-factory.ts` | 新增：createClientFromEnv / precheckAuth |
| `src/workflow/download.ts` | 新增：downloadToFile（进度/重试/校验） |
| `src/workflow/run.ts` | 新增：runWorkflow（退出码 + 失败通知） |
| `examples/*.ts`（5 个） | 按 5.6 重构 |
| `.env.example` | 补 `FILE_SERVER_BASE` 可选说明 |
| `README.md` | 命令表补 `gwwy --branch`；注明"失败退出码为 1" |
