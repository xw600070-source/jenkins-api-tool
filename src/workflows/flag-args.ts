import { JenkinsError } from '../errors';

/**
 * flag 形式参数的严格解析
 *
 * 背景：npm run 不加 `--` 分隔符时，--flag 会被 npm 当作自己的配置项吞掉，
 * 只有 flag 的值作为位置参数透传给脚本。旧解析器静默忽略未知 token，
 * 会带着默认值照常触发构建（例如 --module 丢失后静默只打 pcx）。
 * 这里统一改为：参数形态不符合预期直接抛错，把问题挡在触发构建之前。
 */

/** 位置参数报错时附带：npm 吞 flag 场景的修复提示 */
const NPM_SEPARATOR_HINT =
  '提示: 通过 npm run 调用时，需在子命令前加 `--` 分隔符' +
  '（如 npm run jenkins -- patch --project x），' +
  '否则 --flag 会被 npm 吞掉，只剩值被当作位置参数传入';

/**
 * 解析 `--key value` 形式参数，返回以 flag 名（含 --）为键的取值表。
 *
 * - 未知 flag / flag 缺取值 / 位置参数 → 抛 JenkinsError（附用法）
 * - 同一 flag 重复出现时后者覆盖前者（与各工作流旧行为一致）
 */
export function parseFlagArgs(
  argv: readonly string[],
  knownFlags: readonly string[],
  usage: string
): Record<string, string> {
  const values: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (token.startsWith('--')) {
      if (!knownFlags.includes(token)) {
        const known = knownFlags.length
          ? `（可用参数: ${knownFlags.join(' ')}）`
          : '（本命令不支持任何参数）';
        throw new JenkinsError(`未知参数: ${token}${known}\n${usage}`);
      }
      if (i + 1 >= argv.length) {
        throw new JenkinsError(`${token} 缺少取值\n${usage}`);
      }
      values[token] = argv[++i];
    } else {
      throw new JenkinsError(`未识别的参数: ${token}\n${usage}\n${NPM_SEPARATOR_HINT}`);
    }
  }

  return values;
}
