/**
 * gwwy-uniapp 本地打包（Git Bash 构建）—— 薄封装入口
 * 实现位于 src/workflows/gwwy-local.ts
 *
 * 用法:
 *   npm run gwwy                （默认分支）
 *   npm run gwwy -- --branch X  （指定分支）
 */
import { gwwyCommand } from '../src/workflows/gwwy-local';

gwwyCommand(process.argv.slice(2));
