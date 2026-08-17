import * as fs from 'fs';
import * as readline from 'readline/promises';
import { JenkinsError } from '../errors';

/** 选择器 IO 可替换（便于单测注入输入流） */
export interface PickOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 文件列表标题，默认"可选文件:" */
  title?: string;
}

/**
 * 列出目录下的清单文件（普通文件、跳过隐藏文件），按名排序
 */
export function listProjectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * 列出目录文件让用户数字选择，返回选中的文件名
 *
 * - 回车默认第 1 项；无效序号重新提问，连续 3 次抛错
 * - 目录为空直接抛错
 */
export async function pickProjectFile(dir: string, options?: PickOptions): Promise<string> {
  const files = listProjectFiles(dir);
  if (files.length === 0) {
    throw new JenkinsError(`目录 ${dir} 下没有可选的文件`);
  }

  console.log(`\n${options?.title ?? '可选文件'}:`);
  files.forEach((file, index) => console.log(`  ${index + 1}. ${file}`));

  const rl = readline.createInterface({
    input: options?.input ?? process.stdin,
    output: options?.output ?? process.stdout,
  });

  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const answer = (await rl.question('请输入序号（回车默认 1）: ')).trim();
      if (answer === '') return files[0];

      const num = parseInt(answer, 10);
      if (Number.isInteger(num) && num >= 1 && num <= files.length) {
        return files[num - 1];
      }
      console.log(`无效序号: ${answer}，请输入 1-${files.length}`);
    }
    throw new JenkinsError('连续 3 次无效输入，已取消选择');
  } finally {
    rl.close();
  }
}
