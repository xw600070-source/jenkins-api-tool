import * as path from 'path';
import * as fs from 'fs';
import { HttpClient } from './http-client';
import { StatusService } from './status-service';
import { DownloadResult, DownloadAllResult, DownloadOptions, WorkspaceFileInfo } from '../types';
import { Logger } from '../utils/logger';
import { formatFileSize, getErrorMessage } from '../utils/helpers';

export class DownloadService {
  private httpClient: HttpClient;
  private statusService: StatusService;
  private logger: Logger;

  constructor(httpClient: HttpClient, statusService: StatusService) {
    this.httpClient = httpClient;
    this.statusService = statusService;
    this.logger = new Logger();
  }

  /**
   * 下载单个产物
   */
  async downloadArtifact(
    jobName: string,
    buildNumber: number,
    artifactPath: string,
    outputDir: string
  ): Promise<DownloadResult> {
    this.logger.info(`Downloading artifact: ${artifactPath}`);

    const url = `/job/${jobName}/${buildNumber}/artifact/${artifactPath}`;
    const fileName = path.basename(artifactPath);
    const outputPath = path.join(outputDir, fileName);

    this.ensureDir(outputDir);

    const startTime = Date.now();

    await this.httpClient.download(
      url,
      outputPath,
      (progress, downloaded, total) => {
        if (progress > 0) {
          this.logger.debug(
            `Download progress: ${formatFileSize(downloaded)} / ${formatFileSize(total)} (${(progress * 100).toFixed(1)}%)`
          );
        }
      }
    );

    const duration = Date.now() - startTime;
    const size = fs.statSync(outputPath).size;

    this.logger.info(`Downloaded: ${fileName} (${formatFileSize(size)}, ${duration}ms)`);

    return {
      fileName,
      localPath: outputPath,
      size,
      duration,
      source: 'artifact',
    };
  }

  /**
   * 下载所有产物
   */
  async downloadAllArtifacts(
    jobName: string,
    buildNumber: number,
    outputDir: string
  ): Promise<DownloadAllResult> {
    this.logger.info(`Fetching artifact list for ${jobName} #${buildNumber}`);

    const status = await this.statusService.getStatus(jobName, buildNumber);

    if (status.artifacts.length === 0) {
      this.logger.warn('No artifacts found for this build');
      return {
        total: 0,
        success: 0,
        failed: 0,
        results: [],
      };
    }

    this.logger.info(`Found ${status.artifacts.length} artifact(s)`);
    this.ensureDir(outputDir);

    const results: DownloadResult[] = [];
    let success = 0;
    let failed = 0;

    for (const artifact of status.artifacts) {
      try {
        const result = await this.downloadArtifact(jobName, buildNumber, artifact.relativePath, outputDir);
        results.push(result);
        success++;
      } catch (error) {
        this.logger.error(`Failed to download ${artifact.fileName}: ${getErrorMessage(error)}`);
        failed++;
      }
    }

    this.logger.info(`Download complete: ${success} succeeded, ${failed} failed`);

    return {
      total: status.artifacts.length,
      success,
      failed,
      results,
    };
  }

  /**
   * 从 workspace 下载单个文件
   */
  async downloadFromWorkspace(
    jobName: string,
    buildNumber: number | undefined,
    filePath: string,
    outputDir: string
  ): Promise<DownloadResult> {
    this.logger.info(`Downloading from workspace: ${filePath}`);

    const buildSegment = buildNumber ? `/${buildNumber}` : '';
    const url = `/job/${jobName}${buildSegment}/ws/${filePath}`;
    const fileName = path.basename(filePath);
    const outputPath = path.join(outputDir, fileName);

    this.ensureDir(path.dirname(outputPath));

    const startTime = Date.now();

    await this.httpClient.download(
      url,
      outputPath,
      (progress, downloaded, total) => {
        if (progress > 0) {
          this.logger.debug(
            `Download progress: ${formatFileSize(downloaded)} / ${formatFileSize(total)} (${(progress * 100).toFixed(1)}%)`
          );
        }
      }
    );

    const duration = Date.now() - startTime;
    const size = fs.statSync(outputPath).size;

    this.logger.info(`Downloaded: ${fileName} (${formatFileSize(size)}, ${duration}ms)`);

    return {
      fileName,
      localPath: outputPath,
      size,
      duration,
      source: 'workspace',
    };
  }

