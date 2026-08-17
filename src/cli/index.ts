import * as readline from 'readline/promises';
import { JenkinsError } from '../errors';
import { createClientFromEnv, precheckAuth } from '../workflow/client-factory';
import { patchCommand } from '../workflows/patch';
import { pcxCommand } from '../workflows/pcx';
import { ptyPcxCommand } from '../workflows/pty-pcx';
import { gwwyCommand } from '../workflows/gwwy-local';
import { gwwyOnlineCommand } from '../workflows/gwwy-online';
import { mergeCommand } from '../workflows/version-merge';

/**
 * 统一 CLI 入口
 *
 * 用法: npm run jenkins -- <子命令> [参数]
 */

const HELP = `用法: npm run jenkins -- <子命令> [参数]

打包工作流:
  patch [--project x] [--module m]   灵活模块打包（--project 可省略进入交互选择）
  pcx                                固定打包 pcx 模块补丁包
  merge [--vorange x] [--patch y]    合并两份版本清单（缺省读 merge/ 目录默认文件）
  pty-pcx                            pty-pcx 完整打包（构建+下载+解压+重压缩）
  gwwy [--branch x]                  gwwy uniapp 本地构建压缩
  gwwy-online --branch x [--head h]  gwwy uniapp 线上打包

Jenkins 运维:
  jobs [folder]                      列出 job（folder 如 web，可选）
  queue                              查看构建队列
  stop <job> <buildNumber>           停止构建（执行前确认）
  retry <job> <buildNumber>          重试构建

其他:
  help                               显示本帮助

示例:
  npm run jenkins -- patch --project vOrange-gwzc-530 --module pcx,home
  npm run jenkins -- gwwy-online --branch Feature_20260130_chongQingWenLvWei
  npm run jenkins -- jobs web
  npm run jenkins -- stop web/job/gwwy-uniapp 123`;

/** Jenkins color 字段 → 可读状态 */
function colorToStatus(color: string): string {
  if (color.endsWith('_anime')) return '进行中';
  switch (color) {
    case 'blue':
      return '成功';
    case 'red':
      return '失败';
    case 'notbuilt':
      return '未构建';
    case 'disabled':
      return '禁用';
    case 'aborted':
      return '已中止';
    default:
      return color;
  }
}

/** y/n 确认（非 TTY 直接拒绝，避免脚本误停构建） */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('非交互终端，已取消（该命令需要确认，请 在 TTY 下执行）');
    return false;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} (y/n): `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** jobs [folder] */
async function jobsCommand(args: string[]): Promise<void> {
  const folder = args[0];
  const client = createClientFromEnv();
  await precheckAuth(client);

  const jobs = await client.listJobs(folder);
  if (jobs.length === 0) {
    console.log(folder ? `目录 ${folder} 下没有 job` : '没有 job');
    return;
  }

  console.log(`\n共 ${jobs.length} 个 job:`);
  for (const job of jobs) {
    const status = colorToStatus(job.color);
    console.log(`  ${job.name.padEnd(30)} ${status.padEnd(6)} ${job.url}`);
  }
}

/** queue */
async function queueCommand(): Promise<void> {
  const client = createClientFromEnv();
  await precheckAuth(client);

  const items = await client.getQueue();
  if (items.length === 0) {
    console.log('队列为空');
    return;
  }

  console.log(`\n共 ${items.length} 项排队:`);
  for (const item of items) {
    console.log(`  #${item.id} ${item.taskName || '未知任务'} — ${item.why || '等待中'}`);
    if (item.buildNumber !== undefined) {
      console.log(`      已启动: 构建 #${item.buildNumber}`);
    }
  }
}

/** stop <job> <buildNumber> */
async function stopCommand(args: string[]): Promise<void> {
  const [jobName, buildNumberStr] = args;
  const buildNumber = Number(buildNumberStr);

  if (!jobName || !Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new JenkinsError('用法: npm run jenkins -- stop <jobName> <buildNumber>');
  }

  const ok = await confirm(`确认停止 ${jobName} #${buildNumber} ？`);
  if (!ok) {
    console.log('已取消');
    return;
  }

  const client = createClientFromEnv();
  await precheckAuth(client);
  await client.stopBuild(jobName, buildNumber);
  console.log(`✅ 已发送停止指令: ${jobName} #${buildNumber}`);
}

/** retry <job> <buildNumber> */
async function retryCommand(args: string[]): Promise<void> {
  const [jobName, buildNumberStr] = args;
  const buildNumber = Number(buildNumberStr);

  if (!jobName || !Number.isInteger(buildNumber) || buildNumber <= 0) {
    throw new JenkinsError('用法: npm run jenkins -- retry <jobName> <buildNumber>');
  }

  const client = createClientFromEnv();
  await precheckAuth(client);
  const result = await client.retryBuild(jobName, buildNumber);
  console.log(`✅ 已重新触发: Queue ID ${result.queueId}`);
  console.log(`  ${result.url}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    // 打包工作流（各自内部处理参数、错误兜底与退出码）
    case 'patch':
      patchCommand(rest);
      return;
    case 'pcx':
      pcxCommand(rest);
      return;
    case 'merge':
      mergeCommand(rest);
      return;
    case 'pty-pcx':
      ptyPcxCommand(rest);
      return;
    case 'gwwy':
      gwwyCommand(rest);
      return;
    case 'gwwy-online':
      gwwyOnlineCommand(rest);
      return;

    // Jenkins 运维
    case 'jobs':
      await jobsCommand(rest);
      return;
    case 'queue':
      await queueCommand();
      return;
    case 'stop':
      await stopCommand(rest);
      return;
    case 'retry':
      await retryCommand(rest);
      return;

    // 帮助
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      console.log(HELP);
      return;

    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
