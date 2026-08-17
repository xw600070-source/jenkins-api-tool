import { JenkinsClientConfig, BuildParameters, BuildOptions, BuildTriggerResult, BuildCompleteResult, BuildStatusResult, DownloadResult, DownloadAllResult, DownloadOptions, JobInfo, QueueItemInfo } from '../types';
import { Logger } from '../utils/logger';
import { HttpClient } from '../services/http-client';
import { BuildService } from '../services/build-service';
import { StatusService } from '../services/status-service';
import { DownloadService } from '../services/download-service';

export class JenkinsClient {
  private config: Required<JenkinsClientConfig>;
  private httpClient: HttpClient;
  private buildService: BuildService;
  private statusService: StatusService;
  private downloadService: DownloadService;
  private logger: Logger;

  constructor(config: JenkinsClientConfig) {
    if (!config.apiToken && !config.password) {
      throw new Error('Either "apiToken" or "password" must be provided in JenkinsClientConfig');
    }

    this.config = {
      url: config.url,
      username: config.username,
      password: config.password || '',
      apiToken: config.apiToken || '',
      timeout: config.timeout || 30000,
      retries: config.retries || 0,
      retryDelay: config.retryDelay || 1000,
      logLevel: config.logLevel || 'info',
    };

    this.logger = new Logger(this.config.logLevel);
    this.httpClient = new HttpClient(this.config);
    this.statusService = new StatusService(this.httpClient);
    this.buildService = new BuildService(this.httpClient, this.statusService);
    this.downloadService = new DownloadService(this.httpClient, this.statusService);

    this.logger.info(`JenkinsClient initialized: ${this.config.url}`);
  }

  /**
   * 触发构建
   */
  async build(
    jobName: string,
    params?: BuildParameters,
    options?: BuildOptions
  ): Promise<BuildTriggerResult | BuildCompleteResult> {
    const buildOptions: Required<BuildOptions> = {
      wait: options?.wait || false,
      pollInterval: options?.pollInterval || 5000,
      maxWaitTime: options?.maxWaitTime || 600000,
      crumbIssuer: options?.crumbIssuer !== false,
      retryOnTimeout: options?.retryOnTimeout ?? 3,
      streamLogs: options?.streamLogs ?? false,
    };

    // Step 1: Trigger the build
    const triggerResult = await this.buildService.trigger(jobName, params, buildOptions);

    // Step 2: If wait mode, poll until completion
    if (buildOptions.wait) {
      return await this.buildService.waitForCompletion(
        jobName,
        triggerResult.queueId,
        {
          pollInterval: buildOptions.pollInterval,
          maxWaitTime: buildOptions.maxWaitTime,
          retryOnTimeout: buildOptions.retryOnTimeout,
          streamLogs: buildOptions.streamLogs,
        }
      );
    }

    return triggerResult;
  }

  /**
   * 查询构建状态
   */
  async getStatus(jobName: string, buildNumber: number | 'last'): Promise<BuildStatusResult> {
    return await this.statusService.getStatus(jobName, buildNumber);
  }

  /**
   * 下载单个产物/文件
   * @param jobName - Job 名称
   * @param buildNumber - 构建编号（可选，不传则使用当前 workspace）
   * @param filePath - 文件路径（artifact 相对路径或 workspace 相对路径）
   * @param outputDir - 本地输出目录
   * @param options - 下载选项（可选）
   */
  async download(
    jobName: string,
    buildNumber: number | undefined,
    filePath: string,
    outputDir: string,
    options?: DownloadOptions
  ): Promise<DownloadResult> {
    const source = options?.source || 'artifact';

    if (source === 'workspace') {
      return await this.downloadService.downloadFromWorkspace(jobName, buildNumber, filePath, outputDir);
    } else {
      if (buildNumber === undefined) {
        throw new Error('buildNumber is required for artifact downloads');
      }
      return await this.downloadService.downloadArtifact(jobName, buildNumber, filePath, outputDir);
    }
  }

