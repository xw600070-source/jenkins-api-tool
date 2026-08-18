# Jenkins API Tool

Node.js SDK for Jenkins RESTful API - 支持带参数构建、状态查询、产物下载。

## 安装

```bash
npm install
```

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件:

```env
# 方式1: API Token 认证 (未验证)
# JENKINS_URL=http://your-jenkins-server:8080
# JENKINS_USERNAME=your_username
# JENKINS_API_TOKEN=your_api_token

# 方式2: 用户名密码认证 (已验证)
JENKINS_URL=http://your-jenkins-server:8080
JENKINS_USERNAME=your_username
JENKINS_PASSWORD=your_password
```

编辑path环境变量:

bandzip-service.ts封装了bandzip操作，如果使用compress-service.ts那么需要将bz.exe添加到Path路径

### 2. 使用 SDK

```typescript
import { JenkinsClient } from './src';

// 方式1: API Token 认证 (推荐)
const client = new JenkinsClient({
  url: process.env.JENKINS_URL,
  username: process.env.JENKINS_USERNAME,
  apiToken: process.env.JENKINS_API_TOKEN,
});

// 方式2: 用户名密码认证
const client = new JenkinsClient({
  url: process.env.JENKINS_URL,
  username: process.env.JENKINS_USERNAME,
  password: process.env.JENKINS_PASSWORD,
});

// 触发构建
const result = await client.build('my-job', {
  ENV: 'production',
  VERSION: '1.0.0',
});

// 查询构建状态
const status = await client.getStatus('my-job', result.queueId);

// 下载产物
await client.downloadAll('my-job', status.buildNumber, './dist');
```

## 打包工作流命令

项目提供开箱即用的打包工作流（实现位于 `src/workflows/`，`examples/` 下是对应入口）。

### 统一 CLI（推荐）

```bash
npm run jenkins -- <子命令> [参数]
```

| 子命令 | 等价 npm script | 用途 |
|--------|----------------|------|
| `patch` | `npm run patch` | **灵活打包**：按版本清单 + 指定保留模块 |
| `pcx` | `npm run pcx` | 固定打包 pcx 模块补丁包 |
| `merge` | `npm run merge` | **版本清单合并**：上传两份清单到 orange-version-merge |
| `pty-pcx` | `npm run pty-pcx` | pty-pcx 完整打包（构建+下载+解压+重压缩） |
| `gwwy` | `npm run gwwy` | gwwy uniapp **本地**构建压缩 |
| `gwwy-online` | `npm run gwwy-online` | gwwy uniapp **线上**打包：触发 Jenkins 按分支打包 |
| `jobs [folder]` | — | 列出 Jenkins job |
| `queue` | — | 查看构建队列 |
| `stop <job> <构建号>` | — | 停止进行中的构建（执行前确认） |
| `retry <job> <构建号>` | — | 重试已完成的构建 |

不带参数运行 `npm run jenkins` 查看完整帮助。

**通用行为**：

- 长任务（patch / pcx / gwwy-online）等待构建期间会**流式打印 Jenkins 构建日志**，不用干等。
- 结束弹 macOS 系统通知（成功/失败）。临时关闭：`NOTIFY=0 npm run ...`。
- **失败退出码为 1**（参数缺失、认证失败、构建失败、下载失败等），可在 CI / 串联脚本中判断。
- 打包工作流**严格校验参数**：未知 flag / 位置参数直接报错，不会带着默认值触发构建。注意 `npm run jenkins` 与子命令之间必须加 `--` 分隔符，否则 `--project` 这类 flag 会被 npm 吞掉。

### patch 命令（灵活模块打包）

按 `project/` 目录下的版本清单文件打包，并从全量产物中只保留指定模块。

**参数：**

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--project` | 否 | 交互选择 | `project/` 目录下的 vOrange 版本清单文件名；省略时列出文件供数字选择 |
| `--module` | 否 | `pcx` | 保留的模块，逗号分隔多个则出一个合并包 |

**示例：**

```bash
# 交互选择清单文件，默认保留 pcx 模块
npm run patch

# 用 vOrange-gwzc-530 版本清单，默认保留 pcx 模块
npm run patch -- --project vOrange-gwzc-530

