import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BuildService } from './build-service';
import { HttpClient } from './http-client';
import { StatusService } from './status-service';
import { BuildFailedError, TimeoutError } from '../errors';
import type { BuildStatusResult } from '../types';

/** 构造已结束构建的状态结果 */
function finishedStatus(status: string, buildNumber = 42): BuildStatusResult {
  return {
    jobName: 'web/job/demo',
    buildNumber,
    status: status as BuildStatusResult['status'],
    displayName: `#${buildNumber}`,
    timestamp: 0,
    duration: 120_000,
    building: false,
    url: `http://x/job/demo/${buildNumber}/`,
    consoleUrl: `http://x/job/demo/${buildNumber}/consoleText`,
    artifacts: [],
    causes: [],
    parameters: [],
  };
}

function inProgressStatus(buildNumber = 42): BuildStatusResult {
  return { ...finishedStatus('IN_PROGRESS', buildNumber), building: true };
}

function createService() {
  const statusService = {
    getBuildNumberFromQueue: vi.fn(),
    getStatus: vi.fn(),
  };
  const httpClient = {
    getBaseUrl: () => 'http://x',
    initCrumb: vi.fn(),
    post: vi.fn(),
    getFull: vi.fn(),
  };
  const service = new BuildService(
    httpClient as unknown as HttpClient,
    statusService as unknown as StatusService
  );
  return { service, statusService, httpClient };
}

describe('BuildService.waitForCompletion', () => {
  it('排队 → 启动 → 成功', async () => {
    const { service, statusService } = createService();

    statusService.getBuildNumberFromQueue.mockResolvedValue({ buildNumber: 42, jobName: 'j' });
    statusService.getStatus.mockResolvedValue(finishedStatus('SUCCESS'));

    const result = await service.waitForCompletion('web/job/demo', 1, {
      pollInterval: 1,
      maxWaitTime: 1000,
    });

    expect(result.buildNumber).toBe(42);
    expect(result.status).toBe('SUCCESS');
    expect(result.duration).toBe(120_000);
  });

  it('构建 FAILURE 抛 BuildFailedError（带构建号）', async () => {
    const { service, statusService } = createService();

    statusService.getBuildNumberFromQueue.mockResolvedValue({ buildNumber: 7, jobName: 'j' });
    statusService.getStatus.mockResolvedValue(finishedStatus('FAILURE', 7));

    await expect(
      service.waitForCompletion('j', 1, { pollInterval: 1, maxWaitTime: 1000 })
    ).rejects.toMatchObject({ name: 'BuildFailedError', buildNumber: 7 });
  });

  it('排队期间网络超时自动回避重试后恢复', async () => {
    const { service, statusService } = createService();

    statusService.getBuildNumberFromQueue
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))
      .mockResolvedValueOnce({ buildNumber: 42, jobName: 'j' });
    statusService.getStatus.mockResolvedValue(finishedStatus('SUCCESS'));

    const result = await service.waitForCompletion('j', 1, {
      pollInterval: 1,
      maxWaitTime: 2000,
      retryOnTimeout: 3,
    });

    expect(result.buildNumber).toBe(42);
    expect(statusService.getBuildNumberFromQueue).toHaveBeenCalledTimes(3);
  });

  it('总等待超时抛 TimeoutError', async () => {
    const { service, statusService } = createService();
    // 队列永远不返回 executable
    statusService.getBuildNumberFromQueue.mockResolvedValue(null);

    await expect(
      service.waitForCompletion('j', 1, { pollInterval: 2, maxWaitTime: 30 })
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('streamLogs 开启时增量打印日志（按 x-text-size 推进偏移）', async () => {
    const { service, statusService, httpClient } = createService();

    statusService.getBuildNumberFromQueue.mockResolvedValue({ buildNumber: 42, jobName: 'j' });
    statusService.getStatus
      .mockResolvedValueOnce(inProgressStatus())
      .mockResolvedValueOnce(finishedStatus('SUCCESS'));

    httpClient.getFull
      .mockResolvedValueOnce({
        data: '[npm] building...\n',
        headers: { 'x-text-size': '20', 'x-more-data': 'true' },
      })
      .mockResolvedValueOnce({
        data: '[npm] done\n',
        headers: { 'x-text-size': '31', 'x-more-data': 'false' },
      });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const result = await service.waitForCompletion('j', 1, {
        pollInterval: 1,
        maxWaitTime: 1000,
        streamLogs: true,
      });

      expect(result.status).toBe('SUCCESS');
      // 第二次拉取使用第一次返回的偏移
      expect(httpClient.getFull).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.objectContaining({ start: 20 })
      );
      const written = writeSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('[npm] building...');
      expect(written).toContain('[npm] done');
    } finally {
      writeSpy.mockRestore();
    }
  });
});

describe('BuildService.stopBuild / retryBuild', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stopBuild 先取 crumb 再 POST stop', async () => {
    const { service, httpClient } = createService();
    httpClient.post.mockResolvedValue({ data: {}, headers: {} });

    await service.stopBuild('j', 5);

    expect(httpClient.initCrumb).toHaveBeenCalledTimes(1);
    expect(httpClient.post).toHaveBeenCalledWith('/job/j/5/stop', null);
  });

  it('retryBuild 从 Location 头提取 queueId', async () => {
    const { service, httpClient } = createService();
    httpClient.post.mockResolvedValue({
      data: {},
      headers: { location: 'http://x/queue/item/99/' },
    });

    const result = await service.retryBuild('j', 5);

    expect(result.queueId).toBe(99);
    expect(result.url).toBe('http://x/job/j/');
  });
});
