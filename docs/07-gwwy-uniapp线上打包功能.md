# gwwy-uniapp 线上打包功能需求方案

## 1. 背景与问题

### 1.1 问题描述
项目原本只有 gwwy-uniapp 的**本地**打包命令 `npm run gwwy`（[examples/03-build-gwwy-full-workflow.ts](../examples/03-build-gwwy-full-workflow.ts)）：在本机用 Git Bash 切分支、`npm run build`、再用 `CompressService` 压成 zip。它完全不调用 Jenkins，依赖本机环境（Windows + Git Bash + bz.exe）。

现在需要一个**线上**打包入口：直接触发 Jenkins 任务 `web/job/gwwy-uniapp`（`http://223.223.178.68:2004/jenkins-122/job/web/job/gwwy-uniapp/`）按指定分支打包，构建完成后自动下载打包产物，不依赖本机构建环境。

### 1.2 现状分析
SDK 已具备全部所需能力，无需新增 SDK 代码：

- [JenkinsClient](../src/client/jenkins-client.ts) - `build` / `verifyAuth` / `getConsoleText` 等方法
- [BuildService](../src/services/build-service.ts) - `trigger` + `waitForCompletion`，含排队→构建号解析、状态轮询、网络超时“回避重试”（`retryOnTimeout`）
- 现有可参考的触发脚本：[examples/build-patch-workflow.ts](../examples/build-patch-workflow.ts)（参数解析 + `verifyAuth` 预检 + 控制台抓链接下载）、[examples/01-build-pty-pcx-full-workflow.ts](../examples/01-build-pty-pcx-full-workflow.ts)（`git_branch` 参数 + 错误处理）

## 2. 需求分析

### 2.1 核心需求
新增 `gwwy-online` 命令，通过命令行参数指定分支（及可选提交），触发线上构建并下载产物。

### 2.2 需求细化
| 需求项 | 说明 | 默认值 |
|--------|------|--------|
| 命令 | `npm run gwwy-online -- --branch <分支> [--head <提交>]` | - |
| 打包分支 | 必传，对应 Jenkins 任务的 `git_branch` 参数 | - |
| 打包提交 | 可选，分支上的提交 ref，对应 `git_head` 参数 | `HEAD` |
| 等待策略 | `wait:true` 等到构建结束 | - |
| 超时重试 | 高负载下状态查询超时自动回避重试 | `retryOnTimeout: 3` |
| 产物下载 | 构建成功后下载打包产物到 `downloads/` | - |
| 认证预检 | 触发前 `verifyAuth` 校验连接和凭据 | - |

### 2.3 非需求范围
- 不改动 SDK（`src/`）任何代码
- 不实现本地构建（本地构建仍由 `npm run gwwy` 负责）
- 不抓取/解析控制台构建日志中的其它信息（仅提取下载链接）

## 3. 方案设计

### 3.1 改动范围
| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `examples/04-build-gwwy-uniapp-online.ts` | 新增 | 线上打包脚本主体 |
| `package.json` | 修改 | 新增 `gwwy-online` npm script |
| `README.md` | 修改 | 命令表格补一行 + `gwwy-online` 用法小节 |

### 3.2 脚本结构
脚本以 [examples/build-patch-workflow.ts](../examples/build-patch-workflow.ts) 与 [examples/01-build-pty-pcx-full-workflow.ts](../examples/01-build-pty-pcx-full-workflow.ts) 为模板：

1. **参数解析** `parseArgs`：手写解析 `--branch`（必传）、`--head`（默认 `HEAD`），缺失必传项打印用法并以非零码退出
2. **客户端初始化**：从 `.env` 读取 `JENKINS_URL` / `JENKINS_USERNAME` / `JENKINS_API_TOKEN` / `JENKINS_PASSWORD` 构造 `JenkinsClient`
3. **认证预检** `verifyAuth()`：失败即退出
4. **触发并等待**：
   ```typescript
   await client.build(
     "web/job/gwwy-uniapp",
     { git_branch: branch, git_head: head },
     { wait: true, pollInterval: 20000, maxWaitTime: 3600000, crumbIssuer: true, retryOnTimeout: 3 }
   );
   ```
5. **下载产物**：从控制台日志提取下载链接并下载（见 3.4）
6. **错误处理**：`BuildFailedError` / `TimeoutError` 分类处理