# 保留多个模块（出一个含 pcx + home 的合并包）
npm run patch -- --project vOrange-gwzc-530 --module pcx,home
```

**流程**：认证预检 → 触发 `orange-aliyun` 全量打包（期间流式打印构建日志）→ 触发 `orange-patch` 按模块裁剪 → 下载补丁包到 `downloads/`（带进度/重试）。

**版本清单文件格式**（`project/<文件名>`，每行一个模块：`<时间戳> <模块名> <分支-提交>`）：

```
20260609130210 orange Feature_20250830_wuZhiHua-HEAD
20260609130233 home   Feature_20250410_wuZhiHua-4e9d71ff
20260724113202 pcx    Feature_20260530_gwzc-HEAD
```

### merge 命令（版本清单合并）

上传两份清单文件到 Jenkins 任务 `orange-version-merge`（文件参数 `vOrange` + `orangePatchVersion.txt`），等待合并完成（约 1 分钟），下载合并结果到 `downloads/vOrange-merge-b<构建号>`。

**默认输入目录 `merge/`**（本地管理，不入 git）：把两份文件按下面的名字放进去，直接运行 `npm run merge` 即可，无需参数：

```
merge/
├── vOrange                  # vOrange 版本清单
└── orangePatchVersion.txt   # 补丁版本文件
```

**参数：**

| 参数 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `--vorange` | 否 | `merge/vOrange` | vOrange 版本清单；纯文件名先查 `merge/` 再查 `project/`，也可传相对/绝对路径 |
| `--patch` | 否 | `merge/orangePatchVersion.txt` | 补丁版本文件；查找规则同上 |

**示例：**

```bash
# 读 merge/ 目录下的默认两个文件
npm run merge

# 显式指定（project/ 里已有的清单可直接用文件名）
npm run merge -- --vorange vOrange-gwzc-530 --patch orangePatchVersion.txt
```

**流程**：认证预检 → 上传两份清单触发合并（期间流式打印构建日志）→ 从 workspace 认证下载合并结果 → 保存为 `downloads/vOrange-merge-b<构建号>`（确认内容后可复制到 `project/` 供 patch 使用）。

### gwwy / gwwy-online 命令（uniapp 打包）

`gwwy-online` 触发 Jenkins 任务 `web/job/gwwy-uniapp` 按指定分支打包，等待构建结束并从控制台日志提取下载链接、下载产物到 `downloads/`。`gwwy` 为本地（Git Bash）构建压缩版本，两者互为线上/线下对应。

**参数：**

| 参数 | 命令 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `--branch` | gwwy-online | 是 | - | 要打包的 Git 分支名 |
| `--branch` | gwwy | 否 | 内置默认分支 | 本地构建的目标分支 |
| `--head` | gwwy-online | 否 | `HEAD` | 分支上的提交 ref |

**示例：**

```bash
# 线上：默认打包分支最新提交(HEAD)
npm run gwwy-online -- --branch Feature_20260130_chongQingWenLvWei

# 线上：指定具体提交
npm run gwwy-online -- --branch Feature_20260130_chongQingWenLvWei --head 4e9d71ff

