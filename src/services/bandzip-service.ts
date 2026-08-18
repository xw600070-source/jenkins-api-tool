import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { Logger } from '../utils/logger';
import { formatDuration, formatFileSize, getErrorMessage } from '../utils/helpers';

/**
 * 压缩级别
 */
export type CompressionLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * 压缩格式
 */
export type ArchiveFormat = 'zip' | 'zipx' | 'exe' | 'tar' | 'tgz' | 'lzh' | 'iso' | '7z' | 'gz' | 'xz';

/**
 * 压缩选项
 */
export interface CompressOptions {
  /** 压缩级别 (0: 存储, 1: 最快, 2: 正常, 5: 默认, 9: 最大), 默认 2 */
  level?: CompressionLevel;
  /** 压缩格式, 默认 'zip' */
  format?: ArchiveFormat;
  /** 加密密码 (可选) */
  password?: string;
  /** 是否递归子目录, 默认 true */
  recursive?: boolean;
  /** 是否存储根目录, 默认 true */
  storeRoot?: boolean;
  /** CPU 线程数 (0: 自动), 默认 0 */
  threads?: number;
  /** 是否覆盖已存在的文件, 默认 true */
  overwrite?: boolean;
}

/**
 * 内部使用的完整压缩配置
 */
interface ResolvedCompressOptions {
  level: CompressionLevel;
  format: ArchiveFormat;
  password: string | undefined;
  recursive: boolean;
  storeRoot: boolean;
  threads: number;
  overwrite: boolean;
}

/**
 * 压缩结果
 */
export interface CompressResult {
  /** 压缩包路径 */
  archivePath: string;
  /** 压缩包大小(字节) */
  size: number;
  /** 压缩耗时(ms) */
  duration: number;
  /** 源文件/目录数量 */
  sourceCount: number;
}

/**
 * 解压结果
 */
export interface ExtractResult {
  /** 解压的压缩包路径 */
  archivePath: string;
  /** 解压目标目录 */
  outputDir: string;
  /** 解压耗时(ms) */
  duration: number;
  /** 解压的文件数量 */
  extractedCount: number;
}

/**
 * 解压选项
 */
export interface ExtractOptions {
  /** 解压密码 (可选) */
  password?: string;
  /** 是否覆盖已存在的文件, 默认 true */
  overwrite?: boolean;
  /** 解压目标目录, 默认压缩包所在目录 */
  outputDir?: string;
}

/**
 * Bandizip 压缩服务
 */
export class CompressService {
  private logger: Logger;
  private bzCommand: string;

  constructor(bzCommand: string = 'bz') {
    this.logger = new Logger();
    this.bzCommand = bzCommand;
  }

  /**
   * 压缩文件或目录
   * @param sources 源文件或目录路径列表
   * @param outputPath 输出压缩包路径
   * @param options 压缩选项
   */
  async compress(
    sources: string | string[],
    outputPath: string,
    options: CompressOptions = {}
  ): Promise<CompressResult> {
    const {
      level = 2,
      format = 'zip',
      password,
      recursive = true,
      storeRoot = true,
      threads = 0,
      overwrite = true,
    } = options;

    const sourceList = Array.isArray(sources) ? sources : [sources];

    // 验证源文件/目录是否存在
    for (const source of sourceList) {
      if (!fs.existsSync(source)) {
        throw new Error(`Source not found: ${source}`);
      }
    }

    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 构建命令
    const command = this.buildCommand(sourceList, outputPath, {
      level,
      format,
      password,
      recursive,
      storeRoot,
      threads,
      overwrite,
    });

    this.logger.info(`Compressing ${sourceList.length} source(s) to: ${outputPath}`);
    this.logger.debug(`Command: ${command}`);

    const startTime = Date.now();

    try {
      await this.executeCommand(command);

      const duration = Date.now() - startTime;
      const size = fs.statSync(outputPath).size;

      this.logger.info(
        `Compression complete: ${path.basename(outputPath)} (${formatFileSize(size)}, ${formatDuration(duration)})`
      );

      return {
        archivePath: outputPath,
        size,
        duration,
        sourceCount: sourceList.length,
      };
    } catch (error) {
      throw new Error(`Compression failed: ${getErrorMessage(error)}`, { cause: error });
    }
  }

