/**
 * 日志级别
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Jenkins 客户端配置
 */
export interface JenkinsClientConfig {
  /** Jenkins 服务器地址 */
  url: string;
  /** 用户名 */
  username: string;
  /** 密码 (与 apiToken 二选一) */
  password?: string;
  /** API Token (与 password 二选一) */
  apiToken?: string;
  /** 请求超时时间(ms), 默认 30000 */
  timeout?: number;
  /** 重试次数, 默认 0 */
  retries?: number;
  /** 重试延迟(ms), 默认 1000 */
  retryDelay?: number;
  /** 日志级别, 默认 'info' */
  logLevel?: LogLevel;
}

/**
 * 文件参数
 */
export interface FileParameter {
  type: 'file';
  /** 本地文件路径 */
  path: string;
}

/**
 * 构建参数 (键值对形式)
 */
export interface BuildParameters {
  [key: string]: string | boolean | FileParameter;
}

/**
 * 构建选项
 */
export interface BuildOptions {
  /** 是否等待构建完成, 默认 false */
  wait?: boolean;
  /** 轮询间隔(ms), 默认 5000 */
  pollInterval?: number;
  /** 最大等待时间(ms), 默认 600000 (10分钟) */
  maxWaitTime?: number;
  /** 是否启用 CSRF 保护, 默认 true */
  crumbIssuer?: boolean;
  /**
   * waitForCompletion 网络超时重试次数
   * 当轮询过程中遇到 ETIMEDOUT/ECONNABORTED 错误时自动重试
   * @default 3
   */
  retryOnTimeout?: number;
  /**
   * 等待构建完成期间是否增量打印构建日志（progressiveText）
   * 端点不可用时自动降级为静默轮询
   * @default false
   */
  streamLogs?: boolean;
}

/**
 * 构建状态
 */
export type BuildStatus =
  | 'SUCCESS'
  | 'FAILURE'
  | 'ABORTED'
  | 'UNSTABLE'
  | 'IN_PROGRESS'
  | 'NOT_BUILT'
  | 'QUEUED'
  | 'UNKNOWN';

/**
 * 产物信息
 */
export interface ArtifactInfo {
  /** 文件名 */
  fileName: string;
  /** 相对路径 */
  relativePath: string;
  /** 文件大小(字节) */
  size?: number;
}

/**
 * 构建触发结果
 */
export interface BuildTriggerResult {
  /** 队列 ID */
  queueId: number;
  /** 构建 URL */
  url: string;
  /** Job 名称 */
  jobName: string;
}

/**
 * 构建完成结果 (同步模式返回)
 */
export interface BuildCompleteResult extends BuildTriggerResult {
  /** 构建编号 */
  buildNumber: number;
  /** 构建状态 */
  status: BuildStatus;
  /** 构建耗时(ms) */
  duration: number;
  /** 构建产物列表 */
  artifacts: ArtifactInfo[];
}

/**
 * 构建触发原因
 */
export interface BuildCause {
  /** 简短描述 */
  shortDescription: string;
  /** 触发用户 ID */
  userId?: string;
  /** 用户名 */
  userName?: string;
}

/**
 * 参数信息
 */
export interface Parameter {
  name: string;
  value: string | boolean;
}

/**
 * 构建状态查询结果
 */
export interface BuildStatusResult {
  /** Job 名称 */
  jobName: string;
  /** 构建编号 */
  buildNumber: number;
  /** 构建状态 */
  status: BuildStatus;
  /** 显示名称 (如 "#123") */
  displayName: string;
  /** 构建描述 */
  description?: string;
  /** 开始时间戳 */
  timestamp: number;
  /** 持续时间(ms) */
  duration: number;
  /** 预估持续时间(ms) */
  estimatedDuration?: number;
  /** 是否正在构建 */
  building: boolean;
  /** 构建 URL */
  url: string;
  /** 控制台日志 URL */
  consoleUrl: string;
  /** 构建产物列表 */
  artifacts: ArtifactInfo[];
  /** 触发原因 */
  causes: BuildCause[];
  /** 构建参数 */
  parameters: Parameter[];
}

/**
 * 下载模式
 */
export type DownloadSource = 'artifact' | 'workspace';

/**
 * 下载选项
 */
export interface DownloadOptions {
  /** 下载源: 'artifact'(归档产物) 或 'workspace'(工作空间), 默认 'artifact' */
  source?: DownloadSource;
  /** workspace 基础路径 (仅当 source='workspace' 时有效), 如 'pty-pcx' */
  workspacePath?: string;
  /** 文件过滤模式 (支持 glob), 如 *.jar 或 *.zip */
  pattern?: string;
  /** 最大下载深度 (仅当 source='workspace' 时有效), 默认 10 */
  maxDepth?: number;
}

/**
 * Workspace 文件信息
 */
export interface WorkspaceFileInfo {
  /** 文件名 */
  name: string;
  /** 相对路径 (相对于 workspacePath) */
  relativePath: string;
  /** 是否为目录 */
  isDirectory: boolean;
  /** 文件大小(字节), 可能为空 */
  size?: number;
  /** 最后修改时间戳 */
  timestamp?: number;
}

/**
 * 下载结果
 */
export interface DownloadResult {
  /** 文件名 */
  fileName: string;
  /** 本地保存路径 */
  localPath: string;
  /** 文件大小(字节) */
  size: number;
  /** 下载耗时(ms) */
  duration: number;
  /** 下载源 */
  source?: DownloadSource;
}

/**
 * 下载所有产物结果
 */
export interface DownloadAllResult {
  /** 总文件数 */
  total: number;
  /** 成功数 */
  success: number;
  /** 失败数 */
  failed: number;
  /** 详细结果列表 */
  results: DownloadResult[];
}

/**
 * Job 信息（listJobs 返回）
 */
export interface JobInfo {
  /** Job 名称 */
  name: string;
  /** Job URL */
  url: string;
  /**
   * Jenkins 原生颜色状态：blue=上次成功 red=上次失败 后缀 _anime=进行中
   * notbuilt=未构建 disabled=已禁用 aborted=已中止
   */
  color: string;
}

/**
 * 构建队列项信息（getQueue 返回）
 */
export interface QueueItemInfo {
  /** 队列项 ID */
  id: number;
  /** 排队原因（如 "等待空闲执行器"） */
  why?: string;
  /** 排队的任务名（job 名） */
  taskName?: string;
  /** 排队的任务 URL */
  taskUrl?: string;
  /** 已开始执行时的构建编号 */
  buildNumber?: number;
  /** 入队时间戳(ms) */
  queuedSince?: number;
}
