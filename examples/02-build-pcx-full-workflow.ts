/**
 * 固定打包 pcx 模块补丁包 —— 薄封装入口
 * 实现位于 src/workflows/pcx.ts
 *
 * 用法: npm run pcx
 */
import { pcxCommand } from '../src/workflows/pcx';

pcxCommand(process.argv.slice(2));
