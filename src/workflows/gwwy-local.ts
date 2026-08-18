import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { CompressService } from '../services/bandzip-service';
import { runWorkflow } from '../workflow/run';
import { parseFlagArgs } from './flag-args';
import { getErrorMessage } from '../utils/helpers';

/**
 * gwwy-uniapp 本地打包工作流（Windows + Git Bash）
 *
 * 在本机 uniapp 项目上切分支、拉代码、npm build、重命名 h5 产物并压缩。
 * 与 `npm run gwwy-online` 互为本地/线上对应版本。
 *
 * 用法:
 *   npm run gwwy [-- --branch <分支名>]
 *
 * --branch 缺省时使用 DEFAULT_TARGET_BRANCH
 */

// exec 转为 Promise（类型断言解决 promisify 的推断问题）
const execAsync = promisify(exec) as (
  command: string,
  options?: ExecOptions
) => Promise<{ stdout: string; stderr: string }>;

// Git Bash 的可执行文件路径（Windows 系统）
const GIT_BASH_PATH = 'C:\\Program Files\\Git\\bin\\bash.exe';

// uniapp 项目的路径（Git Bash 中使用 /c/ 代替 C:\）
const UNIAPP_PROJECT_PATH = '/c/IDEA/project/uniapp/gwwy-uniapp';

// 中间切换分支（用于重置跟踪关系）
const DEV_TEST_BRANCH = 'dev_test';

// Windows 格式路径（用于 Node.js fs 操作）
const UNIAPP_PROJECT_PATH_WIN = 'C:\\IDEA\\project\\uniapp\\gwwy-uniapp';
const DIST_PATH = path.join(UNIAPP_PROJECT_PATH_WIN, 'dist');
const BUILD_PATH = path.join(UNIAPP_PROJECT_PATH_WIN, 'dist', 'build');
const H5_PATH = path.join(BUILD_PATH, 'h5');
const RENAMED_PATH = path.join(BUILD_PATH, 'gwwy-uniapp');
const SOURCE_PATH = path.join(BUILD_PATH, 'gwwy-uniapp');
const OUTPUT_ZIP = path.join(BUILD_PATH, 'gwwy-uniapp.zip');

export interface GwwyLocalArgs {
  /** 目标分支（默认 DEFAULT_TARGET_BRANCH） */
  branch: string;
}

/** 默认打包分支（历史沿用；--branch 可覆盖） */
export const DEFAULT_TARGET_BRANCH = 'Feature_20260130_chongQingWenLvWei';

/**
 * 解析命令行参数
 */
export function parseGwwyLocalArgs(argv: string[]): GwwyLocalArgs {
  const values = parseFlagArgs(
    argv,
    ['--branch'],
    '用法: npm run jenkins -- gwwy [--branch <分支名>]（缺省使用默认分支）'
  );
  return { branch: values['--branch'] ?? DEFAULT_TARGET_BRANCH };
}

/**
 * 执行 Git Bash 命令
 */
async function runGitBashCommand(command: string, cwd?: string): Promise<string> {
  const bashCommand = `-c "${command}"`;

  console.log(`\n[执行命令] ${command}`);

  try {
    const { stdout, stderr } = await execAsync(`"${GIT_BASH_PATH}" ${bashCommand}`, {
      cwd: cwd || process.cwd(),
      shell: 'bash',
    });

    if (stderr) {
      console.warn(`[警告] ${stderr}`);
    }

    return stdout;
  } catch (error) {
    console.error(`[错误] 命令执行失败: ${command}`);
    throw error;
  }
}

/**
 * 获取当前分支的跟踪分支
 */
async function getUpstreamBranch(): Promise<string> {
  try {
    const upstream = (
      await runGitBashCommand(
        `cd ${UNIAPP_PROJECT_PATH} && git rev-parse --abbrev-ref --symbolic-full-name @{u}`
      )
    ).trim();

    return upstream || '';
  } catch {
    // 如果没有设置跟踪分支，返回空字符串
    return '';
  }
}

/**
 * 检查并切换到目标分支
 *
 * 检查当前分支是否为目标分支、跟踪分支是否正确；不满足时通过中间分支删除目标分支，
 * 再从远程重新拉取并建立跟踪关系。切换失败终止整个流程。
 */