  /**
   * 从 workspace 下载所有匹配文件
   */
  async downloadAllFromWorkspace(
    jobName: string,
    buildNumber: number | undefined,
    outputDir: string,
    options: DownloadOptions = {}
  ): Promise<DownloadAllResult> {
    const { workspacePath = '', pattern, maxDepth = 10 } = options;

    const buildSegment = buildNumber ? ` #${buildNumber}` : ' (current)';
    this.logger.info(`Fetching workspace file list for ${jobName}${buildSegment}`);

    const files = await this.listWorkspaceFiles(jobName, buildNumber, workspacePath, maxDepth);

    // 根据 pattern 过滤文件
    const matchedFiles = pattern ? this.filterFiles(files, pattern) : files;

    if (matchedFiles.length === 0) {
      this.logger.warn('No files found matching criteria in workspace');
      return {
        total: 0,
        success: 0,
        failed: 0,
        results: [],
      };
    }

    this.logger.info(`Found ${matchedFiles.length} file(s) to download`);
    this.ensureDir(outputDir);

    const results: DownloadResult[] = [];
    let success = 0;
    let failed = 0;

    for (const file of matchedFiles) {
      try {
        // 保持目录结构
        const relativeDir = path.dirname(file.relativePath);
        const fileOutputDir = relativeDir === '.' ? outputDir : path.join(outputDir, relativeDir);

        const result = await this.downloadFromWorkspace(
          jobName,
          buildNumber,
          file.relativePath,
          fileOutputDir
        );
        results.push(result);
        success++;
      } catch (error) {
        this.logger.error(`Failed to download ${file.relativePath}: ${getErrorMessage(error)}`);
        failed++;
      }
    }

    this.logger.info(`Download complete: ${success} succeeded, ${failed} failed`);

    return {
      total: matchedFiles.length,
      success,
      failed,
      results,
    };
  }

  /**
   * 递归列出 workspace 文件
   */
  private async listWorkspaceFiles(
    jobName: string,
    buildNumber: number | undefined,
    basePath: string,
    maxDepth: number,
    currentDepth: number = 0
  ): Promise<WorkspaceFileInfo[]> {
    if (currentDepth >= maxDepth) {
      this.logger.warn(`Max depth (${maxDepth}) reached for ${basePath}`);
      return [];
    }

    const files = await this.httpClient.getWorkspaceFileList(jobName, buildNumber, basePath);
    const allFiles: WorkspaceFileInfo[] = [];

    for (const file of files) {
      if (file.isDirectory) {
        // 递归获取子目录
        const subFiles = await this.listWorkspaceFiles(
          jobName,
          buildNumber,
          file.relativePath,
          maxDepth,
          currentDepth + 1
        );
        allFiles.push(...subFiles);
      } else {
        allFiles.push(file);
      }
    }

    return allFiles;
  }

  /**
   * 根据 glob 模式过滤文件
   * 支持简单的通配符模式
   */
  private filterFiles(files: WorkspaceFileInfo[], pattern: string): WorkspaceFileInfo[] {
    const regex = this.globToRegex(pattern);
    return files.filter(file => regex.test(file.name) || regex.test(file.relativePath));
  }

  /**
   * 将 glob 模式转换为正则表达式
   */
  private globToRegex(glob: string): RegExp {
    // 转义正则特殊字符（除了 * 和 **）
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    // 将 ** 转换为 .*
    const withDoubleStar = escaped.replace(/\*\*/g, '.*');
    // 将 * 转换为 [^/]*（匹配除 / 外的任意字符）
    const withSingleStar = withDoubleStar.replace(/\*/g, '[^/]*');
    return new RegExp(`^${withSingleStar}$`);
  }

  /**
   * 确保目录存在
   */
  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }
}