  /**
   * 下载所有产物/文件
   * @param jobName - Job 名称
   * @param buildNumber - 构建编号（可选，不传则使用当前 workspace）
   * @param outputDir - 本地输出目录
   * @param options - 下载选项（可选）
   */
  async downloadAll(
    jobName: string,
    buildNumber: number | undefined,
    outputDir: string,
    options?: DownloadOptions
  ): Promise<DownloadAllResult> {
    const source = options?.source || 'artifact';

    if (source === 'workspace') {
      return await this.downloadService.downloadAllFromWorkspace(jobName, buildNumber, outputDir, options);
    } else {
      if (buildNumber === undefined) {
        throw new Error('buildNumber is required for artifact downloads');
      }
      return await this.downloadService.downloadAllArtifacts(jobName, buildNumber, outputDir);
    }
  }

  /**
   * 获取构建日志
   */
  async getConsoleText(jobName: string, buildNumber: number): Promise<string> {
    const url = `/job/${jobName}/${buildNumber}/consoleText`;
    this.logger.debug(`Fetching console text: ${url}`);
    return await this.httpClient.get<string>(url);
  }

  /**
   * 增量获取构建日志（progressiveText）
   * @param start - 已消费的字节偏移（首次传 0）
   * @returns text 为本次新增内容；textSize 作为下次的 start；moreData 表示构建是否还在产出日志
   */
  async getProgressiveConsoleText(
    jobName: string,
    buildNumber: number,
    start = 0
  ): Promise<{ text: string; textSize: number; moreData: boolean }> {
    const url = `/job/${jobName}/${buildNumber}/progressiveText`;
    this.logger.debug(`Fetching progressive console text: ${url} (start: ${start})`);

    const { data, headers } = await this.httpClient.getFull<string>(url, { start });

    return {
      text: data,
      textSize: parseInt(String(headers['x-text-size'] ?? '0'), 10),
      moreData: headers['x-more-data'] === 'true',
    };
  }

  /**
   * 列出 job（根目录或指定 folder，只列一层）
   * @param folder - 可选的文件夹路径，如 'web'
   */
  async listJobs(folder?: string): Promise<JobInfo[]> {
    return await this.statusService.listJobs(folder);
  }

  /**
   * 查看构建队列
   */
  async getQueue(): Promise<QueueItemInfo[]> {
    return await this.statusService.getQueue();
  }

  /**
   * 停止进行中的构建
   */
  async stopBuild(
    jobName: string,
    buildNumber: number,
    options?: { crumbIssuer?: boolean }
  ): Promise<void> {
    return await this.buildService.stopBuild(jobName, buildNumber, options);
  }

  /**
   * 重试已完成的构建（相当于 Jenkins 页面上的 Retry）
   */
  async retryBuild(
    jobName: string,
    buildNumber: number,
    options?: { crumbIssuer?: boolean }
  ): Promise<BuildTriggerResult> {
    return await this.buildService.retryBuild(jobName, buildNumber, options);
  }

  /**
   * 验证连接和认证
   */
  async verifyAuth(): Promise<{ authenticated: boolean; user?: string; version?: string; url: string }> {
    this.logger.info('Verifying Jenkins connection and authentication...');

    try {
      // Try to get Jenkins version and user info from /api/json
      const data: any = await this.httpClient.get('/api/json');

      const result = {
        authenticated: true,
        user: data.user || data.authenticatedUser || this.config.username,
        version: data.version || (data._class ? 'Connected' : undefined),
        url: this.config.url,
      };

      this.logger.info(`Authentication successful: ${result.user}`);
      if (result.version) {
        this.logger.info(`Jenkins version: ${result.version}`);
      }

      return result;
    } catch (error: any) {
      this.logger.error(`Authentication failed: ${error.message}`);
      return {
        authenticated: false,
        url: this.config.url,
      };
    }
  }
}
