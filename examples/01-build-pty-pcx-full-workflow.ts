/**
 * pty-pcx 完整打包工作流 —— 薄封装入口
 * 实现位于 src/workflows/pty-pcx.ts
 *
 * 用法: npm run pty-pcx
 */
import { ptyPcxCommand } from '../src/workflows/pty-pcx';

ptyPcxCommand(process.argv.slice(2));
