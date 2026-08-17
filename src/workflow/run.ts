import { notify } from '../services/notify-service';

export interface RunWorkflowOptions {
  /** 命令名（用于通知与错误前缀），如 "patch" | "gwwy-online" */
  command: string;
  /** 工作流主函数，任何抛出的错误都会被统一兜底 */
  main: () => Promise<void>;
}

/**
 * 工作流统一入口：兜底所有未捕获错误
 * - 打印失败原因并弹失败通知（NOTIFY=0 / 非 macOS 自动跳过）
 * - 失败一律以退出码 1 结束，便于 CI / 串联脚本判断
 */
export function runWorkflow(options: RunWorkflowOptions): void {
  const { command, main } = options;

  main()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      notify({ command, success: false, error: message });
      console.error(`\n❌ ${command} 失败: ${message}`);
      process.exit(1);
    });
}