async function checkAndSwitchBranch(targetBranch: string): Promise<void> {
  console.log('='.repeat(50));
  console.log('检查 Git 分支...');

  const currentBranch = (
    await runGitBashCommand(`cd ${UNIAPP_PROJECT_PATH} && git branch --show-current`)
  ).trim();

  console.log(`[当前分支] ${currentBranch}`);
  console.log(`[目标分支] ${targetBranch}`);

  const expectedUpstream = `origin/${targetBranch}`;

  if (currentBranch === targetBranch) {
    console.log('[提示] 已经在目标分支上');

    const upstream = await getUpstreamBranch();
    console.log(`[当前跟踪分支] ${upstream || '未设置'}`);
    console.log(`[期望跟踪分支] ${expectedUpstream}`);

    if (upstream === expectedUpstream) {
      console.log('[提示] 分支状态正确，无需重建');
      console.log('='.repeat(50));
      return;
    }
    console.log('[提示] 跟踪分支不正确，需要重建分支');
  } else {
    console.log('[提示] 当前不在目标分支上，需要重建分支');
  }

  try {
    console.log('\n[开始重建分支流程]');

    console.log(`\n[步骤1] 切换到中间分支 ${DEV_TEST_BRANCH}...`);
    await runGitBashCommand(`cd ${UNIAPP_PROJECT_PATH} && git checkout ${DEV_TEST_BRANCH}`);
    console.log(`[成功] 已切换到 ${DEV_TEST_BRANCH} 分支`);

    console.log(`\n[步骤2] 删除本地 ${targetBranch} 分支...`);
    try {
      await runGitBashCommand(`cd ${UNIAPP_PROJECT_PATH} && git branch -D ${targetBranch}`);
      console.log(`[成功] 已删除本地 ${targetBranch} 分支`);
    } catch {
      console.log(`[提示] 本地 ${targetBranch} 分支不存在，跳过删除`);
    }

    console.log(`\n[步骤3] 从远程仓库 origin/${targetBranch} 新建本地 ${targetBranch} 分支...`);
    await runGitBashCommand(
      `cd ${UNIAPP_PROJECT_PATH} && git checkout -b ${targetBranch} origin/${targetBranch}`
    );
    console.log(`[成功] 已创建本地 ${targetBranch} 分支并跟踪 origin/${targetBranch}`);

    console.log('\n[步骤4] 验证跟踪关系...');
    const newUpstream = await getUpstreamBranch();
    console.log(`[当前跟踪分支] ${newUpstream || '未设置'}`);
    console.log(`[期望跟踪分支] ${expectedUpstream}`);

    if (newUpstream === expectedUpstream) {
      console.log('[成功] 分支重建完成，跟踪关系正确');
    } else {
      throw new Error(`分支重建失败，跟踪关系不正确: ${newUpstream}`);
    }
  } catch (error) {
    console.error('\n[错误] 分支重建失败！');
    console.error('整个流程已终止');
    throw new Error(
      `无法正确重建分支: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }

  console.log('='.repeat(50));
}

/**
 * 拉取最新代码
 */
async function pullLatestCode(): Promise<void> {
  console.log('='.repeat(50));
  console.log('拉取最新代码...');

  await runGitBashCommand(`cd ${UNIAPP_PROJECT_PATH} && git pull`);

  console.log('代码拉取完成！');
  console.log('='.repeat(50));
}

/**
 * 执行 npm build 构建
 */
async function runBuild(): Promise<void> {
  console.log('='.repeat(50));
  console.log('开始构建 uniapp 项目...');

  await runGitBashCommand(`cd ${UNIAPP_PROJECT_PATH} && npm run build`);

  console.log('构建完成！');
  console.log('='.repeat(50));
}

/**
 * 构建前删除 dist 文件夹，确保干净的构建环境
 */
async function cleanDistFolder(): Promise<void> {
  console.log('='.repeat(50));
  console.log('清理 dist 文件夹...');

  if (fs.existsSync(DIST_PATH)) {
    try {
      // 使用 Git Bash rm -rf 命令删除，避免 Windows 文件锁问题
      await runGitBashCommand(`rm -rf ${UNIAPP_PROJECT_PATH}/dist`);
      console.log('[成功] dist 文件夹已删除');
    } catch {
      console.warn('[警告] 删除 dist 文件夹失败，将继续执行');
    }
  } else {
    console.log('[提示] dist 文件夹不存在，跳过清理');
  }

  console.log('='.repeat(50));
}

/**
 * 构建完成后将 h5 文件夹重命名为 gwwy-uniapp
 */
function renameH5Folder(): void {
  console.log('='.repeat(50));
  console.log('重命名 h5 文件夹...');

  if (!fs.existsSync(H5_PATH)) {
    throw new Error(`h5 文件夹不存在: ${H5_PATH}`);
  }

  if (fs.existsSync(RENAMED_PATH)) {
    fs.rmSync(RENAMED_PATH, { recursive: true, force: true });
    console.log('[提示] 已删除旧的 gwwy-uniapp 文件夹');
  }

  fs.renameSync(H5_PATH, RENAMED_PATH);
  console.log('[成功] 已将 h5 重命名为 gwwy-uniapp');

  console.log('='.repeat(50));
}

/**
 * 使用 CompressService 压缩构建产物
 */
async function compressBuild(): Promise<void> {
  console.log('='.repeat(50));
  console.log('开始压缩构建产物...');

  if (!fs.existsSync(SOURCE_PATH)) {
    throw new Error(`源文件夹不存在: ${SOURCE_PATH}`);
  }

  const compressService = new CompressService();

  const result = await compressService.compress(SOURCE_PATH, OUTPUT_ZIP, {
    level: 2,
    format: 'zip',
    recursive: true,
    storeRoot: true,
    threads: 0,
  });

  console.log(`[成功] 压缩完成: ${result.archivePath}`);
  console.log(`[信息] 文件大小: ${(result.size / 1024 / 1024).toFixed(2)} MB`);

  console.log('='.repeat(50));
}

async function runGwwyLocalWorkflow(argv: string[]): Promise<void> {
  const { branch } = parseGwwyLocalArgs(argv);
  console.log(`\n### gwwy-uniapp 本地打包: branch=${branch} ###\n`);

  // 1. 清理 dist 文件夹
  await cleanDistFolder();

  // 2. 检查并切换到目标分支
  await checkAndSwitchBranch(branch);

  // 3. 拉取最新代码
  await pullLatestCode();

  // 4. 执行构建
  await runBuild();

  // 5. 重命名 h5 文件夹
  renameH5Folder();

  // 6. 压缩构建产物
  await compressBuild();

  console.log('\n### 所有步骤执行完成！ ###\n');
}

export function gwwyCommand(argv: string[]): void {
  runWorkflow({ command: 'gwwy', main: () => runGwwyLocalWorkflow(argv) });
}
