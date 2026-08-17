import * as path from 'path';
import { JenkinsClient } from '../client/jenkins-client';
import { escapeRegExp } from '../utils/helpers';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { downloadToFile } from '../workflow/download';
import { runWorkflow } from '../workflow/run';
import { JOBS, FILE_SERVER_BASE, DOWNLOADS_DIR, ORANGE_BUILD_OPTIONS } from '../workflow/jobs';

/**
 * 固定打包 pcx 模块补丁包工作流（patch 命令的前身，保留作固定场景一键使用）
 *
 * 用法:
 *   npm run pcx
 *
 * 与 patch 的区别：版本清单固定为 examples/vOrange-wl-hxh，模块固定 pcx，无参数。
 */

/** 固定使用的版本清单（历史沿用，随仓库维护） */
const VERSION_FILE = path.join(process.cwd(), 'examples', 'vOrange-wl-hxh');

async function runPcxWorkflow(): Promise<void> {
  const client: JenkinsClient = createClientFromEnv();
  await precheckAuth(client);

  // 触发带文件参数的构建
  const result = await client.build(
    JOBS.orangeAliyun,
    {
      build_type: 'vOrange',
      version_file: { type: 'file', path: VERSION_FILE },
      options: ORANGE_BUILD_OPTIONS,
    },
    {
      wait: true,
      pollInterval: 60000,
      maxWaitTime: 3600000,
      crumbIssuer: true,
      streamLogs: true,
    },
  );

  console.log('Build triggered with file parameters:');
  console.log(`  Queue ID: ${result.queueId}`);
  console.log(`  URL: ${result.url}`);

  if (!('buildNumber' in result)) return;

  const consoleText = await client.getConsoleText(JOBS.orangeAliyun, result.buildNumber);

  // 匹配 orange_YYYYMMDDHHmmss.zip 格式
  const zipMatch = consoleText.match(/orange_\d{14}\.zip/);
  if (!zipMatch) {
    console.warn('  Warning: No orange_*.zip package found in console log');
    return;
  }
  console.log(`  Generated package: ${zipMatch[0]}`);

  // 触发 orange-patch 构建
  console.log('\n=== Triggering orange-patch build ===');
  const patchResult = await client.build(
    JOBS.orangePatch,
    {
      orange_package: zipMatch[0].replace('orange_', 'orange-patch-'),
      orange_module: 'pcx',
    },
    {
      wait: true,
      pollInterval: 10000,
      maxWaitTime: 600000,
      crumbIssuer: true,
      streamLogs: true,
    },
  );

  if (!('buildNumber' in patchResult)) return;
  console.log(`  orange-patch build #${patchResult.buildNumber} completed`);

  const patchConsoleText = await client.getConsoleText(JOBS.orangePatch, patchResult.buildNumber);

  const downloadUrlRegex = new RegExp(
    `${escapeRegExp(FILE_SERVER_BASE)}/jenkins-orange-patch/[^\\s"'<>]+\\.zip`
  );
  const downloadUrlMatch = patchConsoleText.match(downloadUrlRegex);
  if (!downloadUrlMatch) {
    console.warn('  Warning: No download URL found in orange-patch console output');
    return;
  }

  const downloadUrl = downloadUrlMatch[0];
  console.log(`  Found download URL: ${downloadUrl}`);

  await downloadToFile(downloadUrl, DOWNLOADS_DIR);
}

export function pcxCommand(argv: string[] = []): void {
  void argv;
  runWorkflow({ command: 'pcx', main: () => runPcxWorkflow() });
}
