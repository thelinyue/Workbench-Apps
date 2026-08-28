interface AnalysisBackendShutdownOptions {
  monitor: { close(): void };
  tasks: { close(): Promise<void> };
  detachListeners(): void;
  repository: { close(): void };
}

/**
 * 创建 Analysis Center backend 的单一异步关闭边界。
 *
 * 首次调用严格按“停监控 → 等任务/Worker/队列 → 解绑监听 → 关 SQLite”执行；后续调用共享
 * 同一个 Promise。每一步即使失败也会继续完成后续资源收口，最终用中文聚合错误交给宿主 Worker
 * 发送负确认，避免数据库因前一步异常而永久保持打开。
 */
export function createAnalysisBackendShutdown(options: AnalysisBackendShutdownOptions): () => Promise<void> {
  let closeOperation: Promise<void> | undefined;
  return () => {
    if (closeOperation) return closeOperation;
    closeOperation = (async () => {
      const failures: string[] = [];
      try { options.monitor.close(); } catch (error) { failures.push(`停止目录监控失败：${errorMessage(error)}`); }
      try { await options.tasks.close(); } catch (error) { failures.push(errorMessage(error)); }
      try { options.detachListeners(); } catch (error) { failures.push(`解绑 backend 监听失败：${errorMessage(error)}`); }
      try { options.repository.close(); } catch (error) { failures.push(`关闭 SQLite 失败：${errorMessage(error)}`); }
      if (failures.length > 0) throw new Error(`分析中心关闭失败：${failures.join('；')}`);
    })();
    return closeOperation;
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
