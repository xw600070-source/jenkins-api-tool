import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('JENKINS_URL', 'http://jenkins.example.com/');
    vi.stubEnv('JENKINS_USERNAME', 'alice');
    vi.stubEnv('JENKINS_API_TOKEN', 'token123');
    vi.stubEnv('LOG_LEVEL', 'debug');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('从环境变量组装配置并去除 URL 末尾斜杠', async () => {
    const { loadConfig } = await import('./index');
    expect(loadConfig()).toEqual(
      expect.objectContaining({
        url: 'http://jenkins.example.com',
        username: 'alice',
        apiToken: 'token123',
        logLevel: 'debug',
      })
    );
  });

  it('JENKINS_TIMEOUT 数值映射；password 透传', async () => {
    vi.resetModules();
    vi.stubEnv('JENKINS_URL', 'http://jenkins.example.com');
    vi.stubEnv('JENKINS_USERNAME', 'alice');
    vi.stubEnv('JENKINS_PASSWORD', 'pw');
    vi.stubEnv('JENKINS_TIMEOUT', '12345');

    const { loadConfig } = await import('./index');
    const config = loadConfig();
    expect(config.timeout).toBe(12345);
    expect(config.password).toBe('pw');
  });
});
