/**
 * gwwy-uniapp 线上打包 —— 薄封装入口
 * 实现位于 src/workflows/gwwy-online.ts
 *
 * 用法: npm run gwwy-online -- --branch <分支名> [--head <提交>]
 */
import { gwwyOnlineCommand } from '../src/workflows/gwwy-online';

gwwyOnlineCommand(process.argv.slice(2));
