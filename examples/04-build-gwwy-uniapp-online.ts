import "dotenv/config";
import { JenkinsClient, LogLevel, BuildFailedError, TimeoutError } from "../src";
import path from "path";
import * as fs from "fs";
import axios from "axios";

/**
 * gwwy-uniapp 线上打包工作流
 *
 * 直接触发 Jenkins 任务 web/job/gwwy-uniapp 按指定分支打包，
 * 等待构建结束、打印构建号 / 状态 / 耗时 / 构建页地址，
 * 并从控制台日志提取下载链接、把打包产物下载到 downloads/ 目录。
 * 与本地打包命令 `npm run gwwy`（本机 Git Bash 构建）互为线上/线下对应版本。
 *
 * 用法:
 *   npm run gwwy-online -- --branch <分支名> [--head <提交>]
 *
 * 参数:
 *   --branch  必传,要打包的 Git 分支名(对应 Jenkins 任务的 git_branch 参数)
 *   --head    可选,分支上的提交 ref(对应 git_head 参数),默认 HEAD
 *
 * 示例:
 *   npm run gwwy-online -- --branch Feature_20260130_chongQingWenLvWei
 *   npm run gwwy-online -- --branch Feature_20260130_chongQingWenLvWei --head 4e9d71ff
 */

interface GwwyArgs {
  branch: string; // 打包分支(必传)
  head: string; // 提交 ref(默认 HEAD)
}

/**
 * 解析命令行参数
 */
function parseArgs(argv: string[]): GwwyArgs {
  let branch: string | undefined;
  let head = "HEAD";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--branch" && i + 1 < argv.length) {
      branch = argv[++i];
    } else if (argv[i] === "--head" && i + 1 < argv.length) {
      head = argv[++i];
    }
  }

  if (!branch) {
    console.error(
      "❌ 缺少必传参数 --branch\n" +
        "用法: npm run gwwy-online -- --branch <分支名> [--head <提交>]\n" +
        "例如: npm run gwwy-online -- --branch Feature_20260130_chongQingWenLvWei"
    );
    process.exit(1);
  }

  return { branch, head };
}

async function main() {
  const { branch, head } = parseArgs(process.argv.slice(2));
  console.log(`gwwy-uniapp 线上打包: branch=${branch}, head=${head}`);

  const client = new JenkinsClient({
    url: process.env.JENKINS_URL || 'http://your-jenkins-server:8080',
    username: process.env.JENKINS_USERNAME || '',
    password: process.env.JENKINS_PASSWORD || '',
    apiToken: process.env.JENKINS_API_TOKEN || '',
    logLevel: (process.env.LOG_LEVEL || 'info') as LogLevel,
  });

  // 连接预检
  const auth = await client.verifyAuth();
  if (!auth.authenticated) {
    console.error("❌ 认证失败，请检查 JENKINS_URL / JENKINS_USERNAME / JENKINS_API_TOKEN");
    process.exit(1);
  }
  console.log(`✅ 认证成功：${auth.user} (Jenkins 版本：${auth.version || "未知"})`);

  // 触发 web/job/gwwy-uniapp 构建并等待完成
  try {
    const result = await client.build(
      "web/job/gwwy-uniapp",
      { git_branch: branch, git_head: head },
      {
        wait: true, // 等待构建完成
        pollInterval: 20000, // 每 20 秒轮询一次
        maxWaitTime: 3600000, // 最大等待 1 小时
        crumbIssuer: true, // 启用 CSRF 保护
        retryOnTimeout: 3, // 高负载下状态查询超时自动回避重试
      }
    );

    if ("buildNumber" in result) {
      console.log(`✅ 构建完成: #${result.buildNumber}`);
      console.log(`  状态: ${result.status}`);
      console.log(`  耗时: ${result.duration}ms`);
      console.log(`  构建页: ${result.url}`);

      // 从控制台日志提取产物下载链接并下载到 downloads/
      console.log(`\n=== 下载打包产物 ===`);
      const fileServerBase = "http://223.223.178.68:2004/gwwy-uniapp-file";
      const consoleText = await client.getConsoleText(
        "web/job/gwwy-uniapp",
        result.buildNumber
      );

      // 优先匹配完整下载链接；控制台若只打印了文件名，则拼出完整 URL
      let downloadUrl = consoleText.match(
        /http:\/\/223\.223\.178\.68:2004\/gwwy-uniapp-file\/[^\s"'<>]+\.zip/
      )?.[0];
      if (!downloadUrl) {
        const fileNameMatch = consoleText.match(/gwwy-uniapp_\d{14}\.zip/);
        if (fileNameMatch) {
          downloadUrl = `${fileServerBase}/${fileNameMatch[0]}`;
        }
      }

      if (downloadUrl) {
        console.log(`  下载地址: ${downloadUrl}`);
        const outputDir = path.join(process.cwd(), "downloads");
        const fileName = path.basename(downloadUrl);
        const outputPath = path.join(outputDir, fileName);

        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        console.log(`  下载到: ${outputPath}`);
        const response = await axios.get(downloadUrl, { responseType: "stream" });
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
          writer.on("finish", () => resolve());
          writer.on("error", reject);
        });

        console.log(`  ✅ 已下载: ${outputPath}`);
      } else {
        console.log("  ⚠️ 控制台日志中未找到下载链接（gwwy-uniapp_<时间戳>.zip）");
      }
    } else {
      // wait:true 理论上不会走到这里，保留兜底
      console.log(`✅ 构建已触发: Queue ID ${result.queueId}`);
      console.log(`  构建页: ${result.url}`);
    }
  } catch (error) {
    if (error instanceof BuildFailedError) {
      console.error(`❌ 构建失败: #${error.buildNumber}`);
    } else if (error instanceof TimeoutError) {
      console.error(`❌ 构建超时: ${error.message}`);
    } else {
      throw error;
    }
  }
}

main().catch(console.error);