### 3.3 Job 路径映射
目标 URL `…/jenkins-122/job/web/job/gwwy-uniapp/` 拆分为：

- `JENKINS_URL` = `http://223.223.178.68:2004/jenkins-122`（复用现有 `.env`，同主机）
- `jobName` = `web/job/gwwy-uniapp`

与现有 `web/job/orange-aliyun`、`server/job/pex/job/pty-pcx` 用法一致。

### 3.4 产物下载机制（控制台抓取）
gwwy-uniapp 构建产物**不是 Jenkins 归档产物**，而是发布到独立静态目录 `http://223.223.178.68:2004/gwwy-uniapp-file/`（如 `gwwy-uniapp_20260805200020.zip`），并在控制台日志中打印下载链接。因此采用与 `orange-patch` 相同的方式：

1. `getConsoleText("web/job/gwwy-uniapp", buildNumber)` 读取**本次构建**的控制台
2. 正则优先匹配完整链接：`http:\/\/223\.223\.178\.68:2004\/gwwy-uniapp-file\/[^\s"'<>]+\.zip`
3. 兜底：若控制台只打印文件名，则匹配 `gwwy-uniapp_\d{14}\.zip` 再拼回完整 URL
4. `axios.get(url, { responseType: "stream" })` 流式写入 `downloads/<文件名>`

### 3.5 使用示例

```bash
# 默认打包分支最新提交（HEAD）
npm run gwwy-online -- --branch Feature_20260530_gwzc

# 指定具体提交
npm run gwwy-online -- --branch Feature_20260530_gwzc --head 4e9d71ff
```

## 4. 关键设计决策

### 4.1 为什么用控制台抓链接而不是 `downloadAll`（归档产物）？
| 方式 | 适用场景 | gwwy-uniapp 情况 |
|------|----------|------------------|
| `client.downloadAll`（归档产物 API） | 任务配了 “Archive the artifacts” | ❌ 归档产物为空（实测下载不到） |
| 控制台抓 URL + axios（静态目录） | 产物发布到独立静态文件服务并 echo 链接 | ✅ 产物在 `gwwy-uniapp-file` 静态目录 |

实测 `downloadAll` 对该任务返回 0 个产物，故改用控制台抓取方式。

### 4.2 如何保证下载的就是“当前这次构建”的包？
整条链路绑定到本次构建，没有一处靠猜：

```
本次触发 → queueId → buildNumber（排队调度后 Jenkins 分配）
        → getConsoleText(job, buildNumber) 读【本次构建】控制台
        → 正则抓【本次构建自己 echo】的文件名/URL（时间戳由本次构建生成）
        → 下载该文件
```

`buildNumber` 由 `waitForCompletion` 从本次 `queueId` 追踪而来，`getConsoleText` 据此读取本次构建日志，文件名里的时间戳（`gwwy-uniapp_YYYYMMDDHHmmss.zip`）是本次构建运行时生成。因此不会误下成别的构建或目录里的残留包。

### 4.3 前置假设
本方案依赖 **gwwy-uniapp 构建会在控制台日志中打印下载链接（或文件名）**。若任务未 echo，正则匹配不到会输出 `⚠️ 控制台日志中未找到下载链接`，届时需根据实际日志调整正则。

## 5. 验收标准

1. ✅ `npm run gwwy-online`（不带 `--branch`）打印用法并以非零码退出
2. ✅ `npm run gwwy-online -- --branch <分支>` 能认证、触发 `web/job/gwwy-uniapp`、等待完成
3. ✅ 高负载下状态查询超时能自动“回避重试”
4. ✅ 构建成功后从控制台提取下载链接，产物下载到 `downloads/`
5. ✅ 构建失败时打印 `BuildFailedError` 构建号，超时打印 `TimeoutError`
6. ✅ `package.json` 与 README 同步更新

## 6. 影响范围

- 新增 1 个 example 脚本，1 条 npm script，README 1 个表格行 + 1 个小节
- 不影响现有 `gwwy` / `pcx` / `patch` / `pty-pcx` 命令
- 不改动 `src/`（SDK）
- 复用现有 `.env`（同主机 `…/jenkins-122`），无需新增环境变量

---

**文档版本**: v1.0
**创建时间**: 2026-08-05
**状态**: 已实现
