# 灵活模块打包(patch 命令参数化)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `examples/02-build-pcx-full-workflow.ts` 里写死的 `version_file` 文件名和 `orange_module` 参数化,通过 `--project` / `--module` 命令行参数传入,并把命令从 `npm run pcx` 重命名为 `npm run patch`。

**Architecture:** 复用现有 `orange-aliyun`(全量打包)+ `orange-patch`(模块裁剪)两个 Jenkins job,只改 `examples/02` 脚本和 `package.json`,SDK 核心(`src/`)不动。新增 `project/` 目录集中存放 vOrange 版本清单文件。

**Tech Stack:** TypeScript 5, tsx(运行), Node.js >= 18, axios, dotenv

## Global Constraints

- **不引入新依赖**(不用 commander/minimist 等 CLI 框架,argv 手写解析)
- **不改 SDK 核心**(`src/` 目录下的 `JenkinsClient`、`build-service` 等一律不动)
- **不改 `version_file` 的读取方式**(仍是 `fs.createReadStream` 整体上传给 Jenkins,本地不解析内容)
- **不改 `orange-aliyun` 全量打包步骤本身**
- **验证方式**:本项目无测试框架且脚本依赖真实 Jenkins,故每个任务用 `npm run type-check` + 实际运行验证,不写单元测试
- **保留**脚本里已有的 `import "dotenv/config"` 和 `verifyAuth()` 预检代码
- 提交信息用中文(跟随仓库现有 commit 风格,如 `增加回避重试功能...`)

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `project/` | 新建目录 | 集中存放 vOrange 版本清单文件 |
| `project/vOrange-gwzc-530` | 从 `examples/` 迁入 | 现有版本清单 |
| `examples/02-build-pcx-full-workflow.ts` | 修改 | 加 argv 解析 + 参数化 version_file / orange_module |
| `package.json` | 修改 | `scripts.pcx` → `scripts.patch` |
| `src/**` | **不动** | SDK 核心 |

---

## Task 1: 创建 project/ 目录并迁移 vOrange 文件

**Files:**
- Create: `project/`(目录)
- Move: `examples/vOrange-gwzc-530` → `project/vOrange-gwzc-530`

**Interfaces:**
- Produces: `project/vOrange-gwzc-530` 文件(Task 2 的脚本会从 `project/` 读它)

- [ ] **Step 1: 用 git mv 迁移文件(保留历史)**

```bash
mkdir -p project
git mv examples/vOrange-gwzc-530 project/vOrange-gwzc-530
```

- [ ] **Step 2: 验证迁移结果**

Run: `ls -la project/`
Expected: 看到 `vOrange-gwzc-530`,且 `examples/` 下已没有该文件

- [ ] **Step 3: 提交**

```bash
git add project/vOrange-gwzc-530 examples/vOrange-gwzc-530
git commit -m "新建 project 目录存放 vOrange 版本清单，迁移 vOrange-gwzc-530"
```

---

## Task 2: 02 脚本参数化(--project / --module)

**Files:**
- Modify: `examples/02-build-pcx-full-workflow.ts`

**Interfaces:**
- Consumes: `project/<文件名>`(Task 1 产出的目录约定)
- Produces: 脚本接受 `--project`(必传)、`--module`(默认 `pcx`)两个参数

- [ ] **Step 1: 在 `main` 函数之前新增 argv 解析函数**

在 `import "dotenv/config";` 等 import 之后、`async function main()` 之前,插入:

```typescript
interface PatchArgs {
  project: string;   // vOrange 文件名(必传)
  module: string;    // 保留的模块,逗号分隔多个,默认 pcx
}

/**
 * 解析命令行参数
 * 用法: npm run patch -- --project <vOrange文件名> [--module <模块>]
 */
function parsePatchArgs(argv: string[]): PatchArgs {
  let project: string | undefined;
  let moduleArg = "pcx";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && i + 1 < argv.length) {
      project = argv[++i];
    } else if (argv[i] === "--module" && i + 1 < argv.length) {
      moduleArg = argv[++i];
    }
  }

  if (!project) {
    console.error(
      "❌ 缺少必传参数 --project\n" +
        "用法: npm run patch -- --project <vOrange文件名> [--module <模块>]\n" +
        "例如: npm run patch -- --project vOrange-gwzc-530 --module pcx"
    );
    process.exit(1);
  }

  return { project, module: moduleArg };
}
```

- [ ] **Step 2: 在 `main` 开头解析参数**

把 `main` 函数体最开头(`const client = new JenkinsClient(...)` 之前)加入:

```typescript
  const { project, module: moduleArg } = parsePatchArgs(process.argv.slice(2));
  console.log(`打包任务: project=${project}, module=${moduleArg}`);
```

- [ ] **Step 3: 参数化 version_file 路径**

把:
```typescript
  const configFilePath = path.join(process.cwd(), "examples", "vOrange-gwzc-530");
```
改为:
```typescript
  const configFilePath = path.join(process.cwd(), "project", project);
```

