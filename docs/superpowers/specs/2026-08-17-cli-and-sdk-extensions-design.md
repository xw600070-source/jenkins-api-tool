# 统一 CLI 与 SDK 扩展 设计文档

- 日期：2026-08-17
- 状态：已实现
- 关联命令：新增 `npm run jenkins -- <子命令>`；现有 `patch/pcx/pty-pcx/gwwy/gwwy-online` 全部保留

## 1. 背景与目标

现状问题：

1. **5 个命令各自为政**：每个 npm script 映射一个独立脚本，参数解析、help、错误兜底各写各的；
   新增命令要复制整套样板。
2. **等待期间零可见性**：`maxWaitTime` 最长 1 小时，轮询期间终端完全静默，
   不知道构建卡在哪一步。Jenkins 的 `progressiveText` API 支持按字节偏移增量拉日志，可以边等边看。
3. **SDK 缺常用运维方法**：没有 `stopBuild`（误触构建无法一键停止）、`listJobs`、`getQueue`、`retryBuild`。
4. **`--project` 要背文件名**：`project/` 下有哪些版本清单只能靠记忆或 ls。
5. **零测试**：重试逻辑、URL 拼装等纯逻辑完全靠手测。

**目标**：一个统一 CLI 入口收敛全部命令；SDK 补齐运维方法与日志流式输出；
`--project` 支持交互式选择；建立 vitest 测试基建。

## 2. 需求

| # | 需求 | 说明 |
|---|------|------|
| R1 | 工作流实现迁入 `src/workflows/` | 业务逻辑（patch/pcx/pty-pcx/gwwy/gwwy-online）搬到 `src/workflows/*.ts`，导出 `runXxxWorkflow(argv)` 与 `parseXxxArgs(argv)`；`examples/*.ts` 变为薄封装（保持 npm script 与文件名不变） |
| R2 | 统一 CLI：`npm run jenkins -- <cmd>` | 子命令路由 + `help`；打包类子命令转发到 `src/workflows/`；运维类子命令（`jobs`/`queue`/`stop`/`retry`）直接调 SDK 新方法 |
| R3 | `patch` 缺 `--project` 时交互式选择 | 列出 `project/` 目录文件、数字选择（readline，零依赖）；非 TTY 环境（管道/CI）仍按原逻辑报错退出 |
| R4 | SDK 新方法 | `stopBuild` / `retryBuild` / `listJobs` / `getQueue` + 配套类型，从 `src/index.ts` 导出 |
| R5 | 构建日志流式输出 | SDK 新增 `getProgressiveConsoleText()`；`BuildOptions` 新增 `streamLogs`；`waitForCompletion` 轮询时增量打印日志；`gwwy-online` / `patch` / `pcx` 默认开启 |
| R6 | vitest 测试基建 | devDependency + `npm test`；覆盖 helpers / notify / config / download 重试 / build-service 轮询与回避重试 / status-service 解析 / 各工作流参数解析 |

## 3. 非目标（约束）

- **零新增运行时依赖**：不引 commander/yargs/inquirer，CLI 路由与交互选择手写（延续本项目极简依赖风格）；vitest 仅作 devDependency。
- **`--branch` 不做交互选择**：需要本地有对应仓库才能列出远程分支，本期不做，保持必填（gwwy 本地版保持默认值）。
- **通知不做多通道**：企业微信 / 钉钉 webhook 不在本期。
- **不做 jobs 目录树递归浏览**：`listJobs` 只列一层（根或指定 folder）。

## 4. 架构

```
npm run jenkins -- <cmd>              npm run patch / gwwy-online / ...
        │                                      │
        ▼                                      ▼
src/cli/index.ts（路由）              examples/*.ts（薄封装，一行调用）
        │                                      │
        ├── patch / pcx / pty-pcx ────────────▶ src/workflows/patch.ts ...
        ├── gwwy / gwwy-online ───────────────▶ src/workflows/gwwy-*.ts
        │                                        │ 使用 src/workflow/*（公共层，见配套文档）
        ├── jobs / queue ───────────▶ JenkinsClient.listJobs / getQueue   （SDK 新方法）
        └── stop / retry ───────────▶ JenkinsClient.stopBuild / retryBuild
```

## 5. 详细设计

### 5.1 工作流迁移（R1）

| 新文件 | 导出 | 说明 |
|--------|------|------|
| `src/workflows/patch.ts` | `parsePatchArgs(argv)`（导出以便测试）、`patchCommand(argv): void` | 现有 `examples/build-patch-workflow.ts` 逻辑整体迁入，含 `runWorkflow({ command: 'patch' })` 兜底 |
| `src/workflows/pcx.ts` | `pcxCommand(argv): void` | 原 02 逻辑 |
| `src/workflows/pty-pcx.ts` | `ptyPcxCommand(argv): void` | 原 01 逻辑 |
| `src/workflows/gwwy-local.ts` | `parseGwwyArgs(argv)`、`gwwyCommand(argv): void` | 原 03 逻辑 + `--branch` |
| `src/workflows/gwwy-online.ts` | `parseGwwyOnlineArgs(argv)`、`gwwyOnlineCommand(argv): void` | 原 04 逻辑 |

