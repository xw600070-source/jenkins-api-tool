import { HttpClient } from './http-client';
import { BuildStatusResult, BuildStatus, ArtifactInfo, BuildCause, Parameter, JobInfo, QueueItemInfo } from '../types';
import { Logger } from '../utils/logger';

/** /job/<job>/<build>/api/json 响应结构 */
interface BuildApiJson {
  result: string | null;
  building: boolean;
  number: number;
  displayName?: string;
  description?: string;
  timestamp?: number;
  duration?: number;
  estimatedDuration?: number;
  url?: string;
  artifacts?: Array<{ fileName: string; relativePath: string }>;
  actions?: Array<{
    causes?: Array<{ shortDescription: string; userId?: string; userName?: string }>;
    parameters?: Array<{ name: string; value: string | boolean }>;
  }>;
}

/** /queue/item/<id>/api/json 响应结构 */
interface QueueItem {
  id: number;
  executable?: {
    number: number;
    url: string;
  };
  why?: string;
}

/** 根目录 / folder 的 api/json 响应结构（jobs 列表） */
interface JobsApiJson {
  jobs?: Array<{ name: string; url: string; color?: string }>;
}

/** /queue/api/json 响应结构 */
interface QueueApiJson {
  items?: Array<{
    id: number;
    why?: string;
    task?: { name?: string; url?: string };
    executable?: { number?: number };
    inQueueSince?: number;
  }>;
}

export class StatusService {
  private httpClient: HttpClient;
  private logger: Logger;

  constructor(httpClient: HttpClient) {
    this.httpClient = httpClient;
    this.logger = new Logger();
  }

  /**
   * 查询构建状态
   */
  async getStatus(jobName: string, buildNumber: number | 'last'): Promise<BuildStatusResult> {
    const buildPath = buildNumber === 'last' ? 'lastBuild' : String(buildNumber);
    const url = `/job/${jobName}/${buildPath}/api/json`;

    this.logger.debug(`Fetching build status: ${url}`);

    const data = await this.httpClient.get<BuildApiJson>(url);
    return this.parseBuildStatus(data, jobName);
  }

  /**
   * 通过队列 ID 获取构建编号
   */
  async getBuildNumberFromQueue(queueId: number): Promise<{ buildNumber: number; jobName: string } | null> {
    const url = `/queue/item/${queueId}/api/json`;

    this.logger.debug(`Checking queue item: ${url}`);

    const data: QueueItem = await this.httpClient.get(url);

    if (data.executable) {
      const urlParts = data.executable.url.split('/');
      const jobName = urlParts[urlParts.length - 3] || '';
      return {
        buildNumber: data.executable.number,
        jobName,
      };
    }

    return null;
  }

  /**
   * 列出 job（根目录或指定 folder，只列一层）
   */
  async listJobs(folder?: string): Promise<JobInfo[]> {
    const base = folder ? `/job/${folder}` : '';
    const url = `${base}/api/json`;

    this.logger.debug(`Listing jobs: ${url}`);

    const data = await this.httpClient.get<JobsApiJson>(url, { tree: 'jobs[name,url,color]' });

    return (data.jobs || []).map((job) => ({
      name: job.name,
      url: job.url,
      color: job.color || 'notbuilt',
    }));
  }

  /**
   * 查看构建队列
   */
  async getQueue(): Promise<QueueItemInfo[]> {
    const url = '/queue/api/json';

    this.logger.debug(`Fetching queue: ${url}`);

    const data = await this.httpClient.get<QueueApiJson>(url);

    return (data.items || []).map((item) => ({
      id: item.id,
      why: item.why,
      taskName: item.task?.name,
      taskUrl: item.task?.url,
      buildNumber: item.executable?.number,
      queuedSince: item.inQueueSince,
    }));
  }

  /**
   * 解析 Jenkins API 响应为 BuildStatusResult
   */
  private parseBuildStatus(data: BuildApiJson, jobName: string): BuildStatusResult {
    const status = this.mapBuildStatus(data.result, data.building);
    const artifacts: ArtifactInfo[] = (data.artifacts || []).map((a) => ({
      fileName: a.fileName,
      relativePath: a.relativePath,
    }));

    const actions = data.actions || [];
    const causes: BuildCause[] = [];
    const parameters: Parameter[] = [];

    for (const action of actions) {
      if (action.causes) {
        for (const cause of action.causes) {
          causes.push({
            shortDescription: cause.shortDescription,
            userId: cause.userId,
            userName: cause.userName,
          });
        }
      }

      if (action.parameters) {
        for (const param of action.parameters) {
          parameters.push({
            name: param.name,
            value: param.value,
          });
        }
      }
    }

    const url = data.url || '';

    return {
      jobName,
      buildNumber: data.number,
      status,
      displayName: data.displayName || `#${data.number}`,
      description: data.description,
      timestamp: data.timestamp || 0,
      duration: data.duration || 0,
      estimatedDuration: data.estimatedDuration,
      building: data.building || false,
      url,
      consoleUrl: `${url}consoleText`,
      artifacts,
      causes,
      parameters,
    };
  }

  /**
   * 映射 Jenkins 状态到 BuildStatus
   */
  private mapBuildStatus(result: string | null, building: boolean): BuildStatus {
    if (building) {
      return 'IN_PROGRESS';
    }

    switch (result) {
      case 'SUCCESS':
        return 'SUCCESS';
      case 'FAILURE':
        return 'FAILURE';
      case 'ABORTED':
        return 'ABORTED';
      case 'UNSTABLE':
        return 'UNSTABLE';
      case 'NOT_BUILT':
        return 'NOT_BUILT';
      case null:
      case undefined:
        return 'UNKNOWN';
      default:
        return 'UNKNOWN';
    }
  }
}