- [ ] **Step 4: 参数化 orange_module**

在第二段 `client.build("web/job/orange-patch", {...})` 调用里,把:
```typescript
      orange_module: "pcx",
```
改为:
```typescript
      orange_module: moduleArg,
```

- [ ] **Step 5: type-check 验证**

Run: `npm run type-check`
Expected: 无错误,退出码 0

- [ ] **Step 6: 手动验证 argv 解析(不触发构建)**

Run: `npx tsx ./examples/02-build-pcx-full-workflow.ts`
Expected: 立刻打印 `❌ 缺少必传参数 --project ...` 并退出(因为没传 --project,且在连接 Jenkins 前就校验退出)

- [ ] **Step 7: 提交**

```bash
git add examples/02-build-pcx-full-workflow.ts
git commit -m "02 脚本参数化：支持 --project 指定版本清单、--module 指定保留模块"
```

---

## Task 3: package.json 新增 patch 命令

**Files:**
- Modify: `package.json`(scripts 段)

**Interfaces:**
- Produces: `npm run patch` 命令(Task 4 用它做端到端验证)

- [ ] **Step 1: 替换 scripts 里的 pcx 为 patch**

把 `package.json` 的 `scripts` 里:
```json
    "pcx": "tsx ./examples/02-build-pcx-full-workflow.ts"
```
改为:
```json
    "patch": "tsx ./examples/02-build-pcx-full-workflow.ts"
```

(注意:删除 `pcx`、新增 `patch`,不是并存。`pty-pcx` 和 `gwwy` 保持不动。)

- [ ] **Step 2: 验证命令存在且参数缺失时正确报错**

Run: `npm run patch`
Expected: 打印 `❌ 缺少必传参数 --project ...` 并退出(证明 patch 命令已生效,且必传校验工作)

- [ ] **Step 3: 提交**

```bash
git add package.json
git commit -m "package.json 新增 patch 命令，替代原 pcx 命令"
```

---

## Task 4: 端到端验证(单模块 + 多模块)

**Files:** 无代码改动(纯验证任务;若发现问题才回头改 Task 2)

**Interfaces:**
- Consumes: 前三个任务的全部产出

> ⚠️ 此任务会**真实触发 Jenkins 构建**:`orange-aliyun` 全量打包约 2-3 分钟 + `orange-patch` 约 3 秒。需 `.env` 已配置好可用的 Jenkins 连接(已完成)。

- [ ] **Step 1: 单模块端到端(默认 pcx)**

Run: `npm run patch -- --project vOrange-gwzc-530`
Expected:
- 打印 `打包任务: project=vOrange-gwzc-530, module=pcx`
- `✅ 认证成功`
- `orange-aliyun` 构建 SUCCESS → 产出 `orange_*.zip`
- `orange-patch` 构建 SUCCESS → 产出 `update_patch_pcx_*.zip`
- 下载到 `downloads/update_patch_pcx_*.zip`,退出码 0

- [ ] **Step 2: 多模块端到端(验证「一个合并包」假设)**

Run: `npm run patch -- --project vOrange-gwzc-530 --module pcx,home`
Expected:
- `orange-patch` 产出一个合并包(含 pcx 和 home 两模块)
- 下载成功

验证产物含两模块:
```bash
unzip -l downloads/update_patch_*.zip | grep -E "modules/(pcx|home)/" | head
```
Expected: 同时看到 `modules/pcx/` 和 `modules/home/` 下的文件

- [ ] **Step 3: 记录多模块结果**

若多模块产物**确实是一个含两模块的合并包** → 验证通过,设计文档第 7 节"待验证点"关闭。
若**不是**(例如出了两个包,或只含一个模块) → 回到 Task 2,调整 `orange_module` 传值格式(如改用分号、或循环调用),并更新设计文档第 5.3/7 节。

- [ ] **Step 4: 无代码改动则无需提交;若有修复则提交**

---

## Self-Review(计划自检)

- ✅ **Spec 覆盖**:设计文档每条都在计划中有对应任务
  - `--project` 必传 → Task 2 Step 1/2(parsePatchArgs 缺失报错)
  - `--module` 默认 pcx / 逗号多模块 → Task 2 Step 1
  - `project/` 目录 + 文件迁移 → Task 1
  - version_file 路径参数化 → Task 2 Step 3
  - orange_module 参数化 → Task 2 Step 4
  - package.json pcx→patch → Task 3
  - 多模块一个合并包(待验证) → Task 4 Step 2/3
- ✅ **无占位符**:所有 step 都有具体代码或具体命令
- ✅ **类型一致**:`PatchArgs.project` / `PatchArgs.module` 在 Task 2 各 step 间命名一致(解构时 `module` 重命名为 `moduleArg` 避免与 Node 全局 `module` 混淆)
- ✅ **YAGNI**:未引入测试框架、未改 SDK、未改 build_type/options
