/**
 * 灵活模块打包(patch)工作流 —— 薄封装入口
 * 实现位于 src/workflows/patch.ts
 *
 * 用法:
 *   npm run patch -- --project <vOrange文件名> [--module <模块>]
 *   --project 省略时进入交互选择
 */
import { patchCommand } from '../src/workflows/patch';

patchCommand(process.argv.slice(2));
