import * as fs from 'fs';
import * as path from 'path';
import { JenkinsClient } from '../client/jenkins-client';
import { JenkinsError } from '../errors';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { runWorkflow } from '../workflow/run';
import { JOBS, DOWNLOADS_DIR } from '../workflow/jobs';
import { notify } from '../services/notify-service';
import { parseFlagArgs } from './flag-args';

/**
 * orange 版本清单合并工作流
 *
 * 上传两份清单到 Jenkins 任务 orange-version-merge（文件参数 vOrange + orangePatchVersion.txt），
 * 等待合并完成（约 1 分钟，期间流式打印构建日志），从 workspace 下载合并结果到 downloads/。
 *
 * 用法:
 *   npm run merge                                   # 读 merge/ 目录下的默认两个文件
 *   npm run merge -- --vorange A --patch B          # 显式指定（纯文件名先查 merge/ 再查 project/）
 *   npm run jenkins -- merge [--vorange A] [--patch B]
 */

/** 任务输出的合并结果在 workspace 中的路径 */
const MERGE_OUTPUT_WS_PATH = 'version-merge/dist/vOrange';

/** 默认输入目录（仓库根目录 merge/，本地管理不入 git） */
export const MERGE_DIR = path.join(process.cwd(), 'merge');

/** 缺省输入文件名（与 Jenkins 任务参数同名） */
const DEFAULT_VORANGE_FILE = 'vOrange';
const DEFAULT_PATCH_FILE = 'orangePatchVersion.txt';

export interface MergeArgs {
  /** vOrange 版本清单；缺省读 merge/vOrange */
  vorange?: string;
  /** 补丁版本文件；缺省读 merge/orangePatchVersion.txt */
  patch?: string;
}

/** resolveMergeInput 的查找目录（注入以便单测） */
export interface MergeInputDirs {
  mergeDir: string;
  projectDir: string;
}

/** 用法提示（参数解析与文件解析共用） */
const MERGE_USAGE =
  '用法: npm run merge -- --vorange <文件> --patch <文件>（缺省读取 merge/ 目录默认文件）';

/**
 * 解析命令行参数
 */
export function parseMergeArgs(argv: string[]): MergeArgs {
  const values = parseFlagArgs(argv, ['--vorange', '--patch'], MERGE_USAGE);
  return { vorange: values['--vorange'], patch: values['--patch'] };
}

/** 列目录可用文件（不存在返回提示"（无）"） */
function listFiles(dir: string): string {
  if (!fs.existsSync(dir)) return `（目录 ${dir} 不存在）`;
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => e.name);
  return files.length ? files.join(', ') : '（无）';
}

/**
 * 解析单个输入文件为存在的绝对路径
 *
 * - value 缺省 → merge/ 目录下的默认文件（vOrange / orangePatchVersion.txt）
 * - 绝对路径 → 按原样；含路径分隔符 → 相对当前目录
 * - 纯文件名 → 先查 mergeDir，再查 projectDir
 * - 任何情况找不到都抛 JenkinsError，并附两个目录的可用文件列表
 */
export function resolveMergeInput(
  value: string | undefined,
  kind: 'vorange' | 'patch',
  dirs: MergeInputDirs
): string {
  const label = kind === 'vorange' ? 'vOrange 版本清单' : '补丁版本文件';
  const usage = MERGE_USAGE;

  const candidates: string[] = [];
  if (value) {
    if (path.isAbsolute(value)) {
      candidates.push(value);
    } else if (value.includes('/') || value.includes(path.sep)) {
      candidates.push(path.resolve(value));
    } else {
      candidates.push(path.join(dirs.mergeDir, value), path.join(dirs.projectDir, value));
    }
  } else {
    const defaultName = kind === 'vorange' ? DEFAULT_VORANGE_FILE : DEFAULT_PATCH_FILE;
    candidates.push(path.join(dirs.mergeDir, defaultName));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  const expected = value
    ? `找不到${label}: ${value}（已查找: ${candidates.join(', ')}）`
    : `缺省${label}不存在: ${candidates[0]}，请把文件放到 merge/ 目录（vOrange 与 orangePatchVersion.txt）`;
  throw new JenkinsError(
    `${expected}\n${usage}\n` +
      `merge/ 可用文件: ${listFiles(dirs.mergeDir)}\n` +
      `project/ 可用文件: ${listFiles(dirs.projectDir)}`
  );
}

async function runMergeWorkflow(argv: string[]): Promise<void> {
  const { vorange, patch } = parseMergeArgs(argv);
  const dirs: MergeInputDirs = {
    mergeDir: MERGE_DIR,
    projectDir: path.join(process.cwd(), 'project'),
  };

  const vorangePath = resolveMergeInput(vorange, 'vorange', dirs);
  const patchPath = resolveMergeInput(patch, 'patch', dirs);
  console.log(`版本合并: vOrange=${path.basename(vorangePath)}, orangePatchVersion=${path.basename(patchPath)}`);

  const client: JenkinsClient = createClientFromEnv();
  await precheckAuth(client);

  // 触发合并构建并等待完成（任务约 1 分钟）
  const result = await client.build(
    JOBS.orangeVersionMerge,
    {
      vOrange: { type: 'file', path: vorangePath },
      'orangePatchVersion.txt': { type: 'file', path: patchPath },
    },
    {
      wait: true,
      pollInterval: 10000,
      maxWaitTime: 600000,
      crumbIssuer: true,
      streamLogs: true,
    },
  );

  if (!('buildNumber' in result)) {
    console.log(`✅ 构建已触发: Queue ID ${result.queueId}`);
    console.log(`  构建页: ${result.url}`);
    return;
  }

  console.log(`\n✅ 合并完成: #${result.buildNumber} (${result.duration}ms)`);

  // 下载合并结果：workspace 下载需认证，走 SDK 通道；当前 workspace 即本次构建结果
  console.log('\n=== 下载合并结果 ===');
  const download = await client.download(
    JOBS.orangeVersionMerge,
    undefined,
    MERGE_OUTPUT_WS_PATH,
    DOWNLOADS_DIR,
    { source: 'workspace' }
  );

  // 远端文件名固定为 vOrange，重命名带上构建号避免多次运行互相覆盖
  const outputPath = path.join(DOWNLOADS_DIR, `vOrange-merge-b${result.buildNumber}`);
  fs.renameSync(download.localPath, outputPath);
  console.log(`  ✅ 已下载: ${outputPath} (${download.size} 字节)`);
  console.log('  提示: 确认内容后可复制到 project/ 目录，供 patch 命令使用');

  notify({
    command: 'merge',
    success: true,
    buildNumber: result.buildNumber,
    duration: result.duration,
    artifactPath: outputPath,
  });
}

export function mergeCommand(argv: string[]): void {
  runWorkflow({ command: 'merge', main: () => runMergeWorkflow(argv) });
}
