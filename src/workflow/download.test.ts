import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

import { downloadToFile, fileNameFromUrl } from './download';

const axiosGet = vi.mocked(axios.get);

/** 构造假的 axios stream 响应 */
function streamResponse(chunks: string[], contentLength?: number) {
  const data = Readable.from(chunks.map((c) => Buffer.from(c)));
  return {
    data,
    headers: contentLength !== undefined ? { 'content-length': String(contentLength) } : {},
  };
}

describe('fileNameFromUrl', () => {
  it('取路径最后一段并解码', () => {
    expect(fileNameFromUrl('http://x:2004/files/orange-patch-20260817120000.zip')).toBe(
      'orange-patch-20260817120000.zip'
    );
    expect(fileNameFromUrl('http://x/a%20b.zip')).toBe('a b.zip');
  });
});

describe('downloadToFile', () => {
  let dir: string;

  beforeEach(() => {
    axiosGet.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('成功下载：写正式文件、.part 已清理、回调收到进度', async () => {
    axiosGet.mockResolvedValueOnce(streamResponse(['hello ', 'world'], 11) as any);

    const onProgress = vi.fn();
    const result = await downloadToFile('http://x/a.zip', dir, {
      onProgress,
      retryDelayMs: 1,
    });

    expect(result.size).toBe(11);
    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(fs.existsSync(`${result.outputPath}.part`)).toBe(false);
    expect(fs.readFileSync(result.outputPath, 'utf-8')).toBe('hello world');
    expect(onProgress).toHaveBeenCalledWith(11, 11);
  });

  it('网络错误后重试成功', async () => {
    axiosGet
      .mockRejectedValueOnce(new Error('socket hang up') as any)
      .mockRejectedValueOnce(new Error('ECONNRESET') as any)
      .mockResolvedValueOnce(streamResponse(['ok'], 2) as any);

    const result = await downloadToFile('http://x/a.zip', dir, {
      retries: 2,
      retryDelayMs: 1,
      onProgress: () => {},
    });

    expect(axiosGet).toHaveBeenCalledTimes(3);
    expect(result.size).toBe(2);
  });

  it('大小校验失败耗尽重试后抛 NetworkError', async () => {
    // content-length 声明 10，实际只有 5 字节 → 每次都校验失败
    axiosGet.mockResolvedValue(streamResponse(['hello'], 10) as any);

    await expect(
      downloadToFile('http://x/a.zip', dir, { retries: 1, retryDelayMs: 1, onProgress: () => {} })
    ).rejects.toMatchObject({ name: 'NetworkError', statusCode: undefined });

    expect(axiosGet).toHaveBeenCalledTimes(2); // 1 次原始 + 1 次重试
    expect(fs.existsSync(path.join(dir, 'a.zip'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'a.zip.part'))).toBe(false); // 用例结束 afterEach 清理临时目录
  });

  it('目录不存在时自动创建', async () => {
    const nested = path.join(dir, 'a', 'b');
    axiosGet.mockResolvedValueOnce(streamResponse(['x'], 1) as any);

    const result = await downloadToFile('http://x/a.zip', nested, {
      retryDelayMs: 1,
      onProgress: () => {},
    });

    expect(fs.existsSync(result.outputPath)).toBe(true);
  });
});
