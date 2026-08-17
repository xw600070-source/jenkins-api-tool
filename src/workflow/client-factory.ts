import { JenkinsClient } from '../client/jenkins-client';
import { loadConfig } from '../config';
import { JenkinsError } from '../errors';

/**
 * 从环境变量（.env）创建 Jenkins 客户端
 *
 * 复用 loadConfig() 组装配置；必填项缺失时抛出带可操作提示的错误，
 * 由 runWorkflow 统一兜底打印并以退出码 1 结束。
 */
export function createClientFromEnv(): JenkinsClient {
  const config = loadConfig();

  if (!config.url) {
    throw new JenkinsError('缺少 JENKINS_URL，请检查 .env 配置（可参考 .env.example）');
  }
  if (!config.username) {
    throw new JenkinsError('缺少 JENKINS_USERNAME，请检查 .env 配置（可参考 .env.example）');
  }
  if (!config.apiToken && !config.password) {
    throw new JenkinsError(
      '缺少认证凭据：JENKINS_API_TOKEN 或 JENKINS_PASSWORD 需至少配置一项'
    );
  }

  return new JenkinsClient({
    ...config,
    url: config.url,
    username: config.username,
  });
}

/**
 * 认证预检：成功打印确认信息，失败打印原因并以退出码 1 结束
 */
export async function precheckAuth(client: JenkinsClient): Promise<void> {
  const auth = await client.verifyAuth();
  if (!auth.authenticated) {
    console.error('❌ 认证失败，请检查 JENKINS_URL / JENKINS_USERNAME / JENKINS_API_TOKEN');
    process.exit(1);
  }
  console.log(`✅ 认证成功：${auth.user} (Jenkins 版本：${auth.version || '未知'})`);
}
