import type { AppHostEvent } from '../../../sdk/app-contract';

/**
 * 顺序导入一组选中的诊断包。
 *
 * 每个文件独立处理，单个损坏包不会中断后续文件；失败信息由调用方统一呈现，避免 React
 * 状态更新覆盖前一个错误。这里不触发刷新，使界面能在整个批次结束后只刷新一次。
 */
export async function importPackageFiles(
  sourcePaths: string[],
  importPackage: (sourcePath: string) => Promise<unknown>
): Promise<{ importedCount: number; failures: string[] }> {
  const failures: string[] = [];
  let importedCount = 0;
  for (const sourcePath of sourcePaths) {
    try {
      await importPackage(sourcePath);
      importedCount += 1;
    } catch (error) {
      const fileName = sourcePath.replace(/^.*[\\/]/, '');
      failures.push(`${fileName}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { importedCount, failures };
}

interface PackageImportHost {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  resolveDroppedFiles(files: File[]): Promise<string[]>;
}

export interface PackageImportWorkflow {
  importSelectedFiles(): Promise<void>;
  importDroppedFiles(files: File[]): Promise<void>;
  handleHostEvent(event: AppHostEvent): Promise<void>;
}

/**
 * 协调文件选择、拖入导入与宿主事件刷新。
 * packages.import 会逐文件广播 packages.changed；批次内只合并这类中间事件，并在整个批次
 * 结束后统一刷新。任务、监控等其他事件始终请求刷新；请求会串行执行，刷新期间到达的新请求
 * 至少在当前刷新结束后再执行一次，避免丢失状态变化或并发读取界面数据。
 */
export function createPackageImportWorkflow({
  host,
  refresh,
  reportFailures
}: {
  host: PackageImportHost;
  refresh: () => Promise<void>;
  reportFailures: (message: string) => void;
}): PackageImportWorkflow {
  let activeBatches = 0;
  let refreshPromise: Promise<void> | undefined;
  let refreshRequested = false;

  const requestRefresh = async (): Promise<void> => {
    refreshRequested = true;
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
      try {
        while (refreshRequested) {
          refreshRequested = false;
          await refresh();
        }
      } finally {
        refreshPromise = undefined;
      }
    })();
    return refreshPromise;
  };

  const importPaths = async (sourcePaths: string[]) => {
    activeBatches += 1;
    try {
      const result = await importPackageFiles(sourcePaths, (sourcePath) => host.invoke('packages.import', { sourcePath }));
      if (result.failures.length > 0) reportFailures(result.failures.join('\n'));
    } finally {
      activeBatches -= 1;
      if (activeBatches === 0) {
        await requestRefresh();
      }
    }
  };

  return {
    async importSelectedFiles() {
      await importPaths(await host.invoke<string[]>('host.chooseFiles'));
    },
    async importDroppedFiles(files) {
      await importPaths(await host.resolveDroppedFiles(files));
    },
    async handleHostEvent(event) {
      if (activeBatches > 0 && event.event === 'packages.changed') return;
      await requestRefresh();
    }
  };
}
