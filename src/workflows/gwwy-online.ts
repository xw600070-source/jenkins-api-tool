import { JenkinsClient } from '../client/jenkins-client';
import { JenkinsError } from '../errors';
import { escapeRegExp } from '../utils/helpers';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { downloadToFile } from '../workflow/download';
import { runWorkflow } from '../workflow/run';
import { JOBS, FILE_SERVER_BASE, DOWNLOADS_DIR } from '../workflow/jobs';
import { notify } from '../services/notify-service';
import { parseFlagArgs } from './flag-args';

/**
 * gwwy-uniapp 线上打包工作流
 *
 * 触发 Jenkins 任务 gwwy-uniapp 按指定分支打包，等待构建结束（期间流式打印构建日志）、
 * 从控制台日志提取下载链接、把打包产物下载到 downloads/ 目录。
 * 与本地打包命令 `npm run gwwy`（本机 Git Bash 构建）互为线上/线下对应版本。
 *
 * 用法:
 *   npm run gwwy-online -- --branch <分支名> [--head <提交>]
 */

export interface GwwyOnlineArgs {
  /** 打包分支(必传) */
  branch: string;
  /** 提交 ref(默认 HEAD) */
  head: string;
}

/**
 * 解析命令行参数
 */
export function parseGwwyOnlineArgs(argv: string[]): GwwyOnlineArgs {
  const usage =
    '用法: npm run jenkins -- gwwy-online --branch <分支名> [--head <提交>]\n' +
    '例如: npm run jenkins -- gwwy-online --branch Feature_20260130_chongQingWenLvWei';
  const values = parseFlagArgs(argv, ['--branch', '--head'], usage);

  const branch = values['--branch'];
  if (!branch) {
    throw new JenkinsError(`缺少必传参数 --branch\n${usage}`);
  }

  return { branch, head: values['--head'] ?? 'HEAD' };
}

async function runGwwyOnlineWorkflow(argv: string[]): Promise<void> {
  const { branch, head } = parseGwwyOnlineArgs(argv);
  console.log(`gwwy-uniapp 线上打包: branch=${branch}, head=${head}`);

  const client: JenkinsClient = createClientFromEnv();
  await precheckAuth(client);

  // 触发构建并等待完成（高负载下状态查询超时自动回避重试）
  const result = await client.build(
    JOBS.gwwyUniapp,
    { git_branch: branch, git_head: head },
    {
      wait: true,
      pollInterval: 20000,
      maxWaitTime: 3600000,
      crumbIssuer: true,
      retryOnTimeout: 3,
      streamLogs: true,
    },
  );

  if (!('buildNumber' in result)) {
    // wait:true 理论上不会走到这里，保留兜底
    console.log(`✅ 构建已触发: Queue ID ${result.queueId}`);
    console.log(`  构建页: ${result.url}`);
    return;
  }

  console.log(`\n✅ 构建完成: #${result.buildNumber}`);
  console.log(`  状态: ${result.status}`);
  console.log(`  耗时: ${result.duration}ms`);
  console.log(`  构建页: ${result.url}`);

  // 从控制台日志提取产物下载链接并下载到 downloads/
  console.log('\n=== 下载打包产物 ===');
  const fileServerBase = `${FILE_SERVER_BASE}/gwwy-uniapp-file`;
  const consoleText = await client.getConsoleText(JOBS.gwwyUniapp, result.buildNumber);

  // 优先匹配完整下载链接；控制台若只打印了文件名，则拼出完整 URL
  let downloadUrl = consoleText.match(
    new RegExp(`${escapeRegExp(fileServerBase)}/[^\\s"'<>]+\\.zip`)
  )?.[0];
  if (!downloadUrl) {
    const fileNameMatch = consoleText.match(/gwwy-uniapp_\d{14}\.zip/);
    if (fileNameMatch) {
      downloadUrl = `${fileServerBase}/${fileNameMatch[0]}`;
    }
  }

  if (!downloadUrl) {
    console.warn('  ⚠️ 控制台日志中未找到下载链接（gwwy-uniapp_<时间戳>.zip）');
    return;
  }

  console.log(`  下载地址: ${downloadUrl}`);
  const { outputPath } = await downloadToFile(downloadUrl, DOWNLOADS_DIR);

  notify({
    command: 'gwwy-online',
    success: true,
    buildNumber: result.buildNumber,
    duration: result.duration,
    artifactPath: outputPath,
  });
}

export function gwwyOnlineCommand(argv: string[]): void {
  runWorkflow({ command: 'gwwy-online', main: () => runGwwyOnlineWorkflow(argv) });
}
