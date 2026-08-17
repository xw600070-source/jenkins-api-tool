import { describe, it, expect, vi } from 'vitest';
import { StatusService } from './status-service';
import { HttpClient } from './http-client';

function createService() {
  const httpClient = { get: vi.fn(), getFull: vi.fn() };
  const service = new StatusService(httpClient as unknown as HttpClient);
  return { service, httpClient };
}

describe('StatusService.getStatus', () => {
  it('解析构建状态/产物/原因/参数', async () => {
    const { service, httpClient } = createService();

    httpClient.get.mockResolvedValueOnce({
      number: 42,
      result: 'SUCCESS',
      building: false,
      url: 'http://x/job/j/42/',
      displayName: '#42',
      description: 'desc',
      timestamp: 1_700_000_000_000,
      duration: 5000,
      estimatedDuration: 4000,
      artifacts: [{ fileName: 'a.zip', relativePath: 'out/a.zip' }],
      actions: [
        { causes: [{ shortDescription: 'Started by user', userId: 'u1', userName: 'Alice' }] },
        { parameters: [{ name: 'git_branch', value: 'Feature_x' }] },
      ],
    });

    const result = await service.getStatus('j', 42);

    expect(httpClient.get).toHaveBeenCalledWith('/job/j/42/api/json');
    expect(result.status).toBe('SUCCESS');
    expect(result.building).toBe(false);
    expect(result.buildNumber).toBe(42);
    expect(result.consoleUrl).toBe('http://x/job/j/42/consoleText');
    expect(result.artifacts).toEqual([{ fileName: 'a.zip', relativePath: 'out/a.zip' }]);
    expect(result.causes).toEqual([
      { shortDescription: 'Started by user', userId: 'u1', userName: 'Alice' },
    ]);
    expect(result.parameters).toEqual([{ name: 'git_branch', value: 'Feature_x' }]);
  });

  it("buildNumber='last' 访问 lastBuild", async () => {
    const { service, httpClient } = createService();
    httpClient.get.mockResolvedValueOnce({ number: 1, result: null, building: true, actions: [] });

    const result = await service.getStatus('j', 'last');

    expect(httpClient.get).toHaveBeenCalledWith('/job/j/lastBuild/api/json');
    expect(result.status).toBe('IN_PROGRESS');
  });

  it('未知结果映射为 UNKNOWN', async () => {
    const { service, httpClient } = createService();
    httpClient.get.mockResolvedValueOnce({ number: 1, result: 'WEIRD', building: false, actions: [] });

    const result = await service.getStatus('j', 1);
    expect(result.status).toBe('UNKNOWN');
  });
});

describe('StatusService.listJobs', () => {
  it('根目录列出 jobs', async () => {
    const { service, httpClient } = createService();
    httpClient.get.mockResolvedValueOnce({
      jobs: [
        { name: 'orange-aliyun', url: 'http://x/job/orange-aliyun/', color: 'blue' },
        { name: 'gwwy-uniapp', url: 'http://x/job/gwwy-uniapp/', color: 'red_anime' },
      ],
    });

    const jobs = await service.listJobs();

    expect(httpClient.get).toHaveBeenCalledWith('/api/json', { tree: 'jobs[name,url,color]' });
    expect(jobs).toEqual([
      { name: 'orange-aliyun', url: 'http://x/job/orange-aliyun/', color: 'blue' },
      { name: 'gwwy-uniapp', url: 'http://x/job/gwwy-uniapp/', color: 'red_anime' },
    ]);
  });

  it("指定 folder 时走 /job/<folder>/api/json", async () => {
    const { service, httpClient } = createService();
    httpClient.get.mockResolvedValueOnce({ jobs: [] });

    await service.listJobs('web');

    expect(httpClient.get).toHaveBeenCalledWith('/job/web/api/json', {
      tree: 'jobs[name,url,color]',
    });
  });
});

describe('StatusService.getQueue', () => {
  it('映射队列项字段', async () => {
    const { service, httpClient } = createService();
    httpClient.get.mockResolvedValueOnce({
      items: [
        {
          id: 12,
          why: '等待空闲执行器',
          inQueueSince: 1_700_000_000_000,
          task: { name: 'gwwy-uniapp', url: 'http://x/job/gwwy-uniapp/' },
          executable: { number: 88 },
        },
        { id: 13, task: { name: 'orange-aliyun' } },
      ],
    });

    const items = await service.getQueue();

    expect(httpClient.get).toHaveBeenCalledWith('/queue/api/json');
    expect(items).toEqual([
      {
        id: 12,
        why: '等待空闲执行器',
        taskName: 'gwwy-uniapp',
        taskUrl: 'http://x/job/gwwy-uniapp/',
        buildNumber: 88,
        queuedSince: 1_700_000_000_000,
      },
      { id: 13, why: undefined, taskName: 'orange-aliyun', taskUrl: undefined, buildNumber: undefined, queuedSince: undefined },
    ]);
  });
});
