import * as fs from 'fs';
import * as path from 'path';
import { JenkinsClient } from '../client/jenkins-client';
import { JenkinsError } from '../errors';
import { escapeRegExp } from '../utils/helpers';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { downloadToFile } from '../workflow/download';
import { runWorkflow } from '../workflow/run';
import { JOBS, DOWNLOADS_DIR, ORANGE_FULL_BUILD_OPTIONS } from '../workflow/jobs';
import { notify } from '../services/notify-service';
import { listProjectFiles, pickProjectFile } from './interactive';
import { parseFlagArgs } from './flag-args';

/**
 * orange 整包工作流
 *
 * 与 patch 的区别：只触发 orange-aliyun 全量构建并下载整包 orange_<时间戳>.zip，
 * 不触发 orange-patch 裁剪、不出 update_patch 补丁包。
 *
 * 用法:
 *   npm run orange -- --project <vOrange文件名>
 *   npm run jenkins -- orange [--project <vOrange文件名>]
 *
 * --project 省略且终端可交互时，列出 project/ 目录文件供选择
 */

export interface OrangeFullArgs {
  /** vOrange 文件名；可缺省（交互选择） */
  project?: string;
}

const ORANGE_FULL_USAGE =
  '用法: npm run orange -- --project <vOrange文件名>（按版本清单打 orange 整包，不裁剪）';

/** 解析命令行参数 */
export function parseOrangeFullArgs(argv: string[]): OrangeFullArgs {
  const values = parseFlagArgs(argv, ['--project'], ORANGE_FULL_USAGE);
  return { project: values['--project'] };
}

/** 解析或交互选择出 project 文件名 */
async function resolveProject(project: string | undefined): Promise<string> {
  const projectDir = path.join(process.cwd(), 'project');

  if (project) return project;

  if (process.stdin.isTTY) {
    return await pickProjectFile(projectDir);
  }

  const available = listProjectFiles(projectDir);
  throw new JenkinsError(
    '缺少必传参数 --project\n' +
    `用法: npm run orange -- --project <vOrange文件名>\n` +
    `project/ 目录下可用文件: ${available.length ? available.join(', ') : '（无）'}`
  );
}

/** 从全量构建控制台日志中提取整包下载链接（任意 host 下以 orange_<时间戳>.zip 结尾的 URL） */
export function extractOrangeZipUrl(consoleText: string, zipName: string): string | undefined {
  const zipUrlRegex = new RegExp(`https?://[^\\s"'<>]+/${escapeRegExp(zipName)}`);
  return consoleText.match(zipUrlRegex)?.[0];
}

async function runOrangeFullWorkflow(argv: string[]): Promise<void> {
  const { project: projectArg } = parseOrangeFullArgs(argv);
  const project = await resolveProject(projectArg);
  console.log(`整包任务: project=${project}`);

  const projectDir = path.join(process.cwd(), 'project');
  const configFilePath = path.join(projectDir, project);
  if (!fs.existsSync(configFilePath)) {
    const available = listProjectFiles(projectDir);
    throw new JenkinsError(
      `版本清单文件不存在: ${configFilePath}\nproject/ 目录下可用文件: ${available.length ? available.join(', ') : '（无）'}`
    );
  }

  const client: JenkinsClient = createClientFromEnv();
  await precheckAuth(client);

  // 触发 orange-aliyun 全量构建(按版本清单打包所有模块)
  const result = await client.build(
    JOBS.orangeAliyun,
    {
      build_type: 'vOrange',
      version_file: { type: 'file', path: configFilePath },
      options: ORANGE_FULL_BUILD_OPTIONS,
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

  // 从控制台日志提取整包下载链接（文件服务器静态目录，无需认证）
  const downloadUrl = extractOrangeZipUrl(consoleText, zipMatch[0]);
  if (!downloadUrl) {
    console.warn(`  Warning: 整包 ${zipMatch[0]} 的下载链接未在日志中找到`);
    console.warn(`  可到构建页查看: ${result.url}`);
    return;
  }
  console.log(`  Found download URL: ${downloadUrl}`);

  const { outputPath, duration } = await downloadToFile(downloadUrl, DOWNLOADS_DIR);

  notify({
    command: 'orange',
    success: true,
    buildNumber: result.buildNumber,
    duration,
    artifactPath: outputPath,
  });
}

export function orangeFullCommand(argv: string[]): void {
  runWorkflow({ command: 'orange', main: () => runOrangeFullWorkflow(argv) });
}