# 本地：指定分支（不传用默认分支）
npm run gwwy -- --branch Feature_20260130_chongQingWenLvWei
```

**流程**（gwwy-online）：认证预检 → 触发构建（`wait:true` 等待完成，期间流式打印构建日志，高负载下状态查询超时自动回避重试）→ 从控制台日志提取下载链接（`gwwy-uniapp-file` 静态目录）并下载到 `downloads/`（带进度显示、失败自动重试）。

## API 文档

### JenkinsClient

#### constructor(config)

初始化 Jenkins 客户端。

| 参数                | 类型     | 必填  | 默认值    | 说明                                  |
| ----------------- | ------ | --- | ------ | ----------------------------------- |
| config.url        | string | 是   | -      | Jenkins 服务器地址                       |
| config.username   | string | 是   | -      | 用户名                                 |
| config.password   | string | 否\* | -      | 密码 (与 apiToken 二选一)                 |
| config.apiToken   | string | 否\* | -      | API Token (与 password 二选一)          |
| config.timeout    | number | 否   | 30000  | 请求超时时间(ms)                          |
| config.retries    | number | 否   | 0      | 重试次数                                |
| config.retryDelay | number | 否   | 1000   | 重试延迟(ms)                            |
| config.logLevel   | string | 否   | 'info' | 日志级别 (debug/info/warn/error/silent) |

#### build(jobName, params?, options?)

触发 Jenkins 构建。

| 参数      | 类型              | 说明        |
| ------- | --------------- | --------- |
| jobName | string          | Job 名称    |
| params  | BuildParameters | 构建参数 (可选) |
| options | BuildOptions    | 构建选项 (可选) |

**BuildParameters**:

```typescript
{
  STRING_PARAM: 'value',        // 字符串参数
  BOOL_PARAM: true,             // 布尔参数
  CHOICE_PARAM: 'option1',      // 选项参数
  FILE_PARAM: {                 // 文件参数
    type: 'file',
    path: './config.json'
  }
}
```

**BuildOptions**:

| 选项           | 类型      | 默认值    | 说明           |
| ------------ | ------- | ------ | ------------ |
| wait         | boolean | false  | 是否等待构建完成     |
| pollInterval | number  | 5000   | 轮询间隔(ms)     |
| maxWaitTime  | number  | 600000 | 最大等待时间(ms)   |
| crumbIssuer  | boolean | true   | 是否启用 CSRF 保护 |
| retryOnTimeout | number | 3    | 轮询网络超时回避重试次数 |
| streamLogs   | boolean | false | 等待期间是否增量打印构建日志（progressiveText，端点不可用时自动降级） |

**返回值**:

- 异步模式: `BuildTriggerResult` (queueId, url, jobName)
- 同步模式: `BuildCompleteResult` (包含 buildNumber, status, duration, artifacts)

#### getStatus(jobName, buildNumber)

查询构建状态。

| 参数          | 类型               | 说明           |
| ----------- | ---------------- | ------------ |
| jobName     | string           | Job 名称       |
| buildNumber | number \| 'last' | 构建编号或 'last' |

**返回值**: `BuildStatusResult`

#### download(jobName, buildNumber, artifactPath, outputDir)

下载单个构建产物。

| 参数           | 类型     | 说明     |
| ------------ | ------ | ------ |
| jobName      | string | Job 名称 |
| buildNumber  | number | 构建编号   |
| artifactPath | string | 产物相对路径 |
| outputDir    | string | 本地输出目录 |

**返回值**: `DownloadResult`

#### downloadAll(jobName, buildNumber, outputDir)

下载所有构建产物。

| 参数          | 类型     | 说明     |
| ----------- | ------ | ------ |
| jobName     | string | Job 名称 |
| buildNumber | number | 构建编号   |
| outputDir   | string | 本地输出目录 |

**返回值**: `DownloadAllResult`

#### getConsoleText(jobName, buildNumber)

获取构建控制台日志。

| 参数          | 类型     | 说明     |
| ----------- | ------ | ------ |
| jobName     | string | Job 名称 |
| buildNumber | number | 构建编号   |

**返回值**: `string` (日志内容)

#### getProgressiveConsoleText(jobName, buildNumber, start?)

增量获取构建日志（progressiveText 端点）。

| 参数          | 类型     | 说明                       |
| ----------- | ------ | ------------------------ |
| jobName     | string | Job 名称                   |
| buildNumber | number | 构建编号                     |
| start       | number | 已消费的字节偏移，首次传 0（默认 0） |

**返回值**: `{ text: string; textSize: number; moreData: boolean }` — `text` 为本次新增内容，`textSize` 作为下次的 `start`，`moreData` 表示构建是否还在产出日志。

#### listJobs(folder?)

列出 job（根目录或指定文件夹，只列一层）。

| 参数     | 类型     | 说明                    |
| ------ | ------- | ----------------------- |
| folder | string? | 文件夹路径，如 `web`（可选） |

**返回值**: `JobInfo[]`（`color`: blue=上次成功 / red=上次失败 / 带 `_anime` 后缀=进行中）

#### getQueue()

查看构建队列。**返回值**: `QueueItemInfo[]`（id / why / taskName / buildNumber 等）

#### stopBuild(jobName, buildNumber, options?)

停止进行中的构建。**返回值**: `Promise<void>`

#### retryBuild(jobName, buildNumber, options?)

重试已完成的构建（相当于 Jenkins 页面上的 Retry）。**返回值**: `Promise<BuildTriggerResult>`

#### verifyAuth()

验证 Jenkins 连接和认证是否有效。

**返回值**:

```typescript
{
  authenticated: boolean;  // 是否认证成功
  user?: string;           // 当前认证用户
  version?: string;        // Jenkins 版本信息
  url: string;             // 服务器地址
}
```

#

## 错误处理

```typescript
import { JenkinsClient, BuildFailedError, TimeoutError, AuthenticationError } from './src';

try {
  await client.build('my-job', {}, { wait: true });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('认证失败');
  } else if (error instanceof BuildFailedError) {
    console.error(`构建失败: #${error.buildNumber}`);
  } else if (error instanceof TimeoutError) {
    console.error('操作超时');
  }
}
```

## 构建

```bash
npm run build
```

构建产物将输出到 `dist/` 目录。

## 类型检查

```bash
npm run type-check
```

## 测试

```bash
npm test          # 单次运行
npm run test:watch  # 监听模式
```

单元测试（vitest）覆盖：辅助函数、通知拼装、配置加载、下载重试/校验、构建轮询与回避重试、状态解析、各工作流参数解析。测试不访问真实 Jenkins 服务器。

## License

MIT
