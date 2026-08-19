/**
 * orange 整包打包 —— 薄封装入口
 * 实现位于 src/workflows/orange-full.ts
 *
 * 用法:
 *   npm run orange -- --project <vOrange文件名>
 */
import { orangeFullCommand } from '../src/workflows/orange-full';

orangeFullCommand(process.argv.slice(2));