`examples/*.ts` 统一变成：

```ts
import { patchCommand } from '../src/workflows/patch';
patchCommand(process.argv.slice(2));
```

### 5.2 CLI 路由（R2）

`src/cli/index.ts`，新增 npm script：`"jenkins": "tsx src/cli/index.ts"`。

| 子命令 | 转发目标 | 参数 |
|--------|----------|------|
| `patch` | `patchCommand` | `--project`(可省，触发交互选择) `--module` |
| `pcx` / `pty-pcx` | 对应 workflow | 无 |
| `gwwy` | `gwwyCommand` | `--branch`(默认值同重构后常量) |
| `gwwy-online` | `gwwyOnlineCommand` | `--branch` `--head` |
| `jobs` | `client.listJobs(folder?)` | `[folder]` 位置参数（如 `web`），可选；打印 name / 状态 / url 表格 |
| `queue` | `client.getQueue()` | 无；打印排队项 id / 任务 / 原因 |
| `stop` | `client.stopBuild(job, n)` | `<jobName> <buildNumber>`；执行前 `y/n` 确认 |
| `retry` | `client.retryBuild(job, n)` | `<jobName> <buildNumber>` |
| `help` / 无参数 / 未知命令 | 打印帮助（子命令列表 + 示例），未知命令退出码 1 | |

路由实现即一个 `switch (cmd)`，不做框架。`jobs/queue/stop/retry` 共用 `createClientFromEnv + precheckAuth`。

### 5.3 交互式项目选择（R3）

`src/workflows/interactive.ts`：

```ts
/** 列出 project/ 目录下的清单文件让用户选择；返回文件名。非 TTY 或目录为空时抛错 */
export async function pickProjectFile(dir: string): Promise<string>;
```

- 过滤：仅普通文件，忽略 `.DS_Store` / `.` 开头隐藏文件。
- 交互：编号列表 + `readline/promises` 提问，回车默认第 1 项；输入非法序号重新提问（最多 3 次）。
- `patchCommand` 里 `--project` 未传时：TTY → 走选择器；非 TTY → 保持现有"缺少必传参数"报错（退出码 1）。
- `pickProjectFile` 通过参数注入目录与输入流（`readline` interface 可替换），便于单测。

### 5.4 SDK 新方法（R4）

类型（`src/types/index.ts`）：

```ts
export interface JobInfo { name: string; url: string; color: string; }
export interface QueueItemInfo {
  id: number; why?: string; taskName?: string; taskUrl?: string; buildNumber?: number; queuedSince?: number;
}
```

`JenkinsClient` 方法（均走既有 `HttpClient`，POST 类默认先 `initCrumb`，可 `crumbIssuer:false` 关闭）：

| 方法 | HTTP | 说明 |
|------|------|------|
| `listJobs(folder?: string): Promise<JobInfo[]>` | `GET /api/json?tree=jobs[name,url,color]`（folder 时 `/job/<folder>/api/json?...`） | 列一层 job；`color` 原样返回（blue=成功红=失败带 `_anime` 后缀=进行中），README 注明含义 |
| `getQueue(): Promise<QueueItemInfo[]>` | `GET /queue/api/json` | `items[].task.name` → taskName；`executable.number` → buildNumber |
| `stopBuild(jobName, buildNumber, opts?): Promise<void>` | `POST /job/<job>/<n>/stop` | 404 → JobNotFoundError |
| `retryBuild(jobName, buildNumber, opts?): Promise<BuildTriggerResult>` | `POST /job/<job>/<n>/retry` | 从 Location 头提取 queueId（复用 BuildService.extractQueueId 的逻辑） |

实现落在 `BuildService`（stop/retry）与 `StatusService`（jobs/queue），`JenkinsClient` 薄封装，与现有分层一致。

### 5.5 构建日志流式输出（R5）

**HttpClient** 新增（现有 `get()` 只返回 data，拿不到响应头）：

```ts
async getFull<T>(urlPath: string, params?: Record<string, any>): Promise<{ data: T; headers: Record<string, string> }>;
```

**JenkinsClient** 新增：

```ts
async getProgressiveConsoleText(jobName: string, buildNumber: number, start = 0)
  : Promise<{ text: string; textSize: number; moreData: boolean }>;
// GET /job/<job>/<n>/progressiveText?start=<start>
// text 为增量内容；textSize 取响应头 x-text-size；moreData 取 x-more-data === 'true'
```

