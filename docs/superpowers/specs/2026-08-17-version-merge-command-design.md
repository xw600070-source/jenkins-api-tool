# orange-version-merge 版本合并命令 设计文档

- 日期：2026-08-17（2026-08-17 修订：新增 merge/ 默认输入目录）
- 状态：已实现
- 关联命令：新增 `npm run merge` / `npm run jenkins -- merge`

## 1. 背景

Jenkins 任务 `web/job/orange-version-merge`（http://223.223.178.68:2004/jenkins-122/job/web/job/orange-version-merge/）
用于把两份版本清单合并成一份新的 vOrange 清单：上传两个文件 → 合并 → 把结果写到任务 workspace 的
`version-merge/dist/vOrange`。目前只能在 Jenkins 页面手动操作，本命令把它接入 CLI。

通过 Jenkins 只读 API 实测确认的任务行为：

| 项 | 值 |
|----|-----|
| 文件参数 1 | `vOrange`（FileParameterDefinition，vOrange 版本清单） |
| 文件参数 2 | `orangePatchVersion.txt`（FileParameterDefinition，补丁版本文件） |
| 构建耗时 | 约 1 分钟（最近一次 #1019 为 59s） |
| 归档产物 | 无（artifacts 为空） |
| 输出位置 | workspace `version-merge/dist/vOrange` |
| 下载地址 | `${JENKINS_URL}/job/web/job/orange-version-merge/ws/version-merge/dist/vOrange`（**匿名访问 403，必须认证**） |
| 附注 | 任务每次构建会先清空 workspace（[WS-CLEANUP]），构建完成后当前 workspace 即本次结果 |

## 2. 需求

| # | 需求 | 说明 |
|---|------|------|
| R1 | 新命令 `merge` | `npm run merge -- --vorange <文件> --patch <文件>` 或 `npm run jenkins -- merge ...` |
| R2 | 输入文件解析 | 缺省读取 `merge/` 目录下的默认文件（vOrange + orangePatchVersion.txt）；显式参数支持绝对/相对路径，纯文件名先查 `merge/` 再查 `project/`；找不到时报错并列出两个目录的可用文件 |
| R3 | 触发构建并等待完成 | 文件参数上传（FormData），wait:true，轮询 10s，上限 10 分钟，等待期间流式打印构建日志 |
| R4 | 下载合并结果 | 通过 SDK workspace 下载（认证通道）取 `version-merge/dist/vOrange`，保存为 `downloads/vOrange-merge-b<构建号>`（避免多次运行互相覆盖） |
| R5 | 通知与退出码 | 成功/失败弹 macOS 通知；失败退出码 1（runWorkflow 统一兜底） |

## 3. 非目标

- **不修改 Jenkins 任务本身**，只做触发与取件。
- **不自动把结果复制进 `project/`**：只下载到 `downloads/`，由使用者确认后自行放入 `project/`（打印提示）。
- **不做两个文件的本地预合并/校验**：合并逻辑完全以 Jenkins 任务为准。

## 4. 详细设计

### 4.0 默认输入目录 `merge/`（修订新增）

新增仓库根目录 `merge/` 作为合并输入的固定投放处（本地管理，不入 git，与 `project/` 同策略）：

```
merge/
├── vOrange                  # vOrange 版本清单（与任务参数同名）
└── orangePatchVersion.txt   # 补丁版本文件（与任务参数同名）
```

**参数解析优先级**：

1. `--vorange` / `--patch` 显式指定：
   - 绝对路径 → 按原样使用；
   - 含路径分隔符 → 相对当前目录解析；
   - 纯文件名 → 先查 `merge/`，再查 `project/`（沿用已有清单的习惯）。
2. 参数缺省 → **直接读默认文件** `merge/vOrange` 与 `merge/orangePatchVersion.txt`；
   文件不存在时报错并提示应放置的路径（不再进入交互选择器）。

### 4.1 参数

```ts
export interface MergeArgs {
  vorange?: string;  // 缺省读 merge/vOrange
  patch?: string;    // 缺省读 merge/orangePatchVersion.txt
}
export function parseMergeArgs(argv: string[]): MergeArgs;  // --vorange / --patch

/** 单个输入文件解析（导出以便单测） */
export function resolveMergeInput(
  value: string | undefined,
  kind: 'vorange' | 'patch',
  dirs: { mergeDir: string; projectDir: string }
): string;  // 返回存在的绝对路径，不存在抛 JenkinsError（附目录可用文件列表）
```

### 4.2 交互选择标题

`pickProjectFile` 支持可选 `title` 参数（本命令修订后不再使用选择器，能力保留给其他命令）。

### 4.3 工作流

```
merge --vorange A --patch B
  ├─ createClientFromEnv + precheckAuth
  ├─ client.build(JOBS.orangeVersionMerge, {
  │      vOrange: { type: 'file', path: project/A },
  │      'orangePatchVersion.txt': { type: 'file', path: project/B },
  │    }, { wait: true, pollInterval: 10000, maxWaitTime: 600000, streamLogs: true })
  ├─ client.download(job, undefined, 'version-merge/dist/vOrange', downloads/, { source: 'workspace' })
  │    （workspace 下载需认证，走 SDK HttpClient；当前 workspace 即本次构建结果）
  ├─ 重命名为 downloads/vOrange-merge-b<构建号>
  └─ notify 成功（含构建号/耗时/产物路径）
```

### 4.4 注册点

| 位置 | 改动 |
|------|------|
| `src/workflow/jobs.ts` | `JOBS.orangeVersionMerge = 'web/job/orange-version-merge'` |
| `src/workflows/version-merge.ts` | 新增工作流（导出 parseMergeArgs / mergeCommand） |
| `examples/05-version-merge-workflow.ts` | 薄封装入口 |
| `package.json` | `"merge": "tsx ./examples/05-version-merge-workflow.ts"` |
| `src/cli/index.ts` | `merge` 子命令 + help 文案 |
| README / docs/03 | 命令表补一行 |

## 5. 测试策略

- 单测：`parseMergeArgs`（默认/解析/两个参数）；`pickProjectFile` 自定义标题显示。全部离线。
- 手动验证：`npm run merge`（无参数、非 TTY）→ 报错列出 project/ 可用文件、退出码 1；
  真实合并跑一次由使用者在内网验证（下载结果与 Jenkins 页面下载内容一致）。

## 6. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/workflow/jobs.ts` | +orangeVersionMerge |
| `src/workflows/interactive.ts` | pickProjectFile 支持 title |
| `src/workflows/version-merge.ts` | 新增 |
| `examples/05-version-merge-workflow.ts` | 新增薄封装 |
| `src/cli/index.ts` | merge 子命令 |
| `package.json` | merge script |
| `src/workflows/args.test.ts` | parseMergeArgs 用例 |
| `src/workflows/interactive.test.ts` | 标题用例 |
| `README.md`、`docs/03-项目结构.md` | 命令说明 |
