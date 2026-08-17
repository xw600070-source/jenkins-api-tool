import * as path from 'path';

/**
 * Jenkins job 名集中管理（支持多级路径 job）
 * 各工作流脚本统一从这里取，避免散落硬编码
 */
export const JOBS = {
  /** orange 全量打包（按版本清单） */
  orangeAliyun: 'web/job/orange-aliyun',
  /** orange 按模块裁剪出补丁包 */
  orangePatch: 'web/job/orange-patch',
  /** gwwy uniapp 线上打包 */
  gwwyUniapp: 'web/job/gwwy-uniapp',
  /** pty-pcx 客户端打包 */
  ptyPcx: 'server/job/pex/job/pty-pcx',
} as const;

/**
 * 产物文件服务器根地址（内网静态目录）
 * 可用环境变量 FILE_SERVER_BASE 覆盖
 */
export const FILE_SERVER_BASE =
  process.env.FILE_SERVER_BASE || 'http://223.223.178.68:2004';

/** 工作流产物统一下载目录 */
export const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');

/** orange-aliyun 全量打包的 options 参数（patch/pcx 工作流共用） */
export const ORANGE_BUILD_OPTIONS =
  'update_code,npm_build,package,update_package,package_monthly,orange_patch';