  /**
   * 解压文件
   * @param archivePath 压缩包路径
   * @param options 解压选项
   */
  async extract(
    archivePath: string,
    options: ExtractOptions = {}
  ): Promise<ExtractResult> {
    const {
      password,
      overwrite = true,
      outputDir,
    } = options;

    // 验证压缩包是否存在
    if (!fs.existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`);
    }

    // 确定解压目标目录
    const targetDir = outputDir || path.dirname(archivePath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 构建解压命令
    const command = this.buildExtractCommand(archivePath, targetDir, {
      password,
      overwrite,
    });

    this.logger.info(`Extracting: ${path.basename(archivePath)} to: ${targetDir}`);
    this.logger.debug(`Command: ${command}`);

    const startTime = Date.now();

    try {
      await this.executeCommand(command);

      const duration = Date.now() - startTime;

      // 统计解压的文件数量（简单估算）
      const extractedCount = this.countFilesInDir(targetDir);

      this.logger.info(
        `Extraction complete: ${extractedCount} file(s) extracted (${formatDuration(duration)})`
      );

      return {
        archivePath,
        outputDir: targetDir,
        duration,
        extractedCount,
      };
    } catch (error) {
      throw new Error(`Extraction failed: ${getErrorMessage(error)}`, { cause: error });
    }
  }

  /**
   * 构建 bz 命令
   */
  private buildCommand(
    sources: string[],
    outputPath: string,
    options: ResolvedCompressOptions
  ): string {
    const parts: string[] = [this.bzCommand];

    // 命令: c (创建新压缩包)
    parts.push('c');

    // 开关参数
    const switches: string[] = [];

    // 压缩级别
    switches.push(`-l:${options.level}`);

    // 压缩格式
    switches.push(`-fmt:${options.format}`);

    // 递归子目录
    if (options.recursive) {
      switches.push('-r');
    }

    // 存储根目录
    switches.push(`-storeroot:${options.storeRoot ? 'yes' : 'no'}`);

    // CPU 线程数
    switches.push(`-t:${options.threads}`);

    // 覆盖已存在的文件
    if (options.overwrite) {
      switches.push('-aoa');
    }

    // 密码
    if (options.password) {
      switches.push(`-p:${options.password}`);
    }

    parts.push(...switches);

    // 输出路径
    parts.push(`"${outputPath}"`);

    // 源文件/目录
    for (const source of sources) {
      parts.push(`"${source}"`);
    }

    return parts.join(' ');
  }

  /**
   * 构建解压命令
   */
  private buildExtractCommand(
    archivePath: string,
    outputDir: string,
    options: { password?: string; overwrite: boolean }
  ): string {
    const parts: string[] = [this.bzCommand];

    // 命令: x (解压)
    parts.push('x');

    // 开关参数
    const switches: string[] = [];

    // 覆盖已存在的文件
    if (options.overwrite) {
      switches.push('-aoa');
    }

    // 密码
    if (options.password) {
      switches.push(`-p:${options.password}`);
    }

    parts.push(...switches);

    // 输出目录
    parts.push(`-o:${outputDir}`);

    // 压缩包路径
    parts.push(`"${archivePath}"`);

    return parts.join(' ');
  }

  /**
   * 统计目录中的文件数量
   */
  private countFilesInDir(dirPath: string): number {
    let count = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          count += this.countFilesInDir(fullPath);
        } else {
          count++;
        }
      }
    } catch {
      this.logger.warn(`Failed to count files in ${dirPath}`);
    }
    return count;
  }

  /**
   * 执行命令
   */
  private executeCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          this.logger.error(`Command failed: ${stderr || error.message}`);
          reject(new Error(stderr || error.message));
        } else {
          if (stdout) {
            this.logger.debug(stdout);
          }
          resolve();
        }
      });
    });
  }
}
