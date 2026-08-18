import * as fs from 'fs';
import * as path from 'path';
import { JenkinsClient } from '../client/jenkins-client';
import { CompressService } from '../services/bandzip-service';
import { createClientFromEnv } from '../workflow/client-factory';
import { runWorkflow } from '../workflow/run';
import { JOBS } from '../workflow/jobs';
import { parseFlagArgs } from './flag-args';
import { getErrorMessage } from '../utils/helpers';

/**
 * pty-pcx 完整打包工作流
 *
 * 1. 触发 pty-pcx 构建（带参数）并等待完成
 * 2. 下载 workspace 中的 zip 产物
 * 3. 解压到 lib 目录
 * 4. 删除下载的压缩包
 * 5. 重新压缩 lib 为带日期的升级包
 *
 * 用法:
 *   npm run pty-pcx
 */

/** 等待文件取消占用 */
async function waitForFileUnlock(
  filePath: string,
  maxRetries: number = 10,
  retryInterval: number = 1000
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
      return;
    } catch (error) {
      if (i < maxRetries - 1) {
        console.log(
          `  文件被占用，等待 ${(retryInterval / 1000).toFixed(1)} 秒后重试 (${i + 1}/${maxRetries})...`
        );
        await new Promise((resolve) => setTimeout(resolve, retryInterval));
      } else {
        throw new Error(`文件持续被占用，已重试 ${maxRetries} 次`, { cause: error });
      }
    }
  }
}

/**
 * 查找可用的 ZIP 文件路径（重名时自动追加 _001 递增版本号）
 */
function findAvailableZipPath(outputDir: string, baseFileName: string): string {
  const basePath = path.join(outputDir, `${baseFileName}.zip`);
  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  // 查找已有的版本号，取最大值 + 1
  let maxVersion = 0;
  const pattern = new RegExp(`^${baseFileName}_(\\d{3})\\.zip$`);

  try {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      const match = file.match(pattern);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > maxVersion) {
          maxVersion = version;
        }
      }
    }
  } catch (error) {
    console.error(`  [版本检测] 读取目录失败: ${getErrorMessage(error)}`);
  }

  const versionStr = String(maxVersion + 1).padStart(3, '0');
  return path.join(outputDir, `${baseFileName}_${versionStr}.zip`);
}

async function runPtyPcxWorkflow(): Promise<void> {
  const client: JenkinsClient = createClientFromEnv();

  const downloadDir = 'C:\\BandZip\\lib';
  const outputZipDir = 'C:\\BandZip';

  // ============================================
  // 步骤 1: 触发构建并等待完成
  // ============================================
  console.log('--- 步骤 1: 触发构建并等待完成 ---');

  const buildResult = await client.build(
    JOBS.ptyPcx,
    {
      git_branch: 'hxh0602_PCX_Feature_20260212_chongqingwenlv',
      version_type: 'RELEASE',
      release_version: '2026M06P01',
      update_module_version: 'false',
      update_dependency_version: 'false',
    },
    {
      wait: true,
      pollInterval: 20000,
      maxWaitTime: 3600000,
      crumbIssuer: true,
    }
  );

  if (!('buildNumber' in buildResult)) {
    console.log(`✓ 构建已触发: Queue ID ${buildResult.queueId}`);
    return;
  }

  console.log(`✓ 构建完成: #${buildResult.buildNumber}`);
  console.log(`  状态: ${buildResult.status}`);
  console.log(`  耗时: ${buildResult.duration}ms`);

  // ============================================
  // 步骤 2: 下载工作空间文件
  // ============================================
  console.log('--- 步骤 2: 下载工作空间文件 ---');
  let downloadedFilePath = '';
  try {
    const result = await client.download(
      JOBS.ptyPcx,
      undefined, // 实测构建产物不在构建编号的 workspace 中，使用当前 workspace
      'pty-pcx/pcx-4.0.1.1284-ENT-RELEASE.zip',
      downloadDir,
      { source: 'workspace' }
    );
    console.log(`✓ 下载成功: ${result.fileName} (${result.size} 字节)`);
    console.log(`  本地路径: ${result.localPath}`);
    console.log(`  下载耗时: ${result.duration}ms\n`);
    downloadedFilePath = result.localPath;
  } catch (error) {
    console.error(`✗ 下载失败: ${getErrorMessage(error)}\n`);
  }

  if (!downloadedFilePath || !fs.existsSync(downloadedFilePath)) {
    console.log('=== 工作流结束（无下载产物，跳过后续步骤） ===');
    return;
  }

  // ============================================
  // 步骤 3: 解压下载的文件
  // ============================================
  console.log('--- 步骤 3: 解压下载的文件 ---');
  try {
    const compressService = new CompressService();
    const extractResult = await compressService.extract(downloadedFilePath, {
      outputDir: downloadDir,
      overwrite: true,
    });
    console.log(`✓ 解压完成: ${extractResult.extractedCount} 个文件`);
    console.log(`  解压目录: ${extractResult.outputDir}`);
    console.log(`  解压耗时: ${extractResult.duration}ms\n`);
  } catch (error) {
    console.error(`✗ 解压失败: ${getErrorMessage(error)}\n`);
  }

  // ============================================
  // 步骤 4: 等待文件取消占用后删除下载的压缩包
  // ============================================
  console.log('--- 步骤 4: 删除下载的压缩包 ---');
  try {
    await waitForFileUnlock(downloadedFilePath, 10, 1000);
    fs.unlinkSync(downloadedFilePath);
    console.log(`✓ 已删除压缩包: ${downloadedFilePath}\n`);
  } catch (error) {
    console.error(`✗ 删除压缩包失败: ${getErrorMessage(error)}\n`);
  }

  // ============================================
  // 步骤 5: 压缩 lib 文件夹
  // ============================================
  console.log('--- 步骤 5: 压缩 lib 文件夹 ---');
  try {
    const compressService = new CompressService();

    const now = new Date();
    const dateStr =
      `${now.getFullYear()}` +
      `${String(now.getMonth() + 1).padStart(2, '0')}` +
      `${String(now.getDate()).padStart(2, '0')}`;
    const baseFileName = `update_patch_pcx_chongQingWenLv_${dateStr}`;

    const outputZipPath = findAvailableZipPath(outputZipDir, baseFileName);

    const compressResult = await compressService.compress(downloadDir, outputZipPath, {
      level: 2,
      format: 'zip',
      recursive: true,
      storeRoot: true,
      threads: 0,
      overwrite: false,
    });
    console.log(`✓ 压缩完成: ${path.basename(compressResult.archivePath)}`);
    console.log(`  文件大小: ${(compressResult.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  压缩耗时: ${compressResult.duration}ms\n`);
  } catch (error) {
    console.error(`✗ 压缩失败: ${getErrorMessage(error)}\n`);
  }

  console.log('=== 工作流结束 ===');
}

export function ptyPcxCommand(argv: string[] = []): void {
  runWorkflow({
    command: 'pty-pcx',
    main: () => {
      parseFlagArgs(argv, [], '用法: npm run pty-pcx（本命令无参数）');
      return runPtyPcxWorkflow();
    },
  });
}
