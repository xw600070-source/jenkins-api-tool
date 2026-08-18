import * as fs from 'fs';
import * as path from 'path';
import { JenkinsClient } from '../client/jenkins-client';
import { JenkinsError } from '../errors';
import { escapeRegExp } from '../utils/helpers';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { downloadToFile } from '../workflow/download';
import { runWorkflow } from '../workflow/run';
import { JOBS, FILE_SERVER_BASE, DOWNLOADS_DIR, ORANGE_BUILD_OPTIONS } from '../workflow/jobs';
import { notify } from '../services/notify-service';
import { listProjectFiles, pickProjectFile } from './interactive';
import { parseFlagArgs } from './flag-args';

/**
 * 灵活模块打包(patch)工作流
 *
 * 用法:
 *   npm run patch -- --project <vOrange文件名> [--module <模块>]
 *   npm run jenkins -- patch [--project <vOrange文件名>] [--module <模块>]
 *
 * --project 省略且终端可交互时，列出 project/ 目录文件供选择
 */

export interface PatchArgs {
  /** vOrange 文件名；可缺省（交互选择） */
  project?: string;
  /** 保留的模块,逗号分隔多个,默认 pcx */
  module: string;
}

const PATCH_USAGE =
  '用法: npm run jenkins -- patch [--project <vOrange文件名>] [--module <模块>]（--module 缺省 pcx）';

/**
 * 解析命令行参数（project 缺省时由调用方决定是否交互补选）
 */
export function parsePatchArgs(argv: string[]): PatchArgs {
  const values = parseFlagArgs(argv, ['--project', '--module'], PATCH_USAGE);
  return { project: values['--project'], module: values['--module'] ?? 'pcx' };
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
      '用法: npm run patch -- --project <vOrange文件名> [--module <模块>]\n' +
      `project/ 目录下可用文件: ${available.length ? available.join(', ') : '（无）'}`
  );
}

async function runPatchWorkflow(argv: string[]): Promise<void> {
  const { project: projectArg, module: moduleArg } = parsePatchArgs(argv);
  const project = await resolveProject(projectArg);
  console.log(`打包任务: project=${project}, module=${moduleArg}`);

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

  // 获取控制台日志并提取生成的 zip 包名
  if (!('buildNumber' in result)) return;

  const consoleText = await client.getConsoleText(JOBS.orangeAliyun, result.buildNumber);

  // 匹配 orange_YYYYMMDDHHmmss.zip 格式
  const zipMatch = consoleText.match(/orange_\d{14}\.zip/);
  if (!zipMatch) {
    console.warn('  Warning: No orange_*.zip package found in console log');
    return;
  }
  console.log(`  Generated package: ${zipMatch[0]}`);

  // 触发 orange-patch 构建(按 --module 裁剪保留指定模块)
  console.log(`\n=== Triggering orange-patch build (module: ${moduleArg}) ===`);
  const patchResult = await client.build(
    JOBS.orangePatch,
    {
      orange_package: zipMatch[0].replace('orange_', 'orange-patch-'),
      orange_module: moduleArg,
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

  // 匹配外网下载链接（地址来自 FILE_SERVER_BASE，可用环境变量覆盖）
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

  const { outputPath } = await downloadToFile(downloadUrl, DOWNLOADS_DIR);

  notify({
    command: 'patch',
    success: true,
    buildNumber: patchResult.buildNumber,
    duration: patchResult.duration,
    artifactPath: outputPath,
  });
}

export function patchCommand(argv: string[]): void {
  runWorkflow({ command: 'patch', main: () => runPatchWorkflow(argv) });
}
