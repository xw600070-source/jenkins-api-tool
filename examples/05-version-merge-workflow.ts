/**
 * orange 版本清单合并 —— 薄封装入口
 * 实现位于 src/workflows/version-merge.ts
 *
 * 用法:
 *   npm run merge -- --vorange <文件名> --patch <文件名>
 *   两个参数省略时进入交互选择
 */
import { mergeCommand } from '../src/workflows/version-merge';

mergeCommand(process.argv.slice(2));
