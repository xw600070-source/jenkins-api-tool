import * as fs from 'fs';
import FormData from 'form-data';
import { HttpClient } from './http-client';
import { StatusService } from './status-service';
import {
  BuildParameters,
  BuildOptions,
  BuildTriggerResult,
  BuildCompleteResult,
  BuildStatus,
  FileParameter,
} from '../types';
import { Logger } from '../utils/logger';
import { formatDuration } from '../utils/helpers';
import { TimeoutError, BuildFailedError, JenkinsError } from '../errors';export class BuildService {
  private httpClient: HttpClient;
  private statusService: StatusService;
  private logger: Logger;

  constructor(httpClient: HttpClient, statusService: StatusService) {
    this.httpClient = httpClient;
    this.statusService = statusService;
    this.logger = new Logger();
  }

  /**
   * 触发构建
   */
  async trigger(
    jobName: string,
    params?: BuildParameters,
    options?: BuildOptions
  ): Promise<BuildTriggerResult> {
    const hasParams = params && Object.keys(params).length > 0;
    const useCrumb = options?.crumbIssuer !== false;

    if (useCrumb) {
      await this.httpClient.initCrumb();
    }

    let queueId: number;

    if (hasParams) {
      queueId = await this.triggerWithParameters(jobName, params!);
    } else {
      queueId = await this.triggerWithoutParameters(jobName);
    }

    const url = `${this.httpClient.getBaseUrl()}/job/${jobName}/`;

    this.logger.info(`Build triggered: ${jobName} (Queue ID: ${queueId})`);

    return {
      queueId,
      url,
      jobName,
    };
  }

  /**
   * 等待构建完成 (轮询)
   */
  async waitForCompletion(
    jobName: string,
    queueId: number,
    options: { pollInterval: number; maxWaitTime: number; retryOnTimeout?: number; streamLogs?: boolean }
  ): Promise<BuildCompleteResult> {
    const startTime = Date.now();
    const { pollInterval, maxWaitTime } = options;
    const retryOnTimeout = options.retryOnTimeout ?? 3;
    let timeoutRetryCount = 0;  // 全局超时重试计数器
    let streamLogs = options.streamLogs ?? false;
    let logOffset = 0;          // progressiveText 已消费的字节偏移

    this.logger.info(
      `Waiting for build to complete ` +
      `(poll interval: ${pollInterval}ms, max wait: ${formatDuration(maxWaitTime)}, ` +
      `retry on timeout: ${retryOnTimeout}${streamLogs ? ', stream logs: on' : ''})`
    );

    // Step 1: Poll queue until executable is available
    let buildNumber: number | null = null;
    while (!buildNumber) {
      if (Date.now() - startTime > maxWaitTime) {
        throw new TimeoutError(`Timed out waiting for build to start (max wait: ${formatDuration(maxWaitTime)})`);
      }

      this.logger.debug(`Checking queue item ${queueId}...`);

      try {
        const queueInfo = await this.statusService.getBuildNumberFromQueue(queueId);

        if (queueInfo && queueInfo.buildNumber) {
          buildNumber = queueInfo.buildNumber;
          this.logger.info(`Build started: #${buildNumber}`);
        } else {
          await this.sleep(pollInterval);
        }
      } catch (error: any) {
        // 处理超时重试
        if (this.isTimeoutError(error) && timeoutRetryCount < retryOnTimeout) {
          timeoutRetryCount++;
          this.logger.warn(
            `Network timeout in queue polling (attempt ${timeoutRetryCount}/${retryOnTimeout}), ` +
            `retrying in ${pollInterval}ms...`
          );
          await this.sleep(pollInterval);
          continue;
        }
        throw error;
      }
    }

    // Step 2: Poll build status until completion
    while (true) {
      if (Date.now() - startTime > maxWaitTime) {
        throw new TimeoutError(`Build timed out after ${formatDuration(maxWaitTime)}`);
      }

      // 增量打印构建日志（progressiveText）；端点不可用等异常只降级一次，不影响状态轮询
      if (streamLogs) {
        try {
          logOffset = await this.streamConsoleDelta(jobName, buildNumber, logOffset);
        } catch (error: any) {
          streamLogs = false;
          this.logger.warn(`Streaming console disabled: ${error.message}`);
        }
      }

      try {
        const status = await this.statusService.getStatus(jobName, buildNumber);

        if (!status.building && status.status !== 'IN_PROGRESS') {
          this.logger.info(`Build completed: ${status.status} (${formatDuration(status.duration)})`);

          if (status.status === 'FAILURE') {
            throw new BuildFailedError(`Build #${buildNumber} failed`, buildNumber);
          }

          if (status.status === 'ABORTED') {
            throw new BuildFailedError(`Build #${buildNumber} was aborted`, buildNumber);
          }

          return {
            queueId,
            url: status.url,
            jobName,
            buildNumber: status.buildNumber,
            status: status.status,
            duration: status.duration,
            artifacts: status.artifacts,
          };
        }

        this.logger.debug(`Build #${buildNumber} still in progress...`);
        await this.sleep(pollInterval);
      } catch (error: any) {
        // 处理超时重试
        if (this.isTimeoutError(error) && timeoutRetryCount < retryOnTimeout) {
          timeoutRetryCount++;
          this.logger.warn(
            `Network timeout in status polling (attempt ${timeoutRetryCount}/${retryOnTimeout}), ` +
            `retrying in ${pollInterval}ms...`
          );
          await this.sleep(pollInterval);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 停止进行中的构建
   */
  async stopBuild(
    jobName: string,
    buildNumber: number,
    options?: { crumbIssuer?: boolean }
  ): Promise<void> {
    if (options?.crumbIssuer !== false) {
      await this.httpClient.initCrumb();
    }

    const url = `/job/${jobName}/${buildNumber}/stop`;
    this.logger.info(`Stopping build: ${jobName} #${buildNumber}`);

    try {
      await this.httpClient.post(url, null);
    } catch (error: any) {
      this.handleBuildTriggerError(error, jobName);
    }
  }

  /**
   * 重试已完成的构建（相当于 Jenkins 页面上的 Retry）
   */
  async retryBuild(
    jobName: string,
    buildNumber: number,
    options?: { crumbIssuer?: boolean }
  ): Promise<BuildTriggerResult> {
    if (options?.crumbIssuer !== false) {
      await this.httpClient.initCrumb();
    }

    const url = `/job/${jobName}/${buildNumber}/retry`;
    this.logger.info(`Retrying build: ${jobName} #${buildNumber}`);

    try {
      const response = await this.httpClient.post(url, null);
      const queueId = this.extractQueueId(response);
      return {
        queueId,
        url: `${this.httpClient.getBaseUrl()}/job/${jobName}/`,
        jobName,
      };
    } catch (error: any) {
      this.handleBuildTriggerError(error, jobName);
    }
  }

  /**
   * 拉取并打印一段构建日志增量（progressiveText），返回新的字节偏移
   */
  private async streamConsoleDelta(
    jobName: string,
    buildNumber: number,
    start: number
  ): Promise<number> {
    const url = `/job/${jobName}/${buildNumber}/progressiveText`;
    const { data, headers } = await this.httpClient.getFull<string>(url, { start });

    if (data) {
      process.stdout.write(data);
    }

    const textSize = parseInt(String(headers['x-text-size'] ?? '0'), 10);
    return Number.isFinite(textSize) && textSize > 0 ? textSize : start;
  }

  /**
   * 触发无参构建
   */
  private async triggerWithoutParameters(jobName: string): Promise<number> {
    const url = `/job/${jobName}/build`;

    try {
      const response = await this.httpClient.post(url, null, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      return this.extractQueueId(response);
    } catch (error: any) {
      this.handleBuildTriggerError(error, jobName);
    }
  }

  /**
   * 触发带参构建
   */
  private async triggerWithParameters(
    jobName: string,
    params: BuildParameters
  ): Promise<number> {
    const url = `/job/${jobName}/buildWithParameters`;
    const hasFileParams = Object.values(params).some(
      (v) => typeof v === 'object' && v !== null && (v as FileParameter).type === 'file'
    );

    try {
      if (hasFileParams) {
        // Use FormData for file parameters
        const formData = await this.prepareFormData(params);
        const response = await this.httpClient.post(url, formData, {
          ...formData.getHeaders(),
        });
        return this.extractQueueId(response);
      } else {
        // Use query string for simple parameters
        const queryParams = this.prepareQueryParams(params);
        const queryString = new URLSearchParams(queryParams as any).toString();
        const fullUrl = `${url}?${queryString}`;

        const response = await this.httpClient.post(fullUrl);
        return this.extractQueueId(response);
      }
    } catch (error: any) {
      this.handleBuildTriggerError(error, jobName);
    }
  }

  /**
   * 准备 FormData (包含文件)
   */
  private async prepareFormData(params: BuildParameters): Promise<FormData> {
    const formData = new FormData();

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'object' && value !== null && (value as FileParameter).type === 'file') {
        const fileParam = value as FileParameter;
        const fileStream = fs.createReadStream(fileParam.path);
        formData.append(key, fileStream);
      } else if (typeof value === 'boolean') {
        formData.append(key, value ? 'true' : 'false');
      } else {
        formData.append(key, String(value));
      }
    }

    return formData;
  }

  /**
   * 准备查询参数
   */
  private prepareQueryParams(params: BuildParameters): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'boolean') {
        result[key] = value ? 'true' : 'false';
      } else if (typeof value === 'string') {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 从响应中提取 Queue ID
   */
  private extractQueueId(response: { data: any; headers: Record<string, string> }): number {
    // Jenkins returns queue ID in the Location header or response body
    const location = response.headers['location'];
    if (location) {
      const match = location.match(/\/queue\/item\/(\d+)/);
      if (match) {
        return parseInt(match[1], 10);
      }
    }

    // Fallback: check response body
    if (typeof response.data === 'object' && response.data !== null) {
      if (response.data.queueId) {
        return response.data.queueId;
      }
    }

    this.logger.warn('Queue ID not found in response');
    return 0;
  }

  /**
   * 处理构建触发错误
   */
  private handleBuildTriggerError(error: any, jobName: string): never {
    if (error.message && error.message.includes('404')) {
      throw new JenkinsError(`Job not found: ${jobName}`, 404);
    }
    throw error;
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 判断错误是否为超时错误（可重试）
   * @param error - 捕获的错误对象
   * @returns 是否为超时错误
   */
  private isTimeoutError(error: any): boolean {
    // 检查错误码
    if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      return true;
    }
    // 检查错误消息（兼容不同错误来源）
    const message = error.message?.toLowerCase() || '';
    return message.includes('etimedout') || message.includes('econnaborted');
  }
}
