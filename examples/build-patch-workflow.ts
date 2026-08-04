import "dotenv/config";
import { JenkinsClient, LogLevel } from "../src";
import path from "path";
import * as fs from "fs";
import axios from "axios";

/**
 * 灵活模块打包(patch)工作流
 *
 * 用法:
 *   npm run patch -- --project <vOrange文件名> [--module <模块>]
 *
 * 参数:
 *   --project  必传,project/ 目录下的 vOrange 版本清单文件名
 *   --module   可选,保留的模块(逗号分隔多个),默认 pcx
 *
 * 示例:
 *   npm run patch -- --project vOrange-gwzc-530
 *   npm run patch -- --project vOrange-gwzc-530 --module pcx,home
 */

interface PatchArgs {
  project: string;   // vOrange 文件名(必传)
  module: string;    // 保留的模块,逗号分隔多个,默认 pcx
}

/**
 * 解析命令行参数
 */
function parsePatchArgs(argv: string[]): PatchArgs {
  let project: string | undefined;
  let moduleArg = "pcx";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" && i + 1 < argv.length) {
      project = argv[++i];
    } else if (argv[i] === "--module" && i + 1 < argv.length) {
      moduleArg = argv[++i];
    }
  }

  if (!project) {
    console.error(
      "❌ 缺少必传参数 --project\n" +
        "用法: npm run patch -- --project <vOrange文件名> [--module <模块>]\n" +
        "例如: npm run patch -- --project vOrange-gwzc-530 --module pcx"
    );
    process.exit(1);
  }

  return { project, module: moduleArg };
}

async function main() {
  const { project, module: moduleArg } = parsePatchArgs(process.argv.slice(2));
  console.log(`打包任务: project=${project}, module=${moduleArg}`);

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

  // project/ 目录下的版本清单文件(--project 参数指定)
  const configFilePath = path.join(process.cwd(), "project", project);

  // 触发 orange-aliyun 全量构建(按版本清单打包所有模块)
  const result = await client.build(
    "web/job/orange-aliyun",
    {
      build_type: "vOrange",
      version_file: { type: "file", path: configFilePath },
      options:
        "update_code,npm_build,package,update_package,package_monthly,orange_patch",
    },
    {
      wait: true, // 等待构建完成
      pollInterval: 60000, // 每 60 秒轮询一次
      maxWaitTime: 3600000, // 最大等待 1 小时
      crumbIssuer: true, // 启用 CSRF 保护
    },
  );

  console.log("Build triggered with file parameters:");
  console.log(`  Queue ID: ${result.queueId}`);
  console.log(`  URL: ${result.url}`);

  // 获取控制台日志并提取生成的 zip 包名
  if ("buildNumber" in result) {
    const consoleText = await client.getConsoleText(
      "web/job/orange-aliyun",
      result.buildNumber
    );

    // 匹配 orange_YYYYMMDDHHmmss.zip 格式
    const zipMatch = consoleText.match(/orange_\d{14}\.zip/);
    if (zipMatch) {
      console.log(`  Generated package: ${zipMatch[0]}`);

      // 触发 orange-patch 构建(按 --module 裁剪保留指定模块)
      console.log(`\n=== Triggering orange-patch build (module: ${moduleArg}) ===`);
      const patchResult = await client.build(
        "web/job/orange-patch",
        {
          orange_package: zipMatch[0].replace('orange_', 'orange-patch-'),
          orange_module: moduleArg,
        },
        {
          wait: true,
          pollInterval: 10000,
          maxWaitTime: 600000,
          crumbIssuer: true,
        }
      );

      // 读取 orange-patch 控制台输出
      if ("buildNumber" in patchResult) {
        console.log(`  orange-patch build #${patchResult.buildNumber} completed`);

        const patchConsoleText = await client.getConsoleText(
          "web/job/orange-patch",
          patchResult.buildNumber
        );

        // 匹配外网下载链接
        const downloadUrlMatch = patchConsoleText.match(
          /http:\/\/223\.223\.178\.68:2004\/jenkins-orange-patch\/[^\s"'<>]+\.zip/
        );

        if (downloadUrlMatch) {
          const downloadUrl = downloadUrlMatch[0];
          console.log(`  Found download URL: ${downloadUrl}`);

          // 下载文件到 downloads 目录
          const outputDir = path.join(process.cwd(), "downloads");
          const fileName = path.basename(downloadUrl);
          const outputPath = path.join(outputDir, fileName);

          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }

          console.log(`  Downloading to: ${outputPath}`);
          const response = await axios.get(downloadUrl, {
            responseType: "stream",
          });

          const writer = fs.createWriteStream(outputPath);
          response.data.pipe(writer);

          await new Promise<void>((resolve, reject) => {
            writer.on("finish", () => resolve());
            writer.on("error", reject);
          });

          console.log(`  Downloaded: ${outputPath}`);
        } else {
          console.log("  Warning: No download URL found in orange-patch console output");
        }
      }
    } else {
      console.log("  Warning: No orange_*.zip package found in console log");
    }
  }
}

main().catch(console.error);
