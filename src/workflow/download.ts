import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { NetworkError } from '../errors';
import { formatFileSize } from '../utils/helpers';

export interface DownloadToFileOptions {
  /** 网络错误/大小校验失败的重试次数，默认 3 */
  retries?: number;
  /** 重试间隔(ms)，默认 2000 */
  retryDelayMs?: number;
  /** 进度回调；不传时默认在终端单行刷新显示 */
  onProgress?: (downloaded: number, total: number) => void;
}

export interface DownloadToFileResult {
  /** 最终文件路径（重试期间写 .part，成功后 rename） */
  outputPath: string;
  /** 文件大小(字节) */
  size: number;
  /** 下载耗时(ms) */
  duration: number;
}

/** 默认进度显示：单行刷新，节流至 1s 一次 */
function createDefaultProgressPrinter(): (downloaded: number, total: number) => void {
  let lastPrintAt = 0;
  return (downloaded, total) => {
    const now = Date.now();
    if (now - lastPrintAt < 1000 && total > 0 && downloaded < total) return;
    lastPrintAt = now;
    if (total > 0) {
      const percent = Math.floor((downloaded / total) * 100);
      process.stdout.write(`\r  下载中 ${percent}% (${formatFileSize(downloaded)} / ${formatFileSize(total)})`);
    } else {
      process.stdout.write(`\r  下载中 ${formatFileSize(downloaded)}`);
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 从 URL 提取文件名（处理 percent-encoding） */
export function fileNameFromUrl(url: string): string {
  const raw = path.basename(new URL(url).pathname);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * 下载文件到指定目录（带进度显示、失败重试、大小校验）
 *
 * - 写入 `<文件名>.part`，成功后 rename 为正式文件名，避免中断留下半截成品
 * - 响应含 content-length 时，最终字节数不一致视为失败并重试
 * - 重试耗尽抛 NetworkError
 */
export async function downloadToFile(
  url: string,
  outputDir: string,
  options?: DownloadToFileOptions
): Promise<DownloadToFileResult> {
  const retries = options?.retries ?? 3;
  const retryDelayMs = options?.retryDelayMs ?? 2000;
  const onProgress = options?.onProgress ?? createDefaultProgressPrinter();

  fs.mkdirSync(outputDir, { recursive: true });

  const fileName = fileNameFromUrl(url);
  const outputPath = path.join(outputDir, fileName);
  const partPath = `${outputPath}.part`;

  const startTime = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      console.log(`  ⚠️ 下载失败，${retryDelayMs / 1000}s 后重试 (${attempt}/${retries})...`);
      await sleep(retryDelayMs);
    }

    try {
      const size = await downloadOnce(url, partPath, onProgress);
      fs.renameSync(partPath, outputPath);
      onProgress(size, size);
      if (options?.onProgress === undefined) process.stdout.write('\n');
      console.log(`  ✅ 已下载: ${outputPath} (${formatFileSize(size)})`);
      return { outputPath, size, duration: Date.now() - startTime };
    } catch (error) {
      lastError = error;
    }
  }

  // 重试耗尽：清理残留的 .part，避免留下半截文件
  try {
    fs.rmSync(partPath, { force: true });
  } catch {
    // 清理失败不影响报错
  }

  throw new NetworkError(
    `下载失败（已重试 ${retries} 次）: ${url} — ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}
/** 单次下载，返回写入字节数；流错误 / 大小不符时抛错 */
async function downloadOnce(
  url: string,
  partPath: string,
  onProgress: (downloaded: number, total: number) => void
): Promise<number> {
  const response = await axios.get(url, {
    responseType: 'stream',
    // 下载走文件服务器静态目录，无需 Jenkins 认证头
  });

  const expectedBytes = parseInt(String(response.headers['content-length'] || '0'), 10);

  return new Promise<number>((resolve, reject) => {
    let downloaded = 0;
    const writer = fs.createWriteStream(partPath);

    response.data.on('data', (chunk: Buffer) => {
      downloaded += chunk.length;
      onProgress(downloaded, expectedBytes);
    });

    response.data.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', () => {
      if (expectedBytes > 0 && downloaded !== expectedBytes) {
        reject(new Error(`大小校验失败: 期望 ${expectedBytes} 字节, 实际 ${downloaded} 字节`));
        return;
      }
      resolve(downloaded);
    });

    response.data.pipe(writer);
  });
}