**BuildOptions** 新增 `streamLogs?: boolean`（默认 false）。`BuildService.waitForCompletion` 在拿到
buildNumber 后的每次轮询循环里：若 streamLogs 开启，先拉一次 progressiveText，把增量直接
`process.stdout.write` 出来（前缀保持原样，不套 logger 前缀），再查状态、sleep。流式拉取失败
（如旧版 Jenkins 无此端点返回 404）只 warn 一次并自动停用，不影响状态轮询。

**工作流接入**：`patch` / `pcx` / `gwwy-online` 触发构建时传 `streamLogs: true`；
`pty-pcx` / `gwwy`（本地）不开。README 补充说明输出样式。

### 5.6 测试基建与用例（R6）

- devDependency：`vitest`；scripts：`"test": "vitest run"`、`"test:watch": "vitest"`。
- 测试文件与源码同目录（`*.test.ts`），不进 tsup 构建入口。
- 依赖注入点利用现有构造函数（`BuildService(httpClient, statusService)`），HTTP 层用 fake 对象 / `vi.mock('axios')`，**不发真实请求**。

| 测试文件 | 覆盖 |
|----------|------|
| `src/utils/helpers.test.ts` | formatDuration / formatFileSize / stripTrailingSlash / escapeRegExp 边界 |
| `src/services/notify-service.test.ts` | buildAppleScript 转义、正文拼装（缺字段省略）、`NOTIFY=0` 与非 darwin 跳过（spy execFileSync） |
| `src/config/index.test.ts` | loadConfig 环境变量映射（stub `process.env` + `vi.resetModules`） |
| `src/workflow/download.test.ts` | mock axios：成功+进度回调；网络错误重试后成功；content-length 不符触发重试；重试耗尽抛 NetworkError；.part 重命名 |
| `src/services/build-service.test.ts` | waitForCompletion：排队→启动→成功；FAILURE 抛 BuildFailedError；ETIMEDOUT 回避重试 N 次后恢复；超总时长抛 TimeoutError；streamLogs 增量打印（spy stdout） |
| `src/services/status-service.test.ts` | getStatus 解析（状态映射 / artifacts / causes / parameters） |
| `src/workflows/patch.test.ts` | parsePatchArgs：默认 module、缺 --project 报错 |
| `src/workflows/gwwy-online.test.ts` | parseGwwyOnlineArgs：默认 head、缺 --branch 报错 |

### 5.7 帮助输出样式

```
用法: npm run jenkins -- <子命令> [参数]

打包工作流:
  patch <flags>        灵活模块打包（--project 可省略进入交互选择）
  pcx                  固定打包 pcx 模块补丁包
  pty-pcx              pty-pcx 完整打包（构建+下载+解压+重压缩）
  gwwy [--branch x]    gwwy uniapp 本地构建压缩
  gwwy-online <flags>  gwwy uniapp 线上打包

Jenkins 运维:
  jobs [folder]        列出 job
  queue                查看构建队列
  stop <job> <n>       停止构建（有确认）
  retry <job> <n>      重试构建

示例:
  npm run jenkins -- patch --project vOrange-gwzc-530 --module pcx,home
  npm run jenkins -- gwwy-online --branch Feature_xxx
  npm run jenkins -- stop web/job/gwwy-uniapp 123
```

## 6. 测试策略

- `npm run type-check` 与 `npm test` 全绿（不联网）。
- CLI 手动验证：`npm run jenkins`（无参数 → help）；`npm run jenkins -- queue`（真实环境由使用者在内网验证，本期开发过程中不触发真实 Jenkins 构建）；`npm run patch`（无 --project、TTY 下出现选择列表，Ctrl+C 可退出）。
- 流式日志在真实环境的观感由使用者下次打包时确认，端点 404 时自动降级不影响主流程。

## 7. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/workflows/*.ts`（5 个 + interactive.ts） | 新增：工作流实现迁入 + 交互选择 |
| `examples/*.ts`（5 个） | 改为薄封装 |
| `src/cli/index.ts` | 新增：子命令路由 + help |
| `src/types/index.ts` | 新增 JobInfo / QueueItemInfo；BuildOptions.streamLogs |
| `src/services/build-service.ts` | stopBuild / retryBuild / streamLogs 轮询 |
| `src/services/status-service.ts` | listJobs / getQueue |
| `src/services/http-client.ts` | getFull()（带响应头） |
| `src/client/jenkins-client.ts` | 新方法薄封装 + getProgressiveConsoleText |
| `src/index.ts` | 导出新类型与方法 |
| `package.json` | `jenkins` script、vitest devDep、`test` scripts |
| `README.md` | CLI 用法、新 SDK 方法、流式日志、测试说明 |
| `docs/03-项目结构.md` | 补 workflow / workflows / cli 目录说明 |
| `*.test.ts`（8 个） | 新增：见 5.6 |
